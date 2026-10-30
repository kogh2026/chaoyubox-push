/** 受限并发池（B5）测试：顺序保持、并发上限、边界与错误传播。 */
import { describe, expect, it } from 'vitest';
import { asyncPool, pageRange } from './asyncPool';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('asyncPool', () => {
  it('结果按输入顺序返回（即使完成顺序不同）', async () => {
    const items = [30, 10, 20];
    const out = await asyncPool(items, 3, async (ms, i) => {
      await delay(ms);
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });

  it('并发不超过 limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await asyncPool([1, 2, 3, 4, 5, 6, 7], 2, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(5);
      inFlight--;
      return 0;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('空数组 → 空结果', async () => {
    expect(await asyncPool([], 4, async () => 1)).toEqual([]);
  });

  it('limit 大于任务数 → 全部并行但仍有序', async () => {
    const out = await asyncPool(['a', 'b'], 99, async (x) => x.toUpperCase());
    expect(out).toEqual(['A', 'B']);
  });

  it('任一任务抛错 → 整体 reject', async () => {
    await expect(
      asyncPool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});

describe('pageRange', () => {
  it('生成 1..n', () => {
    expect(pageRange(3)).toEqual([1, 2, 3]);
    expect(pageRange(0)).toEqual([]);
  });
});
