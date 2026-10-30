// 爱印「卡证矫正」②层 1:1 复刻（纯逻辑，无 DOM / 无模型依赖，便于单测）。
// 源码依据：aiyin_decrypted_assets/vendor/id2pdf-card-correction-worker.js（已完整还原）。
// 管线：整图 → 768² 归一化 → ONNX 输出 (scores/quads/angle/ftype) → 解码（192 网格）→
//       包含去重 + 逐张接受（首遍 0.3 / 涂白循环 0.03）→ 单应 warp + 90° 摆正 →
//       第一张卡贴边检测（room<0.3 停止循环）→ 已找到卡面涂白后再检测下一张。
// 常量与阈值全部照抄爱印，勿"优化"：T=768 输入、网格 192、I=.3、st=.1、it=.25、L=.03、ct=.5。

import type { Pt } from './cvGeometry';

/** RGBA 位图（与 ImageData 兼容的最小结构） */
export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** 模型输出（按张量名取出的裸数据） */
export interface ModelOutput {
  scores: ArrayLike<number>;
  quads: ArrayLike<number>; // 每候选 8 个数（192 网格坐标，4 角 xy）
  angle: ArrayLike<number>; // 每候选 0..3（90° 环节数）
  ftype: ArrayLike<number>; // 卡面类型
}

/** 推理执行器：输入 CHW [3,768,768]，输出按张量名的裸数组。测试可注入桩。 */
export type ModelRunner = (input: Float32Array) => Promise<ModelOutput>;

export interface FrameParams {
  centerX: number;
  centerY: number;
  scale: number;
}

export interface ModelCandidate {
  angle: number;
  /** 192 网格坐标（8 个数） */
  coordinates: number[];
  ftype: number;
  score: number;
}

export interface DecodedQuad {
  angle: number;
  /** 原图像素坐标 4 角 */
  corners: Pt[];
  ftype: number;
  score: number;
  /** 按 angle 环移后的「摆正」角点 */
  uprightCorners: Pt[];
  /** (4-angle)%4 */
  uprightTurns: number;
}

export interface ModelPage {
  angle: number;
  corners: Pt[];
  uprightCorners: Pt[];
  uprightTurns: number;
  score: number;
  /** warp + 摆正后的卡面位图 */
  imageData: RgbaImage;
}

export interface CorrectLoopOptions {
  maxPages?: number;
  minAreaFrac?: number;
}

export interface CorrectLoopResult {
  pages: ModelPage[];
  /** 检测轮数（含涂白循环） */
  passes: number;
  /** 第一张卡的贴边余量比（<0.3 表示卡几乎顶到图像边缘） */
  room: number | null;
}

// ---------- 常量（照抄爱印） ----------

export const MODEL_INPUT = 768; // T
export const GRID = MODEL_INPUT / 4; // k=192：模型输出网格
const TH_FIRST = 0.3; // I：首遍置信阈值
const TH_KNOWN = 0.1; // st：已找到卡时的宽松阈值
const TH_LOOP = 0.03; // L：涂白循环遍阈值
const OVERLAP_FRAC = 0.25; // it：与已接受卡面重叠≥25% 视为重复
const AREA_RATIO = 0.5; // ct：宽松遍面积需≥已接受首卡的一半
const MEAN = [0.408, 0.447, 0.47]; // S：BGR 均值
const STD = [0.289, 0.274, 0.278]; // _：BGR 标准差
const ROOM_MIN = 0.3; // $：首卡贴边余量下限（低于则不再循环）
const DEFAULT_MAX_PAGES = 2; // 爱印 oF=2
const DEFAULT_MIN_AREA_FRAC = 0.04; // 爱印 aF=.04

// ---------- 几何：单应（F） ----------

/**
 * 由 4 角求投影映射：返回函数把单位方块 (w,g)∈[0,1]² 映射到源图像素坐标。
 * corners[0..3] 对应输出方块的四角顺序（与 warpQuadToRect 的采样约定一致）。
 */
