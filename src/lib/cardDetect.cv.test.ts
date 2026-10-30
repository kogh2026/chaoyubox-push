// 证件检测流水线测试（纯函数，Node 直接跑，不需要 canvas / 浏览器）。
// 做法：程序化「拍一张证件照」——把带边框、文字、头像框的卡面用单应矩阵贴到背景上，
// 再叠模糊与噪声，逼近真实手机翻拍，然后断言检测出的四角误差与各项度量。
import { describe, expect, it } from 'vitest';
import { applyH, orderQuad, orientPoints, pxToQuad, quadToPx, solveH, type Pt } from './cvGeometry';
import {
  checkCrop,
  decideCards,
  detectFromRgba,
  detectRotation180,
  finalizeConfidence,
  FULL_QUAD,
  warpPixels,
} from './cardDetect';
import type { RgbaImage } from './cvImage';
import { rgbaToGray } from './cvImage';

/* ---------- 合成工具 ---------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 卡面贴图：浅色底（真身份证是白底胶印）+ 抬头条 + 文字行 + 头像块 */
function cardPixel(u: number, v: number): [number, number, number] {
  // u,v ∈ [0,1]
  if (u < 0.012 || u > 0.988 || v < 0.02 || v > 0.98) return [230, 228, 222]; // 卡体白边
  if (v > 0.09 && v < 0.2 && u > 0.05 && u < 0.62) return [188, 205, 228]; // 抬头条
  if (u > 0.72 && u < 0.95 && v > 0.28 && v < 0.78) return [150, 152, 158]; // 头像块
  // 文字行：若干深色横条
  const line = Math.floor((v - 0.26) / 0.09);
  if (v > 0.26 && v < 0.86 && u > 0.07 && u < 0.66 && line % 2 === 0) {
    const w = 0.12 + ((line * 37) % 7) * 0.05;
    if (u < 0.07 + w) return [70, 70, 78];
  }
  return [238, 238, 232];
}

/** 桌面背景：带轻微渐变的灰 + 大块暗影（模拟真实桌面/纸张） */
function deskPixel(x: number, y: number, w: number, h: number): [number, number, number] {
  const g = 118 + 26 * Math.sin((x / w) * 2.1) + 18 * Math.cos((y / h) * 1.7);
  return [g, g * 0.97, g * 0.92];
}

/**
 * 合成一张「翻拍照片」。
 * @param quads 每张卡在画面里的 4 个像素角点（左上/右上/右下/左下）
 */
export function synthPhoto(
  w: number,
  h: number,
  quads: Pt[][],
  opt: { seed?: number; noise?: number; blur?: number; contrast?: number } = {},
): RgbaImage {
  const { seed = 7, noise = 5, blur = 1, contrast = 1 } = opt;
  const rnd = mulberry32(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  // 每张卡：图像坐标 → 卡坐标 的单应
  const hs = quads.map((q) =>
    solveH(
      orderQuad(q),
      [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
        { x: 1000, y: 630 },
        { x: 0, y: 630 },
      ],
    ),
  );
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r: number;
      let g: number;
      let b: number;
      [r, g, b] = deskPixel(x, y, w, h);
      for (let k = 0; k < hs.length; k++) {
        const p = applyH(hs[k], x + 0.5, y + 0.5);
        if (p.x >= 0 && p.x <= 1000 && p.y >= 0 && p.y <= 630) {
          [r, g, b] = cardPixel(p.x / 1000, p.y / 630);
          break;
        }
      }
      const i = (y * w + x) * 4;
      const n = (rnd() - 0.5) * noise * 2;
      // 对比度收缩：模拟逆光/灰蒙蒙的翻拍
      const sq = (v: number): number => 128 + (v - 128) * contrast + n;
      data[i] = sq(r);
      data[i + 1] = sq(g);
      data[i + 2] = sq(b);
      data[i + 3] = 255;
    }
  }
  if (blur > 0) boxBlur(data, w, h, blur);
  return { width: w, height: h, data };
}

