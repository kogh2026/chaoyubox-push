import { describe, it, expect } from 'vitest';
import { computeWindow } from './virtualList';

// G15：列表虚拟化窗口计算（等价 react-window FixedSizeList 语义）

describe('computeWindow', () => {
  it('空列表返回空窗口', () => {
    expect(computeWindow(0, 40, 0, 400)).toEqual({ start: 0, end: 0, offsetY: 0, totalHeight: 0 });
  });

  it('行高非法时退化为空窗口（避免除零）', () => {
    expect(computeWindow(100, 0, 0, 400)).toEqual({ start: 0, end: 0, offsetY: 0, totalHeight: 0 });
    expect(computeWindow(100, -8, 0, 400)).toEqual({ start: 0, end: 0, offsetY: 0, totalHeight: 0 });
  });

  it('顶部位置：从 0 开始渲染，并向上留 overscan 余量（此处被裁剪为 0）', () => {
    const r = computeWindow(100, 20, 0, 200, 2);
    expect(r.start).toBe(0);
    expect(r.offsetY).toBe(0);
    expect(r.totalHeight).toBe(2000);
    // visible = ceil(200/20)+1 = 11，end = 0+11+2 = 13
    expect(r.end).toBe(13);
  });

  it('滚动到中段：窗口随滚动位置平移', () => {
    // scrollTop=400 / 20 = 第 20 行起；overscan 2 → start=18
    const r = computeWindow(100, 20, 400, 200, 2);
    expect(r.start).toBe(18);
    expect(r.offsetY).toBe(360);
    expect(r.end).toBe(33);
    expect(r.totalHeight).toBe(2000);
  });

  it('overscan=0 时窗口严格贴着可视区', () => {
    const r = computeWindow(100, 20, 400, 200, 0);
    expect(r.start).toBe(20);
    expect(r.end).toBe(31);
    expect(r.offsetY).toBe(400);
  });

  it('接近底部：end 被总数裁剪，不会越界', () => {
    const r = computeWindow(30, 20, 400, 200, 2);
    // 内容高 600、可视 200 → 最大滚动 400；first=20，start=18，end=min(30, 20+11+2)=30
    expect(r.start).toBe(18);
    expect(r.end).toBe(30);
    expect(r.offsetY).toBe(360);
  });

  it('scrollTop 超过最大滚动值时夹紧（内容收缩后残留越界滚动位置）', () => {
    const r = computeWindow(10, 20, 99999, 200, 2);
    // 内容高 200 ≤ 可视 200 → maxScroll=0，窗口回到顶部且不反转
    expect(r.start).toBe(0);
    expect(r.end).toBe(10);
    expect(r.offsetY).toBe(0);
    expect(r.start).toBeLessThanOrEqual(r.end);
  });

  it('任何入参下 start 都不大于 end（窗口永不反转）', () => {
    for (const count of [0, 1, 7, 200]) {
      for (const scrollTop of [-50, 0, 123, 99999]) {
        for (const vh of [0, 40, 640]) {
          const r = computeWindow(count, 30, scrollTop, vh, 3);
          expect(r.start).toBeLessThanOrEqual(r.end);
          expect(r.end).toBeLessThanOrEqual(count);
          expect(r.offsetY).toBe(r.start * 30);
        }
      }
    }
  });

  it('负的 scrollTop / viewportHeight 按 0 处理', () => {
    const r = computeWindow(50, 20, -100, -50, 2);
    // first = 0（scrollTop 归零）；visible = ceil(0/20)+1 = 1；end = 0+1+2 = 3
    expect(r.start).toBe(0);
    expect(r.end).toBe(3);
    expect(r.offsetY).toBe(0);
    expect(r.totalHeight).toBe(1000);
  });

  it('小数入参被规整（count 取整、负 overscan 归零）', () => {
    const r = computeWindow(12.9, 20, 0, 200, -5);
    expect(r.start).toBe(0);
    expect(r.end).toBe(11);
    expect(r.totalHeight).toBe(240);
  });

  it('窗口长度足以覆盖可视行数', () => {
    for (const scrollTop of [0, 137, 2500, 4999]) {
      const r = computeWindow(250, 20, scrollTop, 300, 2);
      const visibleRows = Math.ceil(300 / 20);
      expect(r.end - r.start).toBeGreaterThanOrEqual(visibleRows);
      expect(r.start).toBeGreaterThanOrEqual(0);
      expect(r.end).toBeLessThanOrEqual(250);
    }
  });
});
