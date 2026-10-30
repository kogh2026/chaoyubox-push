import { describe, expect, it } from 'vitest';
import { computeCardGrid, type LayoutCfg } from './idCardLayout';
import {
  resolveCardGrid,
  gridStrategy,
  compactStrategy,
  adaptiveStrategy,
} from './layoutStrategies';

const cfg = (perPage: number | 'auto'): LayoutCfg => ({
  perPage,
  gap: 4,
  shrink: true,
  pos: 'center',
  offX: 0,
  offY: 0,
});

const PAPER = { w: 210, h: 297 }; // A4 竖
const CARD = { w: 85.6, h: 54 };

describe('布局策略 T0', () => {
  it('grid 策略与既有 computeCardGrid 完全一致（向后兼容）', () => {
    const a = computeCardGrid(PAPER.w, PAPER.h, CARD.w, CARD.h, cfg(2));
    const b = gridStrategy(PAPER.w, PAPER.h, CARD.w, CARD.h, cfg(2));
    expect(b).toEqual(a);
  });

  it('grid：≤3 张优先单列堆叠（perPage=2 → cols=1）', () => {
    const g = resolveCardGrid('grid', PAPER.w, PAPER.h, CARD.w, CARD.h, cfg(2));
    expect(g.cols).toBe(1);
    expect(g.perPage).toBe(2);
  });

  it('compact：perPage=2 转为并排（cols=2），与 grid 形成差异', () => {
    const g = compactStrategy(PAPER.w, PAPER.h, CARD.w, CARD.h, cfg(2));
    expect(g.cols).toBe(2);
    expect(g.perPage).toBe(2);
    // 紧凑填充不强制单列堆叠
    expect(g.cols).not.toBe(1);
  });

  it('adaptive：竖放纸退回 grid（cols=1），横放纸采用 compact', () => {
    const portrait = adaptiveStrategy(PAPER.w, PAPER.h, CARD.w, CARD.h, cfg(2));
    const landscape = adaptiveStrategy(PAPER.h, PAPER.w, CARD.w, CARD.h, cfg(2));
    expect(portrait.cols).toBe(1); // = grid
    expect(landscape.cols).toBe(2); // = compact
  });

  it('auto：compact 与 grid 都填满整页容量', () => {
    const cap = computeCardGrid(PAPER.w, PAPER.h, CARD.w, CARD.h, cfg('auto')).capacity;
    const gc = gridStrategy(PAPER.w, PAPER.h, CARD.w, CARD.h, cfg('auto'));
    const cc = compactStrategy(PAPER.w, PAPER.h, CARD.w, CARD.h, cfg('auto'));
    expect(gc.perPage).toBe(cap);
    expect(cc.perPage).toBe(cap);
  });

  it('compact 缩放不超过 1（不放大失真）', () => {
    const g = compactStrategy(PAPER.w, PAPER.h, CARD.w, CARD.h, cfg(4));
    expect(g.scale).toBeLessThanOrEqual(1);
  });
});