export function homographyFromCorners(t: Pt[]): (w: number, g: number) => Pt {
  const [n, e, o, a] = t;
  const s = e.x - o.x;
  const i = e.y - o.y;
  const r = a.x - o.x;
  const l = a.y - o.y;
  const u = n.x - e.x + o.x - a.x;
  const c = n.y - e.y + o.y - a.y;
  const h = s * l - r * i;
  const f = Math.abs(h) > 1e-9 ? (u * l - r * c) / h : 0;
  const d = Math.abs(h) > 1e-9 ? (s * c - u * i) / h : 0;
  const m = e.x - n.x + f * e.x;
  const x = a.x - n.x + d * a.x;
  const M = n.x;
  const b = e.y - n.y + f * e.y;
  const y = a.y - n.y + d * a.y;
  const P = n.y;
  return (w: number, g: number) => {
    const C = f * w + d * g + 1;
    const p = Math.abs(C) > 1e-9 ? C : 1e-9;
    return { x: (m * w + x * g + M) / p, y: (b * w + y * g + P) / p };
  };
}

/** 有向多边形面积（鞋带公式） */
export function polyAreaSigned(t: Pt[]): number {
  let n = 0;
  for (let e = 0; e < t.length; e += 1) {
    const o = t[e];
    const a = t[(e + 1) % t.length];
    n += o.x * a.y - a.x * o.y;
  }
  return n / 2;
}

export function polyArea(t: Pt[]): number {
  return Math.abs(polyAreaSigned(t));
}

/** 任意多边形与凸四边形 t 的交集面积（Sutherland–Hodgman 逐边裁剪） */
export function clipPolyByQuadArea(t: Pt[], n: Pt[]): number {
  const sign = polyAreaSigned(n) >= 0 ? 1 : -1;
  let o: Pt[] = [...t];
  for (let a = 0; a < 4 && o.length > 0; a += 1) {
    const s = n[a];
    const i = n[(a + 1) % 4];
    const r = (u: Pt) => sign * ((i.x - s.x) * (u.y - s.y) - (i.y - s.y) * (u.x - s.x));
    const l = o;
    o = [];
    for (let u = 0; u < l.length; u += 1) {
      const c = l[u];
      const h = l[(u + l.length - 1) % l.length];
      const f = r(c);
      const d = r(h);
      if (f >= 0) {
        if (d < 0) o.push(lineIntersect(h, c, s, i));
        o.push(c);
      } else if (d >= 0) {
        o.push(lineIntersect(h, c, s, i));
      }
    }
  }
  return o.length < 3 ? 0 : Math.abs(polyAreaSigned(o));
}

function lineIntersect(t: Pt, n: Pt, e: Pt, o: Pt): Pt {
  const a = n.x - t.x;
  const s = n.y - t.y;
  const i = o.x - e.x;
  const r = o.y - e.y;
  const l = a * r - s * i;
  if (Math.abs(l) < 1e-9) return t;
  const u = ((e.x - t.x) * r - (e.y - t.y) * i) / l;
  return { x: t.x + a * u, y: t.y + s * u };
}

// ---------- 预处理（V）：整图 → [1,3,768,768] CHW，双线性，BGR，越界填黑 ----------

export function frameParams(w: number, h: number): FrameParams {
  return { centerX: w / 2, centerY: h / 2, scale: Math.max(w, h) };
}

export function preprocessModelInput(t: RgbaImage, n: FrameParams = frameParams(t.width, t.height)): Float32Array {
  const { data: e, height: o, width: a } = t;
  const s = MODEL_INPUT;
  const i = s * s;
  const r = new Float32Array(i * 3);
  const l = s / n.scale;
  const u = s / 2;
  for (let c = 0; c < s; c += 1) {
    const h = (c - u) / l + n.centerY;
    const f = Math.floor(h);
    const d = h - f;
    for (let m = 0; m < s; m += 1) {
      const x = (m - u) / l + n.centerX;
      const M = Math.floor(x);
      const b = c * s + m;
      if (M < 0 || f < 0 || M >= a - 1 || f >= o - 1) {
        r[b] = -MEAN[0] / STD[0];
        r[i + b] = -MEAN[1] / STD[1];
        r[i * 2 + b] = -MEAN[2] / STD[2];
        continue;
      }
      const y = x - M;
      const P = (f * a + M) * 4;
      const w = P + 4;
      const g = P + a * 4;
      const C = g + 4;
      for (let p = 0; p < 3; p += 1) {
        const A = 2 - p; // ImageData RGBA → 张量 BGR
        const D = e[P + A] * (1 - y) + e[w + A] * y;
        const et = e[g + A] * (1 - y) + e[C + A] * y;
        const nt = (D * (1 - d) + et * d) / 255;
        r[i * p + b] = (nt - MEAN[p]) / STD[p];
      }
    }
  }
  return r;
}

