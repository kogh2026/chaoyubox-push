// PDF 栅格重渲染的 JPEG 质量策略。
// 参考 Ghostscript `-dPDFSETTINGS=/screen|/ebook|/printer` 的分级思路，
// 但只保留「真正有调用方在用」的那一层：按渲染倍率选质量。
//
// 之前这里还定义了 Tier（screen/ebook/print）+ TIER_SCALE/TIER_QUALITY/resolveRebuildScale，
// 但全项目没有任何 UI 传 tier —— 渲染倍率始终来自用户显式选的 dpi，那套机制一个分支都没跑过。
// 悬着的参数半年后没人敢删也没人敢用，所以收掉；将来真要在 UI 上加「预览/导出/打印」三档时，
// 从 git 历史里取回即可，behavior 无任何变化（本轮删除对现有输出零影响）。
// 纯函数、零依赖，可在 node 环境直接单测。

/**
 * 解算本次重建的 JPEG 质量。
 * 优先级：显式 quality（夹到 0.3–1）> fallback（调用方历史值）。
 */
export function resolveRebuildQuality(quality?: number, fallback = 0.9): number {
  if (typeof quality === 'number' && Number.isFinite(quality) && quality > 0) {
    return Math.min(1, Math.max(0.3, quality));
  }
  return fallback;
}

/**
 * 按渲染倍率推质量：低倍率用更低质量（反正是缩略用途，再细也看不出来），
 * 打印倍率则放宽到 0.85 保画质。用于「只有倍率」的压缩链路（compressPdf 深度模式）。
 */
export function qualityForScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 0.85;
  if (scale <= 1) return 0.7;
  if (scale <= 1.5) return 0.78;
  return 0.85;
}
