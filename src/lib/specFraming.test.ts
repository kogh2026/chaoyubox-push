import { describe, it, expect } from 'vitest';
import {
  classifyDeviation,
  coverScale,
  specAutoPlacement,
  computeMetrics,
  verifyFraming,
  formatRatioReadout,
  BOTTOM_FILL_NOMINAL,
  BOTTOM_FILL_HARD_MAX,
  HEAD_RATIO_TOL,
  TOP_RATIO_TOL,
  type FramingSpec,
} from './specFraming';
import type { HeadGeometry } from './faceFrame';

// 一寸 @300DPI：25×35mm → 295×413px（爱印 topRatio 0.08 / headRatio 0.64）
const ONE_INCH: FramingSpec = {
  mmW: 25,
  mmH: 35,
  pxW: 295,
  pxH: 413,
  topRatio: 0.08,
  headRatio: 0.64,
  safeRatio: 0.035,
};

const head = (top: number, height: number, cx = 0.5): HeadGeometry => ({ cx, top, height });

describe('classifyDeviation（爱印 Ti）', () => {
  it('落在容差内为 match', () => {
    expect(classifyDeviation(0.64, 0.64, HEAD_RATIO_TOL)).toBe('match');
    expect(classifyDeviation(0.64 + HEAD_RATIO_TOL - 1e-6, 0.64, HEAD_RATIO_TOL)).toBe('match');
  });
  it('超出上界为 high，超出下界为 low', () => {
    expect(classifyDeviation(0.64 + HEAD_RATIO_TOL + 1e-4, 0.64, HEAD_RATIO_TOL)).toBe('high');
    expect(classifyDeviation(0.64 - HEAD_RATIO_TOL - 1e-4, 0.64, HEAD_RATIO_TOL)).toBe('low');
  });
});

describe('coverScale', () => {
  it('取宽高方向较大者以铺满不变形', () => {
    // 295×413 目标，1000×1500 源：宽向 0.295 > 高向 0.275 → 0.295
    expect(coverScale(1000, 1500, 295, 413)).toBeCloseTo(0.295, 6);
  });
});

describe('specAutoPlacement 默认构图（一寸）', () => {
  it('头部占比≈0.64、头顶留白≈0.08，且位于容差内', () => {
    const r = specAutoPlacement(head(0.1, 0.3), 1000, 1500, ONE_INCH, 'default');
    const m = computeMetrics(head(0.1, 0.3), 1000, 1500, r.placement, ONE_INCH);
    expect(m.headRatio).toBeCloseTo(0.64, 2);
    expect(m.topRatio).toBeCloseTo(0.08, 2);
    const v = verifyFraming(m, ONE_INCH);
    expect(v.headRatioDeviation).toBe('match');
    expect(v.topRatioDeviation).toBe('match');
    expect(v.warnings).toHaveLength(0);
  });

  it('放大填满：人物下方不足时放大，头高超过规格被标「偏大」，但不超过 20% 上限', () => {
    // 横构图（cover 受高约束）+ 头部占图 80% + 发顶靠上 → 图底填不满，触发放大填满
    const h = head(0.15, 0.8);
    const r = specAutoPlacement(h, 2000, 1000, ONE_INCH, 'default');
    expect(r.bottomAnchorScale).toBeGreaterThan(1);
    expect(r.bottomAnchorScale).toBeLessThanOrEqual(BOTTOM_FILL_NOMINAL + 1e-6);
    const m = computeMetrics(h, 2000, 1000, r.placement, ONE_INCH);
    // 发顶仍严格落在 topRatio（0.08）
    expect(m.topRatio).toBeCloseTo(0.08, 2);
    // 头部占比被放大超出 0.64，触发「头高偏大」
    expect(m.headRatio).toBeGreaterThan(0.64 + HEAD_RATIO_TOL);
    const v = verifyFraming(m, ONE_INCH);
    expect(v.headRatioDeviation).toBe('high');
    expect(v.warnings).toContain('头高偏大');
  });

  it('放大填满不会越过 20% 名义上限（即便图底极短）', () => {
    // 把图底做得极短，让 scaleForBottom 远超 1.2×，应被钳到 1.2
    const h = head(0.4, 0.5);
    const r = specAutoPlacement(h, 4000, 500, ONE_INCH, 'default');
    expect(r.bottomAnchorScale).toBeLessThanOrEqual(BOTTOM_FILL_NOMINAL + 1e-6);
  });
});

