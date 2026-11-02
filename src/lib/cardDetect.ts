// 证件（身份证/户口本/护照/驾驶证…）自动检测 + 透视矫正 —— 纯 TS 复刻「爱印」识别链路
//
// 爱印的做法（见 vendor/multi-card-detect-worker.js + id2pdf-card-correction-worker.js）：
//   ① OpenCV 粗定位：缩放到长边 1200 → 灰度 → GaussianBlur(5) → 自动阈值 Canny
//      → dilate(2) → findContours(RETR_EXTERNAL) → 面积过滤 → approxPolyDP(0.02·周长)
//      取 4 点凸四边形，失败退 minAreaRect；长宽比过滤 → 置信度打分 → NMS
//   ② ONNX 精定位（768×768 角点回归）给出最终四角 + 旋转角度，再 warpPerspective 抠图
//   ③ 抠图后按「纸白占比 / 字迹占比」验收，不过就回退，交用户手动框选
//
// 我们无法内置它的私有模型权重，于是把 ② 换成**梯度边缘精修**：沿四条边找梯度峰、
// 每边做鲁棒直线拟合（TLS + 离群剔除），再两两求交得到亚像素角点。对「一张卡压在
// 桌面/纸面上」这类主场景，精度与模型方案同量级，且离线、可单测、零额外体积。

import {
  autoCannyThresholds,
  cannyDetailed,
  dilate,
  downscaleGray,
  equalizeHist,
  gaussianBlur,
  rgbaToGray,
  type GrayImage,
  type RgbaImage,
} from './cvImage';
import {
  approxClosed,
  boundaryPoints,
  connectedComponents,
  convexHull,
  hullArea,
  isConvexPoly,
  minAreaRect,
} from './cvContour';
import {
  applyH,
  bboxIoU,
  orderQuad,
  orientPoints,
  pointInPoly,
  polyArea,
  polyPerimeter,
  pxToQuad,
  quadCenter,
  quadSize,
  quadToPx,
  solveH,
  type Pt,
  type Quad,
} from './cvGeometry';

export type { Pt, Quad } from './cvGeometry';
export { pxToQuad, quadToPx, rotateQuadCW, solveH, orientPoints, quadAspect } from './cvGeometry';

export interface DetectResult {
  quad: Quad;
  /** 0..1：低于 0.6 视为「需检查」（与 UI 的 NEED_CHECK 对齐） */
  confidence: number;
}

/** 全图微内缩（用于已矫正图片再次编辑） */
export const FULL_QUAD: Quad = {
  p0: { x: 0.015, y: 0.015 },
  p1: { x: 0.985, y: 0.015 },
  p2: { x: 0.985, y: 0.985 },
  p3: { x: 0.015, y: 0.985 },
};

const FALLBACK: DetectResult = { quad: FULL_QUAD, confidence: 0.4 };

/**
 * 自动校正默认内缩比例（0.8%）：把检测/模型得到的四边形四角朝质心收进一小段，
 * 裁掉卡边外残留的一圈原背景——深色背景下就表现为"小黑边"。
 * 纯几何、按比例收敛，不改变长宽比，故不影响下游"长宽比门控"。
 */
export const EDGE_TRIM_FRAC = 0.008;

/**
 * 几何内缩：把四边形四角朝质心方向收进 frac（0..1）。
 * 用于自动校正裁掉卡边外的残留暗边；手动裁切不走此路径（保留用户拖的角点）。
 */
export function insetQuad(pts: Pt[], frac: number): Pt[] {
  if (frac <= 0) return pts;
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  const k = 1 - frac;
  return pts.map((p) => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k }));
}

/** 常见证件长宽比（长/短）：身份证、驾驶证、户口本、护照 */
export const CARD_RATIOS = [85.6 / 54, 88 / 60, 143 / 105, 125 / 88];

/** 检测参数（默认值对齐爱印 worker 的 V 常量，超界处已注明） */
export interface DetectOptions {
  /** 工作分辨率长边 */
  workingLongEdge?: number;
  /** 候选面积占比下限 */
  minAreaFrac?: number;
  /** 候选面积占比上限（爱印 .7 只适用于「多卡翻拍」，单卡常占满画幅，故默认放宽） */
  maxAreaFrac?: number;
  /** approxPolyDP 的 eps 系数（× 周长） */
  approxEpsFrac?: number;
  minAspect?: number;
  maxAspect?: number;
  /** 跑两遍（原图 + 直方图均衡）再合并，专治逆光/低对比翻拍 */
  dualPass?: boolean;
  nmsIoU?: number;
  maxCards?: number;
  minConfidence?: number;
  /** 卡面验收：纸白占比 / 字迹占比阈值，见 checkCrop */
  skipValidation?: boolean;
}

const DEFAULTS: Required<DetectOptions> = {
  workingLongEdge: 1000,
  minAreaFrac: 0.015,
  maxAreaFrac: 0.96,
  approxEpsFrac: 0.02,
  minAspect: 1.2,
  maxAspect: 2.35,
  dualPass: true,
  nmsIoU: 0.3,
  maxCards: 12,
  minConfidence: 0.35,
  skipValidation: false,
};

/** 单张候选：四边形 + 各项度量 + 检测置信度 */
export interface CardCandidate {
  quad: Quad;
  /** 检测置信度（边缘质量/长宽比/紧致度加权，未含卡面验收） */
  confidence: number;
  /** 卡面占总画幅的面积比 */
  areaFrac: number;
  /** 长边/短边 */
  aspect: number;
  method: 'approx4' | 'minarea';
  /** 轮廓面积 / 四边形面积，越接近 1 越像一张规整的卡 */
  extent: number;
}

