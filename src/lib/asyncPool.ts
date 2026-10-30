// 受限并发池（B5）：同一时刻最多 limit 个任务运行，结果按输入顺序返回。
// 借鉴 p-limit / async-pool 的语义，零依赖、纯函数式，便于单测。
export async function asyncPool<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const total = items.length;
  if (total === 0) return [];
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, total));
  const results: R[] = new Array(total);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      results[i] = await run(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

/** 生成 1..n 的页码范围（PDF 页用 1 起） */
export function pageRange(n: number): number[] {
  return Array.from({ length: Math.max(0, n) }, (_, k) => k + 1);
}