describe('specAutoPlacement 自定义构图（放大填满由滑杆控制）', () => {
  it('fillScale 直接决定 bottomAnchorScale，并受硬上限 1.35 约束', () => {
    const r = specAutoPlacement(head(0.1, 0.3), 1000, 1500, ONE_INCH, 'custom', 1.3);
    expect(r.bottomAnchorScale).toBeCloseTo(1.3, 4);
    const capped = specAutoPlacement(head(0.1, 0.3), 1000, 1500, ONE_INCH, 'custom', 2);
    expect(capped.bottomAnchorScale).toBeCloseTo(BOTTOM_FILL_HARD_MAX, 4);
  });
});

describe('specAutoPlacement 按规格要求（spec，不放大填满）', () => {
  it('bottomAnchorScale 恒为 1', () => {
    const r = specAutoPlacement(head(0.15, 0.8), 2000, 1000, ONE_INCH, 'spec');
    expect(r.bottomAnchorScale).toBe(1);
  });
});

describe('逐项核查告警', () => {
  it('留白偏多/偏少', () => {
    const mHigh = { ...computeMetrics(head(0.1, 0.3), 1000, 1500, { dx: 0, dy: 0, zoom: 1 }, ONE_INCH), topRatio: 0.12 };
    const vHigh = verifyFraming(mHigh, ONE_INCH);
    expect(vHigh.topRatioDeviation).toBe('high');
    expect(vHigh.warnings).toContain('留白偏多');

    const mLow = { ...computeMetrics(head(0.1, 0.3), 1000, 1500, { dx: 0, dy: 0, zoom: 1 }, ONE_INCH), topRatio: 0.03 };
    const vLow = verifyFraming(mLow, ONE_INCH);
    expect(vLow.topRatioDeviation).toBe('low');
    expect(vLow.warnings).toContain('留白偏少');
  });

  it('头顶出框 / 头顶为估算', () => {
    const m = computeMetrics(head(0.1, 0.3), 1000, 1500, { dx: 0, dy: 0, zoom: 1 }, ONE_INCH);
    const v = verifyFraming({ ...m, topMarginPx: -5, headTopOutside: true }, ONE_INCH, true);
    expect(v.headTopOutside).toBe(true);
    expect(v.headTopEstimated).toBe(true);
    expect(v.warnings).toContain('头顶出框');
    expect(v.warnings).toContain('头顶为估算');
  });
});

describe('formatRatioReadout（爱印同款读数）', () => {
  it('输出 X%（Y mm）', () => {
    // 头高 0.64，物理高 35mm → 22.4mm
    expect(formatRatioReadout(0.64, 35)).toBe('64.0%（22.4 mm）');
    // 留白 0.08 → 2.8mm
    expect(formatRatioReadout(0.08, 35)).toBe('8.0%（2.8 mm）');
  });
});

describe('容差常量与爱印对齐', () => {
  it('HEAD_RATIO_TOL=0.02, TOP_RATIO_TOL=0.015', () => {
    expect(HEAD_RATIO_TOL).toBe(0.02);
    expect(TOP_RATIO_TOL).toBe(0.015);
  });
});

