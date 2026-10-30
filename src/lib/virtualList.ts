// 列表虚拟化核心（G15）：按滚动位置计算「只需渲染的可视窗口」。
// 纯函数、可单测；与具体 UI 框架无关（等价 react-window 的 FixedSizeList 计算）。

export interface WindowRange {
  start: number; // 起始索引（含）
  end: number; // 结束索引（不含）
  offsetY: number; // 窗口顶部在总内容中的偏移（用于 translateY / marginTop）
  totalHeight: number; // 总内容高度（撑开滚动条）
}

/**
 * 计算固定行高列表的可视窗口。
 * @param count 总条数
 * @param itemHeight 单行高度（px）
 * @param scrollTop 当前滚动位置
 * @param viewportHeight 可视区高度
 * @param overscan 上下各多渲染几行（减少滚动白屏）
 */
export function computeWindow(
  count: number,
  itemHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = 2,
): WindowRange {
  const n = Math.max(0, Math.floor(count));
  if (n === 0 || itemHeight <= 0) {
    return { start: 0, end: 0, offsetY: 0, totalHeight: 0 };
  }
  const totalHeight = n * itemHeight;
  const vh = Math.max(0, viewportHeight);
  // 把 scrollTop 夹到有效滚动范围：内容收缩（删页/过滤）后浏览器可能残留越界 scrollTop，
  // 不夹紧会让 first 冲到列表尾部，start 超过 end 导致窗口为空（整列表看起来是空白）。
  const maxScroll = Math.max(0, totalHeight - vh);
  const st = Math.min(Math.max(0, scrollTop), maxScroll);
  const first = Math.floor(st / itemHeight);
  const visible = Math.ceil(vh / itemHeight) + 1;
  const pad = Math.max(0, overscan);
  const start = Math.max(0, Math.min(first, n) - pad);
  const end = Math.min(n, first + visible + pad);
  return { start, end: Math.max(start, end), offsetY: start * itemHeight, totalHeight };
}