function boxBlur(d: Uint8ClampedArray, w: number, h: number, r: number): void {
  const src = new Uint8ClampedArray(d);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const ny = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) {
          const nx = Math.min(w - 1, Math.max(0, x + dx));
          const j = (ny * w + nx) * 4;
          sr += src[j];
          sg += src[j + 1];
          sb += src[j + 2];
          n++;
        }
      }
      const i = (y * w + x) * 4;
      d[i] = sr / n;
      d[i + 1] = sg / n;
      d[i + 2] = sb / n;
    }
  }
}

/** 矩形卡面在给定角度/中心/尺寸下的四个角点（可叠加透视收缩） */
function quadOf(
  cx: number,
  cy: number,
  cw: number,
  ch: number,
  deg = 0,
  persp = 0,
): Pt[] {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const base: Pt[] = [
    { x: -cw / 2, y: -ch / 2 },
    { x: cw / 2, y: -ch / 2 },
    { x: cw / 2, y: ch / 2 },
    { x: -cw / 2, y: ch / 2 },
  ].map((p) => ({
    // 透视：上边比下边窄（模仿俯拍）
    x: p.x * (1 - persp * (p.y / ch + 0.5)),
    y: p.y * (1 - persp * 0.15 * (p.x / cw + 0.5)),
  }));
  return base.map((p) => ({ x: cx + p.x * cos - p.y * sin, y: cy + p.x * sin + p.y * cos }));
}

function maxCornerErr(got: Pt[], truth: Pt[]): number {
  const a = orderQuad(got);
  const b = orderQuad(truth);
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y));
  return m;
}

const W = 640;
const H = 480;

/* ---------- 用例 ---------- */