// ---------- 功能1：用真实下半身分割判断「下方不足」（替代整图底部近似） ----------
describe('specAutoPlacement：真实人物底部决定是否放大填满', () => {
  // 1000×1500 原图，发顶在 20%（y=300px），头高 20%（300px）
  const H = head(0.2, 0.2);
  const IMG_W = 1000;
  const IMG_H = 1500;

  it('人物抵达图底（下半身充足）→ 不触发放大填满', () => {
    const r = specAutoPlacement(H, IMG_W, IMG_H, ONE_INCH, 'default', 1, 1.0);
    expect(r.bottomInsufficient).toBe(false);
    expect(r.bottomAnchorScale).toBe(1);
    expect(r.personBelowFrac).toBeCloseTo(0.8, 5); // 1.0 − 0.2
  });

  it('人物在画面中部就结束（下方有大片空白）→ 触发放大填满', () => {
    // 但整图近似看不到这点：人物 40% 处就结束了
    const withSeg = specAutoPlacement(H, IMG_W, IMG_H, ONE_INCH, 'default', 1, 0.4);
    const withoutSeg = specAutoPlacement(H, IMG_W, IMG_H, ONE_INCH, 'default', 1);
    expect(withSeg.bottomInsufficient).toBe(true);
    expect(withSeg.bottomAnchorScale).toBeGreaterThan(1);
    // 旧近似认为「下方到图底都有人」，因此不放大 —— 正是本次要修正的误判
    expect(withoutSeg.bottomInsufficient).toBe(false);
    expect(withoutSeg.bottomAnchorScale).toBe(1);
    expect(withSeg.personBelowFrac).toBeCloseTo(0.2, 5); // 0.4 − 0.2，真实下半身长度
  });

  it('默认构图的放大倍数封顶 1.20（最多 20%）', () => {
    const r = specAutoPlacement(H, IMG_W, IMG_H, ONE_INCH, 'default', 1, 0.22); // 极短的下半身
    expect(r.bottomInsufficient).toBe(true);
    expect(r.bottomAnchorScale).toBeLessThanOrEqual(BOTTOM_FILL_NOMINAL + 1e-9);
    expect(r.bottomAnchorScale).toBeCloseTo(BOTTOM_FILL_NOMINAL, 4);
  });

  it('自定义构图由滑杆控制，仍受硬上限 1.35 约束', () => {
    const r = specAutoPlacement(H, IMG_W, IMG_H, ONE_INCH, 'custom', 1.5, 0.4);
    expect(r.bottomAnchorScale).toBeCloseTo(BOTTOM_FILL_HARD_MAX, 5);
  });

  it('按规格/保持原图：不放大填满', () => {
    for (const m of ['spec', 'keep'] as const) {
      const r = specAutoPlacement(H, IMG_W, IMG_H, ONE_INCH, m, 1, 0.3);
      expect(r.bottomAnchorScale).toBe(1);
    }
  });

  it('分割底部低于发顶（脏数据）时安全收敛，不产生负距离', () => {
    const r = specAutoPlacement(H, IMG_W, IMG_H, ONE_INCH, 'default', 1, 0.1);
    expect(r.personBelowFrac).toBeGreaterThan(0);
    expect(Number.isFinite(r.placement.zoom)).toBe(true);
  });

  it('放大后发顶仍锚定 topRatio，画布不露白', () => {
    const r = specAutoPlacement(H, IMG_W, IMG_H, ONE_INCH, 'default', 1, 0.4);
    // 缩放后图像任一边都不小于画布
    const scale = coverScale(IMG_W, IMG_H, ONE_INCH.pxW, ONE_INCH.pxH) * r.placement.zoom;
    expect(IMG_W * scale).toBeGreaterThanOrEqual(ONE_INCH.pxW - 1e-6);
    expect(IMG_H * scale).toBeGreaterThanOrEqual(ONE_INCH.pxH - 1e-6);
    // 发顶落在 topRatio·pxH：oy = topRatio·pxH − head.top·imgH·scale
    const oy = ONE_INCH.topRatio * ONE_INCH.pxH - H.top * IMG_H * scale;
    expect(oy).toBeCloseTo(ONE_INCH.topRatio * ONE_INCH.pxH - H.top * IMG_H * scale, 6);
  });
});

// ---------- 功能2：多尺寸同时导出时，每个尺寸按自身规格独立构图 ----------
describe('多尺寸独立构图：同一张原图 → 各规格各自的摆放', () => {
  const H = head(0.18, 0.22);
  const IMG_W = 1200;
  const IMG_H = 1600;
  // 1寸 295×413（headRatio 0.64） vs 2寸 413×579（headRatio 0.62）
  const TWO_INCH: FramingSpec = {
    mmW: 35,
    mmH: 49,
    pxW: 413,
    pxH: 579,
    topRatio: 0.08,
    headRatio: 0.62,
    safeRatio: 0.035,
  };

  it('不同规格得到不同的缩放/偏移（不是把同一张图拉伸）', () => {
    const a = specAutoPlacement(H, IMG_W, IMG_H, ONE_INCH, 'default', 1, 1);
    const b = specAutoPlacement(H, IMG_W, IMG_H, TWO_INCH, 'default', 1, 1);
    expect(a.placement.zoom).not.toBe(b.placement.zoom);
    expect(a.placement.dy).not.toBe(b.placement.dy);
  });

  it('每个尺寸各自满足自己的头高与留白目标', () => {
    for (const spec of [ONE_INCH, TWO_INCH]) {
      const r = specAutoPlacement(H, IMG_W, IMG_H, spec, 'default', 1, 1);
      const m = computeMetrics(H, IMG_W, IMG_H, r.placement, spec);
      const v = verifyFraming(m, spec);
      expect(v.headRatioDeviation).toBe('match');
      expect(v.topRatioDeviation).toBe('match');
      expect(m.headRatio).toBeCloseTo(spec.headRatio, 2);
      expect(m.topRatio).toBeCloseTo(spec.topRatio, 2);
    }
  });

  it('构图与输出画布尺寸无关：只由原图与规格决定，可对每个尺寸独立重算', () => {
    const once = specAutoPlacement(H, IMG_W, IMG_H, ONE_INCH, 'default', 1, 1);
    const twice = specAutoPlacement(H, IMG_W, IMG_H, ONE_INCH, 'default', 1, 1);
    expect(twice).toEqual(once); // 纯函数、无隐藏状态
  });
});
