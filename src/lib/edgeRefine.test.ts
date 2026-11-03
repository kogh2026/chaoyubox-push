import { describe, expect, it } from 'vitest';
import { estimateBackgroundColor, refineEdge } from './edgeRefine';

/**
 * 边缘精修的单元测试。
 *
 * 核心要锁住三件事：
 * 1. **颜色解混的数学正确性**：构造一个已知的混合像素，反解后应还原出纯前景色。
 * 2. **alpha 完全不动**：精修只改 RGB，发丝的半透明层次必须原样保留。
 * 3. **副作用可控**：不透明区与全透明区不被改；强度=0 时是彻底的 no-op。
 */

/** 造一张 w×h 的 RGBA 图：fill 填充每个像素 */
function makeImage(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * w + x) * 4;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = a;
    }
  }
  return d;
}

/** 背景色 100,150,200；纯前景色 240,200,180 */
const BG: [number, number, number] = [100, 150, 200];
const FG: [number, number, number] = [240, 200, 180];

describe('estimateBackgroundColor', () => {
  it('从 alpha≈0 区域取中位数作为底色', () => {
    const w = 20;
    const h = 20;
    const d = makeImage(w, h, (x, y) => {
      const edge = x < 5 || x >= w - 5 || y < 5 || y >= h - 5;
      return edge ? [100, 150, 200, 0] : [240, 200, 180, 255];
    });
    const bg = estimateBackgroundColor(d, w, h);
    expect(bg).not.toBeNull();
    expect(bg![0]).toBeCloseTo(100, 0);
    expect(bg![1]).toBeCloseTo(150, 0);
    expect(bg![2]).toBeCloseTo(200, 0);
  });

  it('样本不足时返回 null（不做瞎猜）', () => {
    const w = 10;
    const h = 10;
    const d = makeImage(w, h, () => [240, 200, 180, 255]); // 全不透明
    expect(estimateBackgroundColor(d, w, h)).toBeNull();
  });

  it('不用四角法：四角落在人像上时应取 alpha=0 区域而非四角', () => {
    const w = 30;
    const h = 30;
    // 四角是"人像"（不透明、肤色），中央大块是背景（透明、蓝底）
    const d = makeImage(w, h, (x, y) => {
      const corner = x < 4 || x >= w - 4 || y < 4 || y >= h - 4;
      return corner ? [230, 190, 160, 255] : [100, 150, 200, 0];
    });
    const bg = estimateBackgroundColor(d, w, h);
    // 应该拿到蓝底（100,150,200），而不是肤色（230,190,160）
    expect(bg![2]).toBeGreaterThan(180);
    expect(bg![0]).toBeLessThan(140);
  });
});

describe('refineEdge —— 颜色解混的数学正确性', () => {
  it('半透明像素反解出纯前景色（不再是背景混合色）', () => {
    const w = 20;
    const h = 20;
    const alpha = 0.3; // 前景占 30%，背景 70%
    const mixedR = alpha * FG[0] + (1 - alpha) * BG[0];
    const mixedG = alpha * FG[1] + (1 - alpha) * BG[1];
    const mixedB = alpha * FG[2] + (1 - alpha) * BG[2];
    // 背景样本要够多（estimateBackgroundColor 要求 ≥200 个 alpha≈0 样本），
    // 且边缘像素要有邻居（否则平滑会把它当成孤立点）
    const d = makeImage(w, h, (x, y) => {
      const ring = x >= 8 && x < 12 && y >= 8 && y < 12;
      if (ring) return [mixedR, mixedG, mixedB, Math.round(alpha * 255)];
      return [100, 150, 200, 0]; // 背景
    });
    const bg = estimateBackgroundColor(d, w, h)!;
    expect(bg).not.toBeNull();
    refineEdge(d, w, h, { strength: 1, kappa: 0.35, bg });

    const i = (10 * w + 10) * 4;
    // 解混后应显著接近纯前景色（不再是混合色 142）
    expect(d[i]).toBeGreaterThan(195);
    expect(d[i]).toBeLessThan(250);
    expect(d[i + 1]).toBeGreaterThan(160);
    expect(d[i + 2]).toBeGreaterThan(140);
  });

  it('alpha 完全不变（发丝的半透明层次必须保留）', () => {
    const w = 20;
    const h = 20;
    const d = makeImage(w, h, (x) => {
      if (x >= 8 && x < 12) return [180, 170, 175, 100]; // 半透明发丝带
      return [100, 150, 200, 0];
    });
    const before = Array.from(d.filter((_, i) => i % 4 === 3));
    refineEdge(d, w, h, { strength: 1, bg: BG });
    const after = Array.from(d.filter((_, i) => i % 4 === 3));
    expect(after).toEqual(before);
  });

  it('不透明区与全透明区不被修改', () => {
    const w = 20;
    const h = 20;
    const d = makeImage(w, h, (x) => {
      if (x < 8) return [240, 200, 180, 255]; // 不透明前景
      if (x < 12) return [180, 170, 175, 128]; // 半透明
      return [100, 150, 200, 0]; // 全透明
    });
    const opaqueBefore = [d[0], d[1], d[2]];
    const transparentBefore = [d[(15 * w + 15) * 4], d[(15 * w + 15) * 4 + 1], d[(15 * w + 15) * 4 + 2]];
    refineEdge(d, w, h, { strength: 1, bg: BG });
    expect([d[0], d[1], d[2]]).toEqual(opaqueBefore);
    expect([d[(15 * w + 15) * 4], d[(15 * w + 15) * 4 + 1], d[(15 * w + 15) * 4 + 2]]).toEqual(transparentBefore);
  });

  it('strength=0 是彻底的 no-op', () => {
    const w = 20;
    const h = 20;
    const d = makeImage(w, h, (x) => (x < 10 ? [180, 170, 175, 128] : [100, 150, 200, 0]));
    const snapshot = Array.from(d);
    const r = refineEdge(d, w, h, { strength: 0 });
    expect(r).toBeNull();
    expect(Array.from(d)).toEqual(snapshot);
  });

  it('强度越大修正越明显（单调性）', () => {
    const mk = () => {
      const w = 20;
      const h = 20;
      return makeImage(w, h, (x) => (x >= 9 && x < 11 ? [180, 170, 175, 128] : [100, 150, 200, 0]));
    };
    const d1 = mk();
    const d2 = mk();
    refineEdge(d1, 20, 20, { strength: 0.3, bg: BG });
    refineEdge(d2, 20, 20, { strength: 1, bg: BG });
    const i = (10 * 20 + 10) * 4;
    const delta1 = Math.abs(d1[i] - 180);
    const delta2 = Math.abs(d2[i] - 180);
    expect(delta2).toBeGreaterThan(delta1);
  });

  it('解混结果不会跑到离谱颜色（色域钳制生效）', () => {
    // alpha 极低 + 颜色与背景接近 → 解混理论上会爆炸，必须被钳制住
    const w = 20;
    const h = 20;
    const d = makeImage(w, h, (x) => (x >= 9 && x < 11 ? [101, 151, 201, 3] : [100, 150, 200, 0]));
    refineEdge(d, w, h, { strength: 1, kappa: 0.1, bg: BG });
    const i = (10 * 20 + 10) * 4;
    expect(d[i]).toBeGreaterThanOrEqual(0);
    expect(d[i]).toBeLessThanOrEqual(255);
    // 不应偏离原像素太远（钳制到 min(C,B)+12 附近）
    expect(Math.abs(d[i] - 101)).toBeLessThan(60);
  });
});