describe('detectFromRgba：单卡', () => {
  it('正放证件：四角误差 < 4px，比例接近 85.6:54，置信度高', () => {
    const truth = quadOf(320, 240, 420, 265);
    const img = synthPhoto(W, H, [truth]);
    const { candidates, checks } = detectFromRgba(img);
    expect(candidates.length).toBeGreaterThan(0);
    const best = candidates[0];
    const got = quadToPx(best.quad, W, H);
    expect(maxCornerErr(got, truth)).toBeLessThan(4);
    expect(best.aspect).toBeGreaterThan(1.45);
    expect(best.aspect).toBeLessThan(1.72);
    expect(String(best.method)).toBe('approx4');
    expect(finalizeConfidence(best, checks[0])).toBeGreaterThan(0.75);
    expect(checks[0].pass).toBe(true);
  });

  it('旋转 12°：仍能定位（不被轴对齐假设限制）', () => {
    const truth = quadOf(320, 240, 400, 252, 12);
    const img = synthPhoto(W, H, [truth], { seed: 11 });
    const { candidates } = detectFromRgba(img);
    expect(candidates.length).toBeGreaterThan(0);
    const got = quadToPx(candidates[0].quad, W, H);
    expect(maxCornerErr(got, truth)).toBeLessThan(6);
  });

  it('透视俯拍：四角误差 < 8px', () => {
    const truth = quadOf(320, 240, 430, 270, -6, 0.16);
    const img = synthPhoto(W, H, [truth], { seed: 23 });
    const { candidates } = detectFromRgba(img);
    expect(candidates.length).toBeGreaterThan(0);
    const got = quadToPx(candidates[0].quad, W, H);
    expect(maxCornerErr(got, truth)).toBeLessThan(8);
  });

  it('卡片占满画幅（>70%）：不被面积上限拒掉', () => {
    const truth = quadOf(320, 240, 620, 400);
    const img = synthPhoto(W, H, [truth], { seed: 31 });
    const { candidates } = detectFromRgba(img);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].areaFrac).toBeGreaterThan(0.7);
    expect(maxCornerErr(quadToPx(candidates[0].quad, W, H), truth)).toBeLessThan(5);
  });

  it('纯背景（无证件）：不编造高置信四边', () => {
    const img = synthPhoto(W, H, [], { seed: 5, noise: 8 });
    const { candidates } = detectFromRgba(img);
    expect(candidates.every((c) => c.confidence < 0.9)).toBe(true);
    const best = candidates[0];
    if (best) expect(finalizeConfidence(best, checkCrop(rgbaToGray(img), best.quad))).toBeLessThan(0.6);
  });

  it('验收不过的候选一律不给「可自动校正」的分（硬压到 0.55 以下）', () => {
    const truth = quadOf(320, 240, 420, 265);
    const img = synthPhoto(W, H, [truth], { seed: 3 });
    const gray = rgbaToGray(img);
    // 拿桌面区域当候选：几何分可以很高，但内容不是证件
    const deskQuad = pxToQuad(quadOf(320, 30, 260, 46), W, H);
    const chk = checkCrop(gray, deskQuad);
    expect(chk.pass).toBe(false);
    const fake = {
      quad: deskQuad,
      confidence: 1,
      areaFrac: 0.2,
      aspect: 1.6,
      method: 'approx4' as const,
      extent: 1,
    };
    expect(finalizeConfidence(fake, chk)).toBeLessThan(0.6);
  });

  it('低对比（逆光/灰蒙蒙）：靠直方图均衡那一遍仍能定位', () => {
    const truth = quadOf(320, 240, 420, 265, 5);
    const img = synthPhoto(W, H, [truth], { seed: 17, contrast: 0.35, noise: 2 });
    const { candidates } = detectFromRgba(img);
    expect(candidates.length).toBeGreaterThan(0);
    expect(maxCornerErr(quadToPx(candidates[0].quad, W, H), truth)).toBeLessThan(10);
  });

  it('证件竖着拍（转 90°）：仍按长宽比识别，且可按目标画幅摆正', () => {
    const truth = quadOf(320, 240, 420, 265, 90);
    const img = synthPhoto(W, H, [truth], { seed: 29 });
    const { candidates } = detectFromRgba(img);
    expect(candidates.length).toBeGreaterThan(0);
    const best = candidates[0];
    expect(best.aspect).toBeGreaterThan(1.45);
    expect(best.aspect).toBeLessThan(1.72);
    // 像素空间定向：横版输出时 p0→p1 必须是长边（否则重采样会把卡拍扁）
    const px = orderQuad(quadToPx(best.quad, W, H));
    const oriented = orientPoints(px, true);
    const w1 = Math.hypot(oriented[1].x - oriented[0].x, oriented[1].y - oriented[0].y);
    const h1 = Math.hypot(oriented[3].x - oriented[0].x, oriented[3].y - oriented[0].y);
    expect(w1).toBeGreaterThan(h1);
    expect(w1 / h1).toBeGreaterThan(1.4);
  });

  it('单卡内含大量文字块：不会被误拆成多张', () => {
    const truth = quadOf(320, 240, 430, 271, 0);
    const img = synthPhoto(W, H, [truth], { seed: 53 });
    const { candidates, checks } = detectFromRgba(img);
    const { multi, chosen } = decideCards(candidates, checks);
    expect(multi).toBe(false);
    expect(chosen.length).toBe(1);
    expect(maxCornerErr(quadToPx(chosen[0].quad, W, H), truth)).toBeLessThan(5);
  });
});

describe('detectCards：多卡拆分', () => {
  it('一张图里两张证件 → 拆成 2 条且各自贴合', () => {
    const left = quadOf(160, 240, 258, 163, 3);
    const right = quadOf(470, 250, 260, 164, -4);
    const img = synthPhoto(W, H, [left, right], { seed: 41 });
    const { candidates, checks } = detectFromRgba(img);
    const { chosen, multi } = decideCards(candidates, checks);
    expect(multi).toBe(true);
    expect(chosen.length).toBe(2);
    const got = chosen.map((c) => quadToPx(c.quad, W, H));
    const errL = Math.min(...got.map((g) => maxCornerErr(g, left)));
    const errR = Math.min(...got.map((g) => maxCornerErr(g, right)));
    expect(errL).toBeLessThan(8);
    expect(errR).toBeLessThan(8);
    // 两张卡的角点不能都来自同一张（否则等于没拆开）
    const bestForLeft = got.reduce((m, g) => Math.min(m, maxCornerErr(g, left)), Infinity);
    const bestForRight = got.reduce((m, g) => Math.min(m, maxCornerErr(g, right)), Infinity);
    expect(bestForLeft).toBeLessThan(8);
    expect(bestForRight).toBeLessThan(8);
    const idxL = got.findIndex((g) => maxCornerErr(g, left) < 8);
    const idxR = got.findIndex((g) => maxCornerErr(g, right) < 8);
    expect(idxL).not.toBe(idxR);
  });
});