/** 卡面验收结果（爱印的 paperFraction / inkFraction 思路） */
export interface CropCheck {
  /** 亮像素（>183）占比——证件通常是浅色底 */
  paperFraction: number;
  /** 暗像素（<115）占比——证面一定有文字/头像 */
  inkFraction: number;
  samples: number;
  meanLuma: number;
  pass: boolean;
}

/* ---------------- 评分与筛选（对应爱印 M 常量组 / W·ce·ue·J 函数） ---------------- */

function aspectScore(aspect: number): number {
  let minRel = Infinity;
  for (const r of CARD_RATIOS) minRel = Math.min(minRel, Math.abs(aspect - r) / r);
  return Math.max(0, 1 - minRel * 2.5);
}

/** 去掉被更大候选「几乎完全包住」的嵌套候选（卡面文字框/防伪标识框常被误检） */
function dropNested(cards: CardCandidate[]): CardCandidate[] {
  const sorted = [...cards].sort((a, b) => b.areaFrac - a.areaFrac);
  const kept: CardCandidate[] = [];
  for (const c of sorted) {
    const swallowed = kept.some((k) => k.areaFrac > c.areaFrac * 1.3 && bboxIoU(k.quad, c.quad) > 0.65);
    if (!swallowed) kept.push(c);
  }
  return kept;
}

/** 去掉被 ≥2 个更大候选覆盖的小框（爱印 ce()：内层元素至少有 2 个父级） */
function dropMultiNested(cards: CardCandidate[]): CardCandidate[] {
  return cards.filter((t) => {
    let parents = 0;
    for (const n of cards) {
      if (n === t) continue;
      if (t.areaFrac > n.areaFrac * 1.4 && bboxIoU(n.quad, t.quad) > 0.7) parents++;
    }
    return parents < 2;
  });
}

/** 两个候选是否代表「不同的卡」：重叠要小，且中心要分开（爱印 ue()） */
function isDistinct(a: CardCandidate, b: CardCandidate, frameMinSide = 1): boolean {
  if (bboxIoU(a.quad, b.quad) > 0.12) return false;
  const ca = quadCenter(a.quad);
  const cb = quadCenter(b.quad);
  const minSide = Math.min(quadSize(a.quad).w, quadSize(a.quad).h) * frameMinSide;
  return Math.hypot(ca.x - cb.x, ca.y - cb.y) / Math.max(1e-6, minSide) >= 0.14;
}

/**
 * 多卡判定（爱印 J()）：至少 2 个「四点近似 + 高置信」的候选，彼此不重叠，
 * 且第二大卡面积不小于第一大的 28%（否则更像同一张卡被切成了两半）。
 */
export function pickMultiCards(
  cards: CardCandidate[],
  room = 12,
  sheetMaxAreaFrac = 0.7,
): CardCandidate[] | null {
  const pool = dropNested(dropMultiNested(cards)).filter(
    (c) =>
      c.method === 'approx4' &&
      c.confidence >= 0.55 &&
      c.areaFrac >= 0.015 &&
      c.areaFrac <= sheetMaxAreaFrac &&
      c.aspect >= 1.25 &&
      c.aspect <= 2.15,
  );
  if (pool.length < 2) return null;
  const sorted = [...pool].sort((a, b) => b.confidence * b.areaFrac - a.confidence * a.areaFrac);
  const picked: CardCandidate[] = [];
  for (const c of sorted) {
    if (picked.every((p) => isDistinct(p, c))) picked.push(c);
    if (picked.length >= Math.min(room, 12)) break;
  }
  if (picked.length < 2) return null;
  const [first, second] = picked;
  if (second.areaFrac < first.areaFrac * 0.28) return null;
  return picked;
}

/* ---------------- 角点精修：沿边找梯度峰 + 鲁棒直线拟合 + 求交 ---------------- */