// ---------- 解码（W/ut/lt/ht） ----------

/** 点是否在凸四边形内（4 边叉积同号） */
function pointInQuad(t: number[], n: number, e: number): boolean {
  let o = 0;
  let a = 0;
  for (let s = 0; s < 4; s += 1) {
    const i = t[s * 2];
    const r = t[s * 2 + 1];
    const l = t[(s * 2 + 2) % 8];
    const u = t[(s * 2 + 3) % 8];
    const c = (l - i) * (e - r) - (u - r) * (n - i);
    if (c > 0) o += 1;
    if (c < 0) a += 1;
  }
  return o === 4 || a === 4;
}

/** 包含去重：中心落在另一个更高分候选内 → 丢弃（候选按分数降序进入） */
function dedupContained(t: ModelCandidate[], n = TH_FIRST): ModelCandidate[] {
  if (t.length < 2) return t;
  const e: ModelCandidate[] = [];
  for (let o = 0; o < t.length && !(t[o].score < n); o += 1) {
    const a = t[o].coordinates;
    const s = (a[0] + a[2] + a[4] + a[6]) / 4;
    const i = (a[1] + a[3] + a[5] + a[7]) / 4;
    let r = false;
    for (let l = 0; l < t.length && !(o === l || t[l].score < n); l += 1) {
      if (pointInQuad(t[l].coordinates, s, i) && t[o].score < t[l].score) {
        r = true;
        break;
      }
    }
    if (!r) e.push(t[o]);
  }
  return e;
}

/** 角点数组按 90° 环移 */
function rotateCorners(t: Pt[], n: number): Pt[] {
  const e = ((n % 4) + 4) % 4;
  return [t[e], t[(e + 1) % 4], t[(e + 2) % 4], t[(e + 3) % 4]];
}

/** 模型输出 → 像素坐标候选（含去重与阈值过滤） */
export function decodeModelOutput(t: ModelOutput, n: FrameParams, e = TH_FIRST): DecodedQuad[] {
  const o = t.scores.length;
  const a: ModelCandidate[] = [];
  const quads = t.quads as ArrayLike<number>;
  for (let r = 0; r < o; r += 1) {
    const coordinates: number[] = [];
    for (let k = 0; k < 8; k += 1) coordinates.push(quads[r * 8 + k]);
    a.push({
      angle: t.angle[r],
      coordinates,
      ftype: t.ftype[r],
      score: t.scores[r],
    });
  }
  const s = GRID / n.scale;
  const i = GRID / 2;
  return dedupContained(a, e)
    .filter((r) => r.score > e)
    .map((r) => {
      const l = [0, 1, 2, 3].map((c) => ({
        x: (r.coordinates[c * 2] - i) / s + n.centerX,
        y: (r.coordinates[c * 2 + 1] - i) / s + n.centerY,
      }));
      const u = ((r.angle % 4) + 4) % 4;
      return {
        angle: u,
        corners: l,
        ftype: r.ftype,
        score: r.score,
        uprightCorners: rotateCorners(l, u),
        uprightTurns: (4 - u) % 4,
      };
    });
}

// ---------- 逐张接受（j）：面积下限 + 与已接受卡重叠判定 + 分层阈值 ----------

export function acceptNextCandidate(
  t: DecodedQuad[],
  n: Pt[][], // 已接受卡面的像素角点（每张一组）
  e: { frameArea: number; minAreaFrac: number },
): DecodedQuad | undefined {
  const o = n.length ? polyArea(n[0]) : 0;
  return t.find((a) => {
    const s = polyArea(a.corners);
    if (s / Math.max(1, e.frameArea) < e.minAreaFrac) return false;
    if (n.some((r) => clipPolyByQuadArea(a.corners, r) / s >= OVERLAP_FRAC)) return false;
    if (n.length) return a.score > TH_KNOWN ? true : a.score > TH_LOOP && s >= AREA_RATIO * o;
    return a.score > TH_FIRST;
  });
}

