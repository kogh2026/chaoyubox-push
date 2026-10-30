import { describe, expect, it } from 'vitest';
import {
  FIT_MAX,
  FIT_MIN,
  UI_DESIGN_H,
  UI_DESIGN_W,
  ZOOM_MAX,
  ZOOM_MIN,
  computeFitScale,
  computeUiZoom,
} from './uiScale';

describe('computeFitScale：跟随窗口的适配系数', () => {
  it('设计基准尺寸下为 1（界面保持原始比例）', () => {
    expect(computeFitScale({ width: UI_DESIGN_W, height: UI_DESIGN_H })).toBe(1);
  });

  it('窗口变小时等比缩小：取宽高中更紧张的一边', () => {
    // 1200×820：宽度是短板 → 按宽度算
    expect(computeFitScale({ width: 1200, height: UI_DESIGN_H })).toBeCloseTo(1200 / UI_DESIGN_W, 3);
    // 1440×600：高度是短板 → 按高度算
    expect(computeFitScale({ width: UI_DESIGN_W, height: 600 })).toBeCloseTo(600 / UI_DESIGN_H, 3);
  });

  it('窗口变大时等比放大', () => {
    expect(computeFitScale({ width: 1920, height: 1640 })).toBeGreaterThan(1);
  });

  it('缩放下限 FIT_MIN：再小也不继续压，避免字看不清', () => {
    expect(computeFitScale({ width: 320, height: 200 })).toBe(FIT_MIN);
  });

  it('缩放上限 FIT_MAX：大屏上不会无限放大', () => {
    expect(computeFitScale({ width: 7680, height: 4320 })).toBe(FIT_MAX);
  });

  it('非法/缺失尺寸回退 1（SSR、测试环境、窗口未就绪）', () => {
    expect(computeFitScale({ width: 0, height: 0 })).toBe(1);
    expect(computeFitScale({ width: Number.NaN, height: 800 })).toBe(1);
  });
});

describe('computeUiZoom：最终 zoom = 手动缩放 × 自动适配', () => {
  it('100% + 基准窗口 = 1', () => {
    expect(computeUiZoom(100, { width: UI_DESIGN_W, height: UI_DESIGN_H })).toBe(1);
  });

  it('手动缩放与自动适配相乘', () => {
    const z = computeUiZoom(125, { width: 1200, height: UI_DESIGN_H });
    // 内部保留 3 位小数，断言按 2 位精度比（uiScale.ts 里的 round3）
    expect(z).toBeCloseTo(1.25 * (1200 / UI_DESIGN_W), 2);
  });

  it('关闭自动适配时只保留手动缩放', () => {
    expect(computeUiZoom(150, { width: 800, height: 600 }, false)).toBe(1.5);
  });

  it('最终结果受绝对边界保护', () => {
    expect(computeUiZoom(1, { width: 100, height: 100 })).toBeGreaterThanOrEqual(ZOOM_MIN);
    expect(computeUiZoom(100000, { width: 8000, height: 8000 })).toBeLessThanOrEqual(ZOOM_MAX);
  });

  it('非法缩放值回退 100%', () => {
    expect(computeUiZoom(Number.NaN, { width: UI_DESIGN_W, height: UI_DESIGN_H })).toBe(1);
    expect(computeUiZoom(0, { width: UI_DESIGN_W, height: UI_DESIGN_H })).toBe(1);
  });
});