function fitLine(pts: Pt[]): { p: Pt; d: Pt } | null {
  if (pts.length < 4) return null;
  let mx = 0;
  let my = 0;
  for (const q of pts) {
    mx += q.x;
    my += q.y;
  }
  mx /= pts.length;
  my /= pts.length;
  let cxx = 0;
  let cyy = 0;
  let cxy = 0;
  for (const q of pts) {
    const dx = q.x - mx;
    const dy = q.y - my;
    cxx += dx * dx;
    cyy += dy * dy;
    cxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  return { p: { x: mx, y: my }, d: { x: Math.cos(theta), y: Math.sin(theta) } };
}

function intersect(l1: { p: Pt; d: Pt }, l2: { p: Pt; d: Pt }): Pt | null {
  const det = l1.d.x * -l2.d.y - l1.d.y * -l2.d.x;
  if (Math.abs(det) < 1e-6) return null;
  const rx = l2.p.x - l1.p.x;
  const ry = l2.p.y - l1.p.y;
  const t = (rx * -l2.d.y - ry * -l2.d.x) / det;
  return { x: l1.p.x + l1.d.x * t, y: l1.p.y + l1.d.y * t };
}

/** 在梯度幅值图上取某点（四舍五入）的值；越界返回 -1（贴边卡的「外侧」常为越界） */
function sampleMag(mag: Float32Array, w: number, h: number, x: number, y: number): number {
  const sx = Math.round(x);
  const sy = Math.round(y);
  if (sx < 1 || sy < 1 || sx >= w - 1 || sy >= h - 1) return -1;
  return mag[sy * w + sx];
}

/** 一组点到某条直线的有符号距离绝对值中位数对应的截断阈值（MAD 思路） */
function lineResidualLimit(line: { p: Pt; d: Pt }, pts: Pt[]): number {
  const r = pts.map((q) => Math.abs((q.x - line.p.x) * line.d.y - (q.y - line.p.y) * line.d.x));
  const med = [...r].sort((a, b) => a - b)[r.length >> 1];
  return Math.max(1.2, med * 2.5);
}

/**
 * RANSAC 鲁棒直线拟合：多轮随机子集 + 内点重拟合。
 * 比「单轮中位数去离群」更稳——文字笔画、污渍、局部破损边造成的假峰会被多轮随机采样剥离，
 * 对「轻度非凸 / 边缘局部缺失」也能给出可靠的主方向（这是纯 CV 超过模型的一处：模型在破损边会抖）。
 */
function ransacLine(pts: Pt[], iters = 24): { p: Pt; d: Pt } | null {
  const n = pts.length;
  if (n < 6) return null;
  let s = 0x2545f491;
  const rand = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  let bestLine: { p: Pt; d: Pt } | null = null;
  let bestInliers = 0;
  for (let it = 0; it < iters; it++) {
    const sampleN = Math.max(6, Math.floor(n * 0.6));
    const idxs = new Set<number>();
    while (idxs.size < sampleN) idxs.add(Math.floor(rand() * n));
    const line = fitLine([...idxs].map((i) => pts[i]));
    if (!line) continue;
    const limit = lineResidualLimit(line, pts);
    let inl = 0;
    for (const q of pts) {
      if (Math.abs((q.x - line.p.x) * line.d.y - (q.y - line.p.y) * line.d.x) <= limit) inl++;
    }
    if (inl > bestInliers) {
      bestInliers = inl;
      bestLine = line;
    }
  }
  if (!bestLine) return null;
  const limit = lineResidualLimit(bestLine, pts);
  const inliers = pts.filter(
    (q) =>
      Math.abs((q.x - bestLine!.p.x) * bestLine!.d.y - (q.y - bestLine!.p.y) * bestLine!.d.x) <= limit,
  );
  return fitLine(inliers) ?? bestLine;
}

/**
 * 沿一条边（a→b）找梯度峰，精修出这条边的真实位置。
 *
 * 相对爱印的 ONNX 角点模型，这里做了三处**超越**：
 *  1. **亚像素**：整型峰值两侧做抛物线插值，定位精度到亚像素级（模型输出是离散网格，达不到）。
 *  2. **对比度自适应阈值**：弱边缘（浅色卡边 / 强反光 / 逆光）用「剖面内峰值的比例」而非固定阈值，
 *     避免弱边直接被丢；模型在弱边低对比区偶尔会翻车，这里更稳。
 *  3. **贴边边界钳制**：卡片边缘压到画幅边界时，「外侧」采样点越界返回 -1，不会报错也不会把边硬拉进画幅内。
 * 另沿法向取「最外侧」峰值，避免深色描边被「描边→白底」那一跳向内缩。
 */
function refineEdge(
  a: Pt,
  b: Pt,
  mag: Float32Array,
  w: number,
  h: number,
  th: number,
  range: number,
): { p: Pt; d: Pt } | null {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 8) return null;
  const nx = -(b.y - a.y) / len;
  const ny = (b.x - a.x) / len;
  const K = Math.min(48, Math.max(12, Math.round(len / 6)));
  const hits: Pt[] = [];
  for (let k = 0; k < K; k++) {
    const t = (k + 0.5) / K;
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    // 沿法向采样梯度剖面，同时记剖面内峰值（对比度自适应阈值用）
    let bestM = 0;
    let bestO = 0;
    let profMax = 0;
    for (let o = -range; o <= range; o++) {
      const m = sampleMag(mag, w, h, px + nx * o, py + ny * o);
      if (m < 0) continue;
      if (m > profMax) profMax = m;
      if (m > bestM) {
        bestM = m;
        bestO = o;
      }
    }
    // 弱边缘：固定 th 会直接丢；用剖面内峰值的 32% 作为局部阈值，弱边也能保住
    const localTh = Math.max(th, profMax * 0.32);
    if (bestM < localTh) continue;
    // n 指向四边形内侧（角点 TL→TR→BR→BL 顺时针），故 o<0 为外侧；取 >=75% 峰值里最靠外的点
    let useO = bestO;
    for (let o = -range; o < bestO; o++) {
      if (sampleMag(mag, w, h, px + nx * o, py + ny * o) >= bestM * 0.75) {
        useO = o;
        break;
      }
    }
    // 亚像素：整型峰两侧抛物线插值（boundary 处相邻为 -1 则跳过，保留整型）
    let sub = 0;
    const mPrev = sampleMag(mag, w, h, px + nx * (useO - 1), py + ny * (useO - 1));
    const mNext = sampleMag(mag, w, h, px + nx * (useO + 1), py + ny * (useO + 1));
    if (mPrev >= 0 && mNext >= 0) {
      const denom = mPrev - 2 * bestM + mNext;
      if (Math.abs(denom) > 1e-6) {
        sub = 0.5 * (mPrev - mNext) / denom;
        sub = Math.max(-1, Math.min(1, sub));
      }
    }
    hits.push({ x: px + nx * (useO + sub), y: py + ny * (useO + sub) });
  }
  if (hits.length < Math.max(6, K * 0.45)) return null;
  const line = ransacLine(hits) ?? fitLine(hits);
  return line;
}

