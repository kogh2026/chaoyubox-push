import { describe, it, expect } from 'vitest';
import { buildPrintPlan, grayscaleOfMode, type PrintPage } from './printJobs';

const pp = (...modes: ('bw' | 'dot' | 'color' | 'none')[]): PrintPage[] =>
  modes.map((mode, i) => ({ page: i + 1, mode }));

describe('送印计划：页选择 + 页级灰度', () => {
  it('全黑白：全部页送印且全灰', () => {
    const plan = buildPrintPlan(pp('bw', 'bw', 'bw'));
    expect(plan.pageIndexes).toEqual([1, 2, 3]);
    expect(plan.grayPages).toEqual([true, true, true]);
    expect(plan.counts).toEqual({ bw: 3, dot: 0, color: 0 });
  });

  it('黑白与彩色交替：一次送印，页序不变', () => {
    const plan = buildPrintPlan(pp('bw', 'color', 'bw', 'bw', 'color'));
    // 关键：不再拆成 4 个任务，而是一份 [1..5]，页序不可能乱
    expect(plan.pageIndexes).toEqual([1, 2, 3, 4, 5]);
    expect(plan.grayPages).toEqual([true, false, true, true, false]);
    expect(plan.counts).toEqual({ bw: 3, dot: 0, color: 2 });
  });

  it('跳过不打印页，且灰度标记仍按页码对齐', () => {
    const plan = buildPrintPlan(pp('bw', 'none', 'color', 'none', 'bw'));
    expect(plan.pageIndexes).toEqual([1, 3, 5]);
    // 索引 = 页码-1：被跳过的 2/4 位必须留 false，否则 3、5 页的灰度标记会错位
    expect(plan.grayPages).toEqual([true, false, false, false, true]);
    expect(plan.counts).toEqual({ bw: 2, dot: 0, color: 1 });
  });

  it('全部不打印时无页可送', () => {
    const plan = buildPrintPlan(pp('none', 'none'));
    expect(plan.pageIndexes).toEqual([]);
    expect(plan.grayPages).toEqual([]);
    expect(plan.counts).toEqual({ bw: 0, dot: 0, color: 0 });
  });

  it('点彩按彩色输出（红章不能打成灰度）', () => {
    expect(grayscaleOfMode('bw')).toBe(true);
    expect(grayscaleOfMode('dot')).toBe(false);
    expect(grayscaleOfMode('color')).toBe(false);
    const plan = buildPrintPlan(pp('dot', 'color', 'bw'));
    expect(plan.grayPages).toEqual([false, false, true]);
    expect(plan.counts).toEqual({ bw: 1, dot: 1, color: 1 });
  });

  it('首行不是第 1 页时也不越界', () => {
    const plan = buildPrintPlan([{ page: 3, mode: 'bw' }]);
    expect(plan.pageIndexes).toEqual([3]);
    expect(plan.grayPages).toEqual([false, false, true]);
  });
});
