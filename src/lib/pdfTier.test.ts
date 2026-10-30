import { describe, it, expect } from 'vitest';
import { resolveRebuildQuality, qualityForScale } from './pdfTier';

// 栅格重建的 JPEG 质量策略。
// Tier（screen/ebook/print）那套因为全项目零调用已收掉，这里只测真正生效的两个函数。

describe('resolveRebuildQuality', () => {
  it('显式 quality 优先，并夹到 0.3–1', () => {
    expect(resolveRebuildQuality(0.5)).toBe(0.5);
    expect(resolveRebuildQuality(0.05)).toBe(0.3);
    expect(resolveRebuildQuality(1.5)).toBe(1);
  });

  it('未给出时用调用方 fallback（保持各调用方历史行为）', () => {
    expect(resolveRebuildQuality()).toBe(0.9);
    expect(resolveRebuildQuality(undefined, 0.88)).toBe(0.88);
  });

  it('非法 quality（0 / 负数 / NaN）走 fallback 分支', () => {
    expect(resolveRebuildQuality(0, 0.88)).toBe(0.88);
    expect(resolveRebuildQuality(-0.2, 0.7)).toBe(0.7);
    expect(resolveRebuildQuality(Number.NaN, 0.88)).toBe(0.88);
  });
});

describe('qualityForScale（压缩链路的质量分级）', () => {
  it('1× 及以下走压缩档 0.7', () => {
    expect(qualityForScale(1)).toBe(0.7);
    expect(qualityForScale(0.5)).toBe(0.7);
  });

  it('1.5× 走中档 0.78', () => {
    expect(qualityForScale(1.5)).toBe(0.78);
  });

  it('更高倍率走打印档 0.85', () => {
    expect(qualityForScale(2)).toBe(0.85);
    expect(qualityForScale(3)).toBe(0.85);
  });

  it('质量随倍率单调递增或持平（不会出现「更清晰反而更糊」）', () => {
    expect(qualityForScale(1)).toBeLessThanOrEqual(qualityForScale(1.5));
    expect(qualityForScale(1.5)).toBeLessThanOrEqual(qualityForScale(2));
  });

  it('非法倍率回落 0.85（不产生 NaN 质量）', () => {
    expect(qualityForScale(0)).toBe(0.85);
    expect(qualityForScale(-2)).toBe(0.85);
    expect(qualityForScale(Number.NaN)).toBe(0.85);
  });
});