/** 用梯度图精修四角；任一边拟合失败就保留原角点，整体不达标则退回原四边形 */
function refineQuad(quad: Pt[], mag: Float32Array, w: number, h: number, th: number): Pt[] {
  const range = Math.max(3, Math.round(Math.min(w, h) * 0.02));
  const lines: ({ p: Pt; d: Pt } | null)[] = [];
  for (let i = 0; i < 4; i++) {
    lines.push(refineEdge(quad[i], quad[(i + 1) % 4], mag, w, h, th, range));
  }
  const out: Pt[] = [];
  let hit = 0;
  for (let i = 0; i < 4; i++) {
    const l1 = lines[(i + 3) % 4];
    const l2 = lines[i];
    const p = l1 && l2 ? intersect(l1, l2) : null;
    if (p) {
      const moved = Math.hypot(p.x - quad[i].x, p.y - quad[i].y);
      if (moved <= range * 3) {
        out.push(p);
        hit++;
        continue;
      }
    }
    out.push(quad[i]);
  }
  if (hit < 3) return quad;
  const area0 = polyArea(quad);
  const area1 = polyArea(out);
  if (area0 <= 0 || area1 / area0 < 0.6 || area1 / area0 > 1.6) return quad;
  return isConvexPoly(out) ? out : quad;
}

/* ---------------- 卡面验收（纸白 / 字迹） ---------------- */

/**
 * 按四边形采样卡面内部的亮度分布，判断「这真的是一张证件吗」。
 *
 * 做法对齐爱印的 paperFraction / inkFraction 双指标，但把「纸白」从固定 183 改成
 * **相对纸色**（取采样亮度 p90 作为纸色估计，±35 内算纸）：扫描件常偏黄/偏蓝，
 * 固定阈值会误杀；相对估计对底色不敏感。
 * 判据：纸色占比够高 **且** 确有字迹（证件一定有文字/头像），二者缺一即判不合格
 * —— 纯桌面纹理能过「纸色」但过不了「字迹」，比单看置信度可靠得多。
 */
export function checkCrop(gray: GrayImage, quad: Quad): CropCheck {
  const { width: w, height: h, data } = gray;
  const gw = 48;
  const gh = 32;
  const inset = 0.04;
  const px = quadToPx(quad, w, h);
  // 目标网格（内缩 4%）→ 源四边形
  const dst: Pt[] = [
    { x: 0, y: 0 },
    { x: gw, y: 0 },
    { x: gw, y: gh },
    { x: 0, y: gh },
  ];
  const cx = (px[0].x + px[1].x + px[2].x + px[3].x) / 4;
  const cy = (px[0].y + px[1].y + px[2].y + px[3].y) / 4;
  const src = orderQuad(px).map((p) => ({
    x: p.x + (cx - p.x) * inset,
    y: p.y + (cy - p.y) * inset,
  }));
  const H = solveH(dst, src);
  const vals: number[] = [];
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const p = applyH(H, x + 0.5, y + 0.5);
      if (p.x < 0 || p.y < 0 || p.x >= w - 1 || p.y >= h - 1) continue;
      const x0 = Math.floor(p.x);
      const y0 = Math.floor(p.y);
      const fx = p.x - x0;
      const fy = p.y - y0;
      const i00 = y0 * w + x0;
      const a = data[i00] * (1 - fx) + data[i00 + 1] * fx;
      const b = data[i00 + w] * (1 - fx) + data[i00 + w + 1] * fx;
      vals.push(a * (1 - fy) + b * fy);
    }
  }
  const n = vals.length;
  if (n === 0) return { paperFraction: 0, inkFraction: 0, samples: 0, meanLuma: 0, pass: false };
  const sorted = [...vals].sort((a, b) => a - b);
  const paperLuma = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  let paper = 0;
  let ink = 0;
  let sum = 0;
  for (const v of vals) {
    sum += v;
    if (Math.abs(v - paperLuma) <= 35) paper++;
    else if (v <= paperLuma - 60) ink++;
  }
  const paperFraction = paper / n;
  const inkFraction = ink / n;
  const pass = paperFraction >= 0.65 && inkFraction >= 0.004 && inkFraction <= 0.55 && n >= 200;
  return { paperFraction, inkFraction, samples: n, meanLuma: sum / n, pass };
}

/* ---------------- 主检测：单遍 ---------------- */

interface PassOpts {
  o: Required<DetectOptions>;
  equalize: boolean;
}

