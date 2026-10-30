// 画布资源管理（F13）：统一「用后即释放」，避免大批量导出时位图内存堆积 / OOM。
// canvas 在引用消失前不会主动回收显存，必须把 width/height 归零触发释放。

export type DrawFn<T> = (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => T | Promise<T>;

/**
 * 创建画布 → 执行回调 → 无论成功与否都把画布归零释放。
 * 回调可拿到 canvas 本体（需要 drawImage 源 / toBlob 时）与 2d 上下文。
 */
export async function withCanvas<T>(w: number, h: number, fn: DrawFn<T>): Promise<T> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布上下文');
  try {
    return await fn(canvas, ctx);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** 显式释放一张画布的显存（对已有 canvas 引用调用） */
export function releaseCanvas(canvas: HTMLCanvasElement | null | undefined): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}
