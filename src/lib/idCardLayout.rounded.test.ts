/** 证卡圆角：半径决策 + 圆角路径几何（node 环境，无浏览器依赖） */
import { describe, expect, it } from 'vitest';
import { cardCornerRadiusMm, roundRectPath, CARD_CORNER_FACTOR } from './idCardLayout';

// 最小记录桩：仅实现 roundRectPath 用到的 2D 上下文方法
function recordCtx() {
  const calls: string[] = [];
  const ctx = {
    beginPath: () => calls.push('beginPath'),
    moveTo: (...a: number[]) => calls.push(`moveTo${a.join(',')}`),
    arcTo: (...a: number[]) => calls.push(`arcTo${a.join(',')}`),
    closePath: () => calls.push('closePath'),
    rect: (...a: number[]) => calls.push(`rect${a.join(',')}`),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe('cardCornerRadiusMm', () => {
  it('undefined → 短边自然比例', () => {
    // 身份证 85.6×54：min=54 → 4.32
    expect(cardCornerRadiusMm(85.6, 54)).toBeCloseTo(54 * CARD_CORNER_FACTOR, 5);
  });

  it('显式值直接采用（含 0 = 直角）', () => {
    expect(cardCornerRadiusMm(85.6, 54, 4)).toBe(4);
    expect(cardCornerRadiusMm(85.6, 54, 0)).toBe(0);
  });

  it('负值被夹到 0', () => {
    expect(cardCornerRadiusMm(85.6, 54, -5)).toBe(0);
  });
});

describe('roundRectPath', () => {
  it('半径 ≤0 → 走 rect（直角）', () => {
    const { ctx, calls } = recordCtx();
    roundRectPath(ctx, 10, 20, 50, 70, 0);
    expect(calls).toContain('rect10,20,50,70');
  });

  it('半径 >0 → 4 段 arcTo 且半径被夹到短边一半', () => {
    const { ctx, calls } = recordCtx();
    roundRectPath(ctx, 0, 0, 50, 70, 999); // 半径超出 → 夹到 25
    expect(calls.filter((c) => c.startsWith('arcTo')).length).toBe(4);
    // 第一段 arcTo 半径应为 min(999, 50/2, 70/2) = 25
    expect(calls.find((c) => c.startsWith('arcTo'))).toContain(',25');
  });
});