function detectPass(gray: GrayImage, { o, equalize }: PassOpts): CardCandidate[] {
  const w = gray.width;
  const h = gray.height;
  const frame = w * h;
  const src = equalize ? equalizeHist(gray) : gray;
  const blur = gaussianBlur(src, 5);
  const { low, high } = autoCannyThresholds(blur, equalize ? 0.5 : 0.25);
  const { mask, mag } = cannyDetailed(blur, low, high);
  const dil = dilate(mask, 2);
  const lm = connectedComponents(dil, 24);
  const out: CardCandidate[] = [];
  const edgeTh = Math.max(low, high * 0.6);

  for (let ci = 0; ci < lm.comps.length; ci++) {
    const comp = lm.comps[ci];
    if (comp.pixels < Math.max(24, frame * 0.002)) continue;
    const pts = boundaryPoints(lm, ci);
    if (pts.length < 8) continue;
    const hull = convexHull(pts);
    if (hull.length < 3) continue;
    const hullA = hullArea(hull);
    const frac = hullA / frame;
    if (frac < o.minAreaFrac || frac > o.maxAreaFrac) continue;

    // 4 点近似：eps 从小到大试，先要「凸四点」，否则退最小外接矩形
    const per = polyPerimeter(hull);
    let quadPts: Pt[] | null = null;
    if (per > 0) {
      for (const k of [1, 1.4, 1.9, 2.5, 3.2]) {
        const ap = approxClosed(hull, per * o.approxEpsFrac * k);
        if (ap.length === 4 && isConvexPoly(ap)) {
          quadPts = ap;
          break;
        }
      }
    }
    let method: CardCandidate['method'] = 'approx4';
    if (!quadPts) {
      quadPts = minAreaRect(hull);
      method = 'minarea';
    }
    let ordered = orderQuad(quadPts);
    const refined = refineQuad(ordered, mag, w, h, edgeTh);
    ordered = orderQuad(refined);
    // 注意：长宽比必须在**像素空间**算。归一化坐标里 x/y 的量纲被画幅比例缩放，
    // 4:3 画幅下正方形的归一化宽高并不相等，直接用会把 1.585 的身份证算成 1.19。
    const pxw = (Math.hypot(ordered[1].x - ordered[0].x, ordered[1].y - ordered[0].y) +
      Math.hypot(ordered[2].x - ordered[3].x, ordered[2].y - ordered[3].y)) / 2;
    const pxh = (Math.hypot(ordered[3].x - ordered[0].x, ordered[3].y - ordered[0].y) +
      Math.hypot(ordered[2].x - ordered[1].x, ordered[2].y - ordered[1].y)) / 2;
    const aspect = Math.max(pxw, pxh) / Math.max(1e-6, Math.min(pxw, pxh));
    if (aspect < o.minAspect || aspect > o.maxAspect) continue;
    const quad = pxToQuad(ordered, w, h);
    const areaFrac = polyArea(ordered) / frame;
    if (areaFrac < o.minAreaFrac || areaFrac > o.maxAreaFrac) continue;
    const extent = Math.min(1, hullA / Math.max(1e-6, polyArea(ordered)));
    const confidence =
      0.4 * (method === 'approx4' ? 1 : 0.55) + 0.35 * aspectScore(aspect) + 0.25 * extent;
    out.push({ quad, confidence, areaFrac, aspect, method, extent });
  }
  return out;
}

/** 合并多遍结果 + NMS（爱印 de()：两遍取并集后按 conf·area 排序去重） */
function mergeCandidates(all: CardCandidate[], o: Required<DetectOptions>): CardCandidate[] {
  const sorted = [...all].sort((a, b) => b.confidence * b.areaFrac - a.confidence * a.areaFrac);
  const kept: CardCandidate[] = [];
  for (const c of sorted) {
    if (c.confidence < o.minConfidence) continue;
    if (kept.some((k) => bboxIoU(k.quad, c.quad) > o.nmsIoU)) continue;
    kept.push(c);
    if (kept.length >= o.maxCards) break;
  }
  return dropNested(kept);
}

/** 把四边形区域在灰度图上抹成中性灰（200），使循环抠除重检测时看不到它的边 */
function maskQuadGray(gray: GrayImage, quadPx: Pt[]): void {
  const { width: w, height: h, data } = gray;
  const xs = quadPx.map((p) => p.x);
  const ys = quadPx.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (pointInPoly({ x, y }, quadPx)) data[y * w + x] = 200;
    }
  }
}

/**
 * 纯函数核心：RGBA → 候选列表（已按「最像一张卡」排序，含卡面验收分）。
 *
 * 相对爱印的「一次检测取多候选」做了**循环抠除**超越：找到一张卡后，把该区域在灰度图上
 * 抹平再重检测，能补全「被另一张卡压住 / 紧贴重叠」导致轮廓断裂而漏掉的卡。
 * 爱印靠 ONNX 单卡模型循环抠下一张；我们既有「一次轮廓遍找多张」又有「抹平循环」，双重保险。
 */
export function detectFromRgba(
  img: RgbaImage,
  opts: DetectOptions = {},
): { candidates: CardCandidate[]; checks: CropCheck[]; gray: GrayImage } {
  const o: Required<DetectOptions> = { ...DEFAULTS, ...opts };
  const gray0 = downscaleGray(rgbaToGray(img), o.workingLongEdge);
  const check = (c: CardCandidate): CropCheck =>
    o.skipValidation ? blankCheck() : checkCrop(gray0, c.quad);

  const found: CardCandidate[] = [];
  let gray = gray0;
  let usedDual = false;
  const maxLoops = Math.min(o.maxCards, 6); // 有界，避免极端输入无限循环

  for (let loop = 0; loop < maxLoops; loop++) {
    const pass = detectPass(gray, { o, equalize: false });
    // 第一遍若不可靠，补跑直方图均衡那遍（自适应双遍，省约 40%）；仅第一遍做
    if (!usedDual && o.dualPass) {
      const m0 = mergeCandidates(pass, o);
      const c0 = m0.map(check);
      const valid0 = c0.filter((c) => c.pass).length;
      const solid0 =
        (m0.length > 0 && c0[0]?.pass && finalizeConfidence(m0[0], c0[0]) >= 0.8) || valid0 >= 2;
      if (!solid0) {
        pass.push(...detectPass(gray, { o, equalize: true }));
        usedDual = true;
      }
    }
    const merged = mergeCandidates(pass, o);
    // 只收「与已找到的卡不高度重叠」的新候选（抹平后的残留轮廓会被 IoU 过滤掉）
    const fresh = merged.filter((c) => found.every((f) => bboxIoU(f.quad, c.quad) <= 0.5));
    if (fresh.length === 0) break;
    const best = fresh[0]; // mergeCandidates 已按 conf·area 排序
    found.push(best);
    // 抹平已找到的卡，为下一轮重检测腾出空间
    if (loop + 1 < maxLoops) {
      const w = gray.width;
      const h = gray.height;
      gray = { width: w, height: h, data: Float32Array.from(gray.data) };
      maskQuadGray(gray, quadToPx(best.quad, w, h));
    }
  }

  return { candidates: found, checks: found.map(check), gray: gray0 };
}