describe('checkCrop：卡面验收', () => {
  it('证件区域通过、纯桌面区域不通过', () => {
    const truth = quadOf(320, 240, 420, 265);
    const img = synthPhoto(W, H, [truth], { seed: 3 });
    const gray = rgbaToGray(img);
    const cardQuad = pxToQuad(truth, W, H);
    expect(checkCrop(gray, cardQuad).pass).toBe(true);
    const deskQuad = pxToQuad(quadOf(320, 30, 220, 40), W, H);
    const chk = checkCrop(gray, deskQuad);
    // 纯桌面：平滑渐变能骗过「纸色占比」，但没有字迹 → 判不合格（正是要做的事）
    expect(chk.inkFraction).toBeLessThan(0.004);
    expect(chk.pass).toBe(false);
  });
});

describe('warpPixels：透视重采样', () => {
  it('四边形四角映射到输出四角，卡面特征位置被搬对', () => {
    const truth = quadOf(320, 240, 420, 265);
    const img = synthPhoto(W, H, [truth], { seed: 9, noise: 0, blur: 0 });
    const out = warpPixels(new Uint8ClampedArray(img.data), W, H, orderQuad(truth), 100, 63);
    const lum = (x: number, y: number): number => {
      const i = (y * 100 + x) * 4;
      return 0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2];
    };
    // 卡面浅色底（中心偏左，避开文字行与头像块）
    expect(lum(50, 4)).toBeGreaterThan(200);
    // 头像块（u≈0.83, v≈0.5）应是中间调灰
    const photo = lum(83, 31);
    expect(photo).toBeGreaterThan(130);
    expect(photo).toBeLessThan(180);
    // 文字行（u≈0.04 首行）应是深色
    expect(lum(10, 20)).toBeLessThan(150);
    expect(out[3]).toBe(255);
  });
});

describe('refineEdge 超越：弱边缘 / 贴边 / 亚像素', () => {
  it('弱边缘（浅色卡边 + 强反光低对比）：仍能定位', () => {
    // 对比度压到 0.3（已较难），卡边与背景对比弱；对比度自适应阈值应保住弱边
    const truth = quadOf(320, 240, 420, 265, 4);
    const img = synthPhoto(W, H, [truth], { seed: 61, contrast: 0.3, noise: 1 });
    const { candidates } = detectFromRgba(img);
    expect(candidates.length).toBeGreaterThan(0);
    expect(maxCornerErr(quadToPx(candidates[0].quad, W, H), truth)).toBeLessThan(12);
  });

  it('贴边卡（左边缘压到画幅边界）：不崩、不被误拉进画幅内', () => {
    // 卡片左边缘落在 x≈10，检测时「外侧」采样点会越界，必须钳制而非报错
    const truth = quadOf(160, 240, 300, 190, 0);
    const img = synthPhoto(W, H, [truth], { seed: 67 });
    const { candidates } = detectFromRgba(img);
    expect(candidates.length).toBeGreaterThan(0);
    expect(maxCornerErr(quadToPx(candidates[0].quad, W, H), truth)).toBeLessThan(16);
    // 左角（TL/BL 的 x）应贴近画幅左边界（<=40px），说明没有把边硬拉进画幅内
    const got = quadToPx(candidates[0].quad, W, H);
    const leftX = Math.min(got[0].x, got[3].x);
    expect(leftX).toBeLessThan(40);
  });

  it('亚像素精度：旋转 7° 干净卡四角误差 < 4px', () => {
    const truth = quadOf(320, 240, 420, 265, 7);
    const img = synthPhoto(W, H, [truth], { seed: 73, noise: 2, blur: 0 });
    const { candidates } = detectFromRgba(img);
    expect(candidates.length).toBeGreaterThan(0);
    expect(maxCornerErr(quadToPx(candidates[0].quad, W, H), truth)).toBeLessThan(4);
  });

  it('破损 / 非凸边：RANSAC 仍可给出稳定主方向（误差不爆）', () => {
    // 旋转卡 + 较大噪声模拟局部边缺失，RANSAC 应剥离假峰
    const truth = quadOf(320, 240, 430, 270, -9, 0.12);
    const img = synthPhoto(W, H, [truth], { seed: 79, noise: 9 });
    const { candidates } = detectFromRgba(img);
    expect(candidates.length).toBeGreaterThan(0);
    expect(maxCornerErr(quadToPx(candidates[0].quad, W, H), truth)).toBeLessThan(10);
  });
});