// ---------- 贴边余量（z）：首卡四边向外还能延伸多少（相对对面角点距离） ----------

function clamp(t: number, n: number, e: number): number {
  return Math.min(e, Math.max(n, t));
}

function distToBound(t: number, n: number, e: number): number {
  return n > 1e-9 ? (e - t) / n : n < -1e-9 ? -t / n : Number.POSITIVE_INFINITY;
}

function crossDist(t: Pt, n: Pt, e: Pt, o: number): number {
  return Math.abs((e.x - n.x) * (t.y - n.y) - (e.y - n.y) * (t.x - n.x)) / o;
}

export function edgeRoomRatio(t: Pt[], n: { width: number; height: number }): number {
  const e = (t[0].x + t[1].x + t[2].x + t[3].x) / 4;
  const o = (t[0].y + t[1].y + t[2].y + t[3].y) / 4;
  let a = 0;
  for (let s = 0; s < 4; s += 1) {
    const i = t[s];
    const r = t[(s + 1) % 4];
    const l = Math.hypot(r.x - i.x, r.y - i.y);
    if (l < 1) continue;
    let u = (r.y - i.y) / l;
    let c = -(r.x - i.x) / l;
    const h = (i.x + r.x) / 2;
    const f = (i.y + r.y) / 2;
    if (u * (h - e) + c * (f - o) < 0) {
      u = -u;
      c = -c;
    }
    const d = (crossDist(t[(s + 2) % 4], i, r, l) + crossDist(t[(s + 3) % 4], i, r, l)) / 2;
    if (!(d < 1)) {
      for (const m of [0, 0.5, 1]) {
        const x = clamp(i.x + m * (r.x - i.x), 0, n.width);
        const M = clamp(i.y + m * (r.y - i.y), 0, n.height);
        const b = Math.min(distToBound(x, u, n.width), distToBound(M, c, n.height));
        a = Math.max(a, b / d);
      }
    }
  }
  return a;
}

// ---------- warp（J/F/mt/G）+ 90° 旋转（K）+ 涂白（Z） ----------

function midDist(t: Pt, n: Pt, e: Pt, o: Pt): number {
  return Math.hypot((t.x + n.x) / 2 - (e.x + o.x) / 2, (t.y + n.y) / 2 - (e.y + o.y) / 2);
}

/** 输出矩形尺寸：对边中点距（爱印 mt） */
export function quadSizePx(n: Pt[]): { width: number; height: number } {
  const [n0, e, o, a] = n;
  return {
    height: Math.trunc(midDist(n0, e, o, a)),
    width: Math.trunc(midDist(n0, a, e, o)),
  };
}

/** 按四角把源图重采样成矩形（双线性，越界填透明黑） */
export function warpQuadToRect(t: RgbaImage, n: Pt[]): RgbaImage {
  const { height: e, width: o } = quadSizePx(n);
  if (o < 1 || e < 1) throw new Error('Card crop collapsed to an empty rectangle.');
  const a = homographyFromCorners(n);
  const s = new Uint8ClampedArray(o * e * 4);
  const i = t.width;
  const r = t.height;
  for (let l = 0; l < e; l += 1) {
    const u = l / e;
    for (let c = 0; c < o; c += 1) {
      const h = a(c / o, u);
      const f = (l * o + c) * 4;
      s[f + 3] = 255;
      if (h.x < 0 || h.y < 0 || h.x > i - 1 || h.y > r - 1) continue;
      const d = Math.floor(h.x);
      const m = Math.floor(h.y);
      const x = Math.min(i - 1, d + 1);
      const M = Math.min(r - 1, m + 1);
      const b = h.x - d;
      const y = h.y - m;
      const P = (m * i + d) * 4;
      const w = (m * i + x) * 4;
      const g = (M * i + d) * 4;
      const C = (M * i + x) * 4;
      for (let p = 0; p < 3; p += 1) {
        const A = t.data[P + p] * (1 - b) + t.data[w + p] * b;
        const D = t.data[g + p] * (1 - b) + t.data[C + p] * b;
        s[f + p] = A * (1 - y) + D * y;
      }
    }
  }
  return { data: s, height: e, width: o };
}