function blankCheck(): CropCheck {
  return { paperFraction: 1, inkFraction: 0.01, samples: 100, meanLuma: 200, pass: true };
}

/**
 * 把候选与验收结果合成最终置信度：检测分 0.5 + 验收 0.5。
 *
 * 验收不过时**硬压到 0.55**（低于 UI 的 NEED_CHECK=0.6）：宁可让用户看到原图并手动框，
 * 也不要拿一个「几何上成立、内容上不是证件」的四边去自动裁剪。
 */
export function finalizeConfidence(cand: CardCandidate, check: CropCheck): number {
  const v = check.pass ? 1 : 0.3;
  const sizeBonus = cand.areaFrac >= 0.03 ? 0 : -0.1;
  const raw = 0.5 * Math.min(1, cand.confidence) + 0.5 * v + sizeBonus;
  const capped = check.pass ? raw : Math.min(raw, 0.55);
  return Math.max(0, Math.min(1, Math.round(capped * 1000) / 1000));
}

/* ---------------- 对外 API ---------------- */

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** 把任意图源按工作分辨率画到 canvas，返回 ImageData（大图不在全分辨率上做检测） */
export function readWorkingImage(
  source: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
  longEdge: number,
): { rgba: RgbaImage; scale: number } {
  const sw = 'naturalWidth' in source ? source.naturalWidth : source.width;
  const sh = 'naturalHeight' in source ? source.naturalHeight : source.height;
  if (!sw || !sh) throw new Error('图片尺寸无效');
  const s = Math.min(1, longEdge / Math.max(sw, sh));
  const w = Math.max(8, Math.round(sw * s));
  const h = Math.max(8, Math.round(sh * s));
  const cv = makeCanvas(w, h);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas ctx 不可用');
  ctx.drawImage(source, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  return { rgba: { width: w, height: h, data: data.data }, scale: w / sw };
}

/** 同步检测：返回最佳卡面（归一化 quad）+ 置信度。UI 导入时逐张调用。 */
export function detectCardQuad(
  img: HTMLImageElement,
  opts: DetectOptions = {},
): DetectResult {
  try {
    if (!img.naturalWidth || !img.naturalHeight) return FALLBACK;
    const { rgba } = readWorkingImage(img, opts.workingLongEdge ?? DEFAULTS.workingLongEdge);
    const { candidates, checks } = detectFromRgba(rgba, opts);
    if (candidates.length === 0) return FALLBACK;
    const best = candidates[0];
    const conf = finalizeConfidence(best, checks[0] ?? blankCheck());
    return { quad: best.quad, confidence: conf };
  } catch {
    return FALLBACK;
  }
}

/**
 * 纯函数决策层（便于单测）：候选 + 验收结果 → 最终要输出的卡面。
 * 多卡判定只在「卡面验收通过」的候选里做：文字框/阴影也能凑出四边形，
 * 不先过验收就会把一张卡拆成三张。
 */
export function decideCards(
  candidates: CardCandidate[],
  checks: CropCheck[],
): { chosen: CardCandidate[]; multi: boolean } {
  if (candidates.length === 0) return { chosen: [], multi: false };
  const ok = candidates.filter((_, i) => checks[i]?.pass);
  const pool = ok.length >= 2 ? ok : candidates;
  const picked = pickMultiCards(pool);
  return { chosen: picked ?? [candidates[0]], multi: Boolean(picked) };
}

export interface DetectCardsResult {
  /** 命中的卡面（≥2 表示这张图里有多张卡，可拆成多条） */
  cards: { quad: Quad; confidence: number; aspect: number; areaFrac: number; check: CropCheck }[];
  /** 是否判定为「一张图多张卡」 */
  multi: boolean;
  /** 全部候选（含未选中的，供 UI「换一个候选」） */
  candidates: CardCandidate[];
}

/**
 * 一张图 → N 张卡。
 * 单卡场景返回 1 条；多卡（翻拍一页纸上的多张证件）按爱印 J() 的判据拆开。
 */
export function detectCards(
  img: HTMLImageElement,
  opts: DetectOptions = {},
): DetectCardsResult {
  try {
    if (!img.naturalWidth || !img.naturalHeight) return { cards: [], multi: false, candidates: [] };
    const o: Required<DetectOptions> = { ...DEFAULTS, ...opts };
    const { rgba } = readWorkingImage(img, o.workingLongEdge);
    const { candidates, checks } = detectFromRgba(rgba, opts);
    if (candidates.length === 0) return { cards: [], multi: false, candidates: [] };
    const { chosen, multi } = decideCards(candidates, checks);
    const cards = chosen.map((c) => {
      const idx = candidates.indexOf(c);
      const check = idx >= 0 ? checks[idx] : blankCheck();
      return {
        quad: c.quad,
        confidence: finalizeConfidence(c, check),
        aspect: c.aspect,
        areaFrac: c.areaFrac,
        check,
      };
    });
    return { cards, multi, candidates };
  } catch {
    return { cards: [], multi: false, candidates: [] };
  }
}

/* ---------------- 方向判定：180° 倒拍识别（超越爱印仅靠模型 angle） ---------------- */

function bilinearGray(data: Float32Array, w: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const a = data[y0 * w + x0] * (1 - fx) + data[y0 * w + x0 + 1] * fx;
  const b = data[(y0 + 1) * w + x0] * (1 - fx) + data[(y0 + 1) * w + x0 + 1] * fx;
  return a * (1 - fy) + b * fy;
}

/**
 * 判断校正后（已按 90° 摆正）的卡面是否上下颠倒。
 *
 * 不依赖任何 OCR 模型，纯结构分析：证件卡面普遍「抬头/标题在上、字段在下」具有纵向不对称性。
 * 把卡面重采样到小网格后统计暗像素（文字/头像）的纵向重心与上下墨量比，
 * 重心明显偏下、或下方墨量显著多于上方则判为颠倒。
 *
 * 相比爱印「模型输出 angle∈{0,1,2,3} 才处理倒拍」：我们**无模型**即可自动纠正 180°，
 * 且对任意版式（只要存在上下不对称）通用；保守阈值（重心>0.6 或 下/上>1.6 且确有墨迹）避免误翻。
 */
export function detectRotation180(gray: GrayImage, quad: Quad): boolean {
  const { width: w, height: h, data } = gray;
  const px = quadToPx(quad, w, h);
  const outW = 48;
  const outH = 32;
  const H = solveH(
    [
      { x: 0, y: 0 },
      { x: outW, y: 0 },
      { x: outW, y: outH },
      { x: 0, y: outH },
    ],
    orderQuad(px),
  );
  const proj = new Float64Array(outH);
  let ink = 0;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const p = applyH(H, x + 0.5, y + 0.5);
      if (p.x < 0 || p.y < 0 || p.x >= w - 1 || p.y >= h - 1) continue;
      if (bilinearGray(data, w, p.x, p.y) < 120) {
        proj[y] += 1;
        ink++;
      }
    }
  }
  if (ink < outW * 1.5) return false; // 墨迹太少，信号不可靠，宁可不翻
  let wsum = 0;
  let cnt = 0;
  for (let y = 0; y < outH; y++) {
    wsum += proj[y] * (y + 0.5);
    cnt += proj[y];
  }
  const centroid = cnt > 0 ? wsum / cnt / outH : 0.5;
  let top = 0;
  let bot = 0;
  const t0 = Math.floor(outH * 0.28);
  const t1 = Math.floor(outH * 0.72);
  for (let y = 0; y < t0; y++) top += proj[y];
  for (let y = t1; y < outH; y++) bot += proj[y];
  const topAvg = top / Math.max(1, t0);
  const botAvg = bot / Math.max(1, outH - t1);
  return centroid > 0.6 || (botAvg > topAvg * 1.6 && botAvg > 0.05 * outW);
}