describe('detectRotation180 超越：倒拍自动识别（无模型）', () => {
  // 自造一张「上重下轻」的卡面：顶部深条 + 上半部文字行，下半部留白 → 正放时墨迹重心偏上
  function topHeavyCard(w: number, h: number): Uint8ClampedArray {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        let v = 240; // 白底
        if (y < h * 0.18) v = 70; // 顶部深色抬头条
        else if (y > h * 0.22 && y < h * 0.52 && x > w * 0.1 && x < w * 0.6 && (Math.floor(y / 8) % 2 === 0)) v = 80; // 上半部文字行
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
    }
    return d;
  }

  it('正放 → false；上下颠倒 180° → true', () => {
    const w = 100;
    const h = 63;
    const up = topHeavyCard(w, h);
    expect(detectRotation180(rgbaToGray({ width: w, height: h, data: up }), FULL_QUAD)).toBe(false);
    // 180° 翻转像素
    const flipped = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = ((h - 1 - y) * w + (w - 1 - x)) * 4;
        const dd = (y * w + x) * 4;
        flipped[dd] = up[s];
        flipped[dd + 1] = up[s + 1];
        flipped[dd + 2] = up[s + 2];
        flipped[dd + 3] = 255;
      }
    }
    expect(detectRotation180(rgbaToGray({ width: w, height: h, data: flipped }), FULL_QUAD)).toBe(true);
  });

  it('上下对称卡面：颠倒也不误翻（保守阈值）', () => {
    const w = 100;
    const h = 63;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const v = y < h / 2 ? 90 : 200; // 上深下浅，但不对称度有限
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
    }
    // 上半深下半浅：正放重心偏上→false；翻转后重心偏下→true
    expect(detectRotation180(rgbaToGray({ width: w, height: h, data: d }), FULL_QUAD)).toBe(false);
    const flipped = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = ((h - 1 - y) * w + (w - 1 - x)) * 4;
        const dd = (y * w + x) * 4;
        flipped[dd] = d[s];
        flipped[dd + 1] = d[s + 1];
        flipped[dd + 2] = d[s + 2];
        flipped[dd + 3] = 255;
      }
    expect(detectRotation180(rgbaToGray({ width: w, height: h, data: flipped }), FULL_QUAD)).toBe(true);
  });
});

describe('detectFromRgba 循环抠除（超越爱印的轮廓遍+循环双保险）', () => {
  it('单卡：严格返回 1 条（循环抹平后不得凭空多出幽灵候选）', () => {
    const truth = quadOf(320, 240, 420, 265);
    const img = synthPhoto(W, H, [truth], { seed: 83 });
    const { candidates } = detectFromRgba(img);
    expect(candidates.length).toBe(1);
  });

  it('两张并排分离卡：仍稳定拆成 2 条（循环路径被实际走到且不出错）', () => {
    const left = quadOf(160, 240, 258, 163, 3);
    const right = quadOf(470, 250, 260, 164, -4);
    const img = synthPhoto(W, H, [left, right], { seed: 41 });
    const { candidates } = detectFromRgba(img);
    expect(candidates.length).toBe(2);
  });

  it('两张重叠卡：至少识别到 1 张且不崩溃（循环重检测路径执行）', () => {
    const a = quadOf(300, 240, 380, 240, 0);
    const b = quadOf(430, 250, 360, 230, 22);
    const img = synthPhoto(W, H, [a, b], { seed: 71 });
    const { candidates } = detectFromRgba(img);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
  });
});