/** 90° 旋转：n=1 逆时针 / 2=180° / 3 顺时针（照抄爱印 K，与模型 angle 语义配套） */
export function rotateImageQuarter(t: RgbaImage, n: number): RgbaImage {
  if (n === 0) return t;
  const { data: e, height: o, width: a } = t;
  const s = n !== 2;
  const i = s ? o : a; // 新宽
  const r = s ? a : o; // 新高
  const l = new Uint8ClampedArray(i * r * 4);
  for (let u = 0; u < r; u += 1) {
    for (let c = 0; c < i; c += 1) {
      const h = n === 1 ? a - 1 - u : n === 2 ? a - 1 - c : u;
      const d = ((n === 1 ? c : n === 2 ? o - 1 - u : o - 1 - c) * a + h) * 4;
      const m = (u * i + c) * 4;
      l[m] = e[d];
      l[m + 1] = e[d + 1];
      l[m + 2] = e[d + 2];
      l[m + 3] = e[d + 3];
    }
  }
  return { data: l, height: r, width: i };
}

/** 把四边形区域涂成纯白（扫描线填充，供下一轮检测排除已找到的卡） */
export function whitenQuadFill(t: RgbaImage, n: Pt[]): void {
  const { data: e, height: o, width: a } = t;
  const s = Math.max(0, Math.floor(Math.min(...n.map((r) => r.y))));
  const i = Math.min(o - 1, Math.ceil(Math.max(...n.map((r) => r.y))));
  for (let r = s; r <= i; r += 1) {
    const l = r + 0.5;
    const u: number[] = [];
    for (let c = 0; c < 4; c += 1) {
      const h = n[c];
      const f = n[(c + 1) % 4];
      if (h.y === f.y) continue;
      const d = Math.min(h.y, f.y);
      const m = Math.max(h.y, f.y);
      if (l < d || l >= m) continue;
      const x = (l - h.y) / (f.y - h.y);
      u.push(h.x + x * (f.x - h.x));
    }
    if (u.length < 2) continue;
    u.sort((c, h) => c - h);
    for (let c = 0; c + 1 < u.length; c += 2) {
      const h = Math.max(0, Math.round(u[c]));
      const f = Math.min(a - 1, Math.round(u[c + 1]));
      for (let d = h; d <= f; d += 1) {
        const m = (r * a + d) * 4;
        e[m] = 255;
        e[m + 1] = 255;
        e[m + 2] = 255;
        e[m + 3] = 255;
      }
    }
  }
}

// ---------- 主循环（yt）：1:1 复刻爱印检测+涂白循环 ----------

export async function modelCorrectLoop(
  source: RgbaImage,
  run: ModelRunner,
  opts: CorrectLoopOptions = {},
): Promise<CorrectLoopResult> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const minAreaFrac = opts.minAreaFrac ?? DEFAULT_MIN_AREA_FRAC;
  // 工作副本（会被涂白），warp 始终用原始图
  const working: RgbaImage = {
    data: new Uint8ClampedArray(source.data),
    height: source.height,
    width: source.width,
  };
  const frame = frameParams(source.width, source.height);
  const frameArea = Math.max(1, source.width * source.height);
  const pages: ModelPage[] = [];
  const accepted: Pt[][] = [];
  let passes = 0;
  let room: number | null = null;
  for (let x = 0; x < maxPages; x += 1) {
    const input = preprocessModelInput(working, frame);
    passes += 1;
    const out = await run(input);
    const th = x === 0 ? TH_FIRST : TH_LOOP;
    const decoded = decodeModelOutput(out, frame, th);
    const next = acceptNextCandidate(decoded, accepted, { frameArea, minAreaFrac });
    if (!next) break;
    const warped = warpQuadToRect(source, next.corners);
    const image = rotateImageQuarter(warped, next.angle);
    pages.push({
      angle: next.angle,
      corners: next.corners,
      uprightCorners: next.uprightCorners,
      uprightTurns: next.uprightTurns,
      score: next.score,
      imageData: image,
    });
    accepted.push(next.corners);
    if (pages.length === 1) {
      room = edgeRoomRatio(next.corners, { width: source.width, height: source.height });
      if (room < ROOM_MIN) break;
    }
    whitenQuadFill(working, next.corners);
  }
  return { pages, passes, room };
}