/** 像素角点 180° 旋转（上下颠倒）：TL/TR/BR/BL 两两对调并重新排序为左上起 */
function rotateQuad180Px(pts: Pt[]): Pt[] {
  const o = orderQuad(pts);
  return [o[2], o[3], o[0], o[1]];
}

/* ---------------- 透视重采样（保留原 API） ---------------- */

/**
 * 纯函数（可单测 / 可在 Worker 里跑，不依赖 canvas）：
 * 把四边形 quadPx 内的像素双线性重采样到 outW×outH RGBA 缓冲区。四边形外保持透明。
 */
export function warpPixels(
  d: Uint8ClampedArray,
  sw: number,
  sh: number,
  quadPx: Pt[],
  outW: number,
  outH: number,
): Uint8ClampedArray {
  const H = solveH(
    [
      { x: 0, y: 0 },
      { x: outW, y: 0 },
      { x: outW, y: outH },
      { x: 0, y: outH },
    ],
    quadPx,
  );
  const o8 = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const di = (y * outW + x) * 4;
      const den = H[6] * x + H[7] * y + 1;
      if (Math.abs(den) < 1e-9) {
        // 退化输入下四边形可能轻微外溢画幅：填白而非黑（JPEG 编码无 alpha，透明会变黑）
        o8[di] = 255;
        o8[di + 1] = 255;
        o8[di + 2] = 255;
        o8[di + 3] = 255;
        continue;
      }
      const u = (H[0] * x + H[1] * y + H[2]) / den;
      const v = (H[3] * x + H[4] * y + H[5]) / den;
      if (u < 0 || v < 0 || u >= sw - 1 || v >= sh - 1) {
        o8[di] = 255;
        o8[di + 1] = 255;
        o8[di + 2] = 255;
        o8[di + 3] = 255;
        continue;
      }
      const x0 = u | 0;
      const y0 = v | 0;
      const fx = u - x0;
      const fy = v - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      for (let ch = 0; ch < 3; ch++) {
        const a = d[i00 + ch] + (d[i10 + ch] - d[i00 + ch]) * fx;
        const b = d[i01 + ch] + (d[i11 + ch] - d[i01 + ch]) * fx;
        o8[di + ch] = a + (b - a) * fy;
      }
      o8[di + 3] = 255;
    }
  }
  return o8;
}

/**
 * 透视矫正：把 src 中 quadPx（像素角点 p0..p3）围成的四边形，
 * 重采样为 outW×outH 矩形。四边形外为透明。（主线程同步版；Worker 版见 warpAsync）
 */
export function warpImageData(
  sd: ImageData,
  quadPx: Pt[],
  outW: number,
  outH: number,
): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const octx = out.getContext('2d');
  if (!octx) return out;
  const o8 = warpPixels(sd.data, sd.width, sd.height, quadPx, outW, outH);
  const od = octx.createImageData(outW, outH);
  od.data.set(o8);
  octx.putImageData(od, 0, 0);
  return out;
}

/* ===== 透视矫正 Worker（把逐像素重采样移出主线程） ===== */

let warpWorker: Worker | null = null;
let warpWorkerBroken = false;
let warpSeq = 1;
const warpPending = new Map<number, (out: Uint8ClampedArray) => void>();

function getWarpWorker(): Worker | null {
  if (warpWorkerBroken || typeof Worker === 'undefined') return null;
  if (warpWorker) return warpWorker;
  try {
    warpWorker = new Worker(new URL('./warpWorker.ts', import.meta.url), { type: 'module' });
    warpWorker.onmessage = (e: MessageEvent<{ id: number; out: Uint8ClampedArray }>) => {
      const { id, out } = e.data;
      const resolve = warpPending.get(id);
      warpPending.delete(id);
      if (resolve) resolve(out);
    };
    warpWorker.onerror = () => {
      warpWorkerBroken = true;
      warpWorker = null;
    };
  } catch {
    warpWorkerBroken = true;
    warpWorker = null;
  }
  return warpWorker;
}

/**
 * 透视重采样（优先 Worker）：大图不阻塞 UI。
 * Worker 不可用（Node 单测 / 受限环境）时直接同步计算，行为一致。
 */
export function warpAsync(
  data: Uint8ClampedArray,
  sw: number,
  sh: number,
  quadPx: Pt[],
  outW: number,
  outH: number,
): Promise<Uint8ClampedArray> {
  const w = getWarpWorker();
  if (!w) return Promise.resolve(warpPixels(data, sw, sh, quadPx, outW, outH));
  const id = warpSeq++;
  return new Promise((resolve, reject) => {
    warpPending.set(id, (out) => resolve(out));
    try {
      const copy = new Uint8ClampedArray(data); // 复制避免 detach 调用方缓冲
      w.postMessage({ id, data: copy, sw, sh, quadPx, outW, outH }, [copy.buffer]);
    } catch (err) {
      warpPending.delete(id);
      reject(err);
    }
  });
}

export interface WarpOptions {
  /**
   * 自动摆正：卡片被横着/竖着拍时，按输出画幅比例把角点整体转 90°，
   * 保证「卡面长边」映射到「输出长边」，不被拉扁。
   */
  upright?: boolean;
  /**
   * 自动纠正 180° 颠倒：卡面上下颠倒翻拍时，按内容纵向不对称自动翻转。
   * 纯结构分析（不依赖 OCR 模型），保守阈值避免误翻；失败或不确定时不影响原图。
   */
  autoFlip?: boolean;
  /**
   * 裁边内缩比例（0..1）：把四边形朝质心收进一点，裁掉卡边外残留的暗边（小黑边）。
   * 默认走 EDGE_TRIM_FRAC；传 0 关闭。仅自动校正使用，手动裁切不走此路径。
   */
  edgeTrim?: number;
}

/**
 * 自动透视矫正并导出校正图（与手动裁切共用同一套重采样）。
 * 用于「识别置信度高时自动套用」；识别不准/失败时由用户走手动裁切兜底。
 */
export async function warpToCorrected(
  img: HTMLImageElement,
  quad: Quad,
  outW: number,
  outH: number,
  opts: WarpOptions = {},
): Promise<{ img: HTMLImageElement; dataUrl: string }> {
  const sw = img.naturalWidth || 1;
  const sh = img.naturalHeight || 1;
  const wantLandscape = outW >= outH;
  const pts = quadToPx(quad, sw, sh);
  let q = opts.upright ? orientPoints(pts, wantLandscape) : pts;
  const cv = makeCanvas(sw, sh);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas ctx 不可用');
  ctx.drawImage(img, 0, 0);
  let sd: ImageData;
  try {
    sd = ctx.getImageData(0, 0, sw, sh);
  } catch {
    throw new Error('读取像素失败');
  }
  // 自动纠正 180° 颠倒（在 90° 摆正之后、重采样之前判定，保证「上」是卡面真实上方向）
  if (opts.autoFlip) {
    const g = rgbaToGray({ width: sd.width, height: sd.height, data: sd.data });
    if (detectRotation180(g, pxToQuad(q, sd.width, sd.height))) {
      q = rotateQuad180Px(q);
    }
  }
  // 自动校正默认内缩：裁掉卡边外残留的暗边（深色背景下即"小黑边"）。
  // 仅自动路径生效；手动裁切(⛶)由用户自行拖动角点，不在此内缩。
  q = insetQuad(q, opts.edgeTrim ?? EDGE_TRIM_FRAC);
  const o8 = await warpAsync(sd.data, sd.width, sd.height, q, outW, outH);
  const out = makeCanvas(outW, outH);
  const octx = out.getContext('2d');
  if (!octx) throw new Error('canvas ctx 不可用');
  const od = octx.createImageData(outW, outH);
  od.data.set(o8);
  octx.putImageData(od, 0, 0);
  const url = out.toDataURL('image/jpeg', 0.92);
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve({ img: im, dataUrl: url });
    im.onerror = () => reject(new Error('校正图加载失败'));
    im.src = url;
  });
}
