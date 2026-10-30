// 2D 装箱（D9）：MaxRects + Best-Short-Side-Fit，支持多尺寸混排。
// 参考 maxrects-packer / rectpack2D 的经典实现（纯 TS、零依赖、可单测）。
// 用途：把不同规格的卡片/打印件尽量紧凑地排到一张纸上，减少留白与用纸。

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PackItem {
  id?: string;
  w: number;
  h: number;
}

export interface PlacedItem {
  id?: string;
  x: number; // 左上原点（mm）
  y: number;
  w: number;
  h: number;
}

export interface PackOpts {
  binW: number; // 可用宽度
  binH: number; // 可用高度
  gap?: number; // 卡片间距
  pad?: number; // 纸张安全边距（结果坐标整体偏移）
}

export interface PackResult {
  placements: PlacedItem[];
  count: number;
  usedW: number;
  usedH: number;
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// 去掉被其他空闲矩形完全包含的项（MaxRects 标准剪枝）
function prune(rects: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (let i = 0; i < rects.length; i++) {
    let contained = false;
    for (let j = 0; j < rects.length; j++) {
      if (i === j) continue;
      const a = rects[i];
      const b = rects[j];
      if (a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h) {
        // 完全包含于 b；注意完全相同时保留一个
        if (a.w === b.w && a.h === b.h && j < i) continue;
        contained = true;
        break;
      }
    }
    if (!contained) out.push(rects[i]);
  }
  return out;
}

/**
 * MaxRects-BSSF 装箱：按「短边剩余」评分放置，最大化紧凑度。
 * 返回成功放置的项（放不下的忽略，调用方可用 count 判断是否溢出）。
 */
export function packMaxRects(items: readonly PackItem[], opts: PackOpts): PackResult {
  const gap = Math.max(0, opts.gap ?? 0);
  const pad = Math.max(0, opts.pad ?? 0);
  const bin: Rect = { x: 0, y: 0, w: opts.binW - pad * 2, h: opts.binH - pad * 2 };

  // 大件优先（最长边降序），提高装箱成功率
  const order = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => Math.max(b.it.w, b.it.h) - Math.max(a.it.w, a.it.h) || b.it.w * b.it.h - a.it.w * a.it.h);

  let free: Rect[] = bin.w > 0 && bin.h > 0 ? [{ ...bin }] : [];
  const placements: PlacedItem[] = [];

  for (const { it } of order) {
    const fw = it.w + gap; // 预留间距
    const fh = it.h + gap;
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < free.length; i++) {
      const f = free[i];
      if (f.w + 1e-9 < fw || f.h + 1e-9 < fh) continue;
      const lx = f.w - fw;
      const ly = f.h - fh;
      const shortSide = Math.min(lx, ly);
      const longSide = Math.max(lx, ly);
      const score = shortSide * 1e6 + longSide; // BSSF：先比短边再比长边
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) continue; // 放不下

    const f = free[best];
    const node: Rect = { x: f.x, y: f.y, w: fw, h: fh };
    placements.push({ id: it.id, x: pad + f.x, y: pad + f.y, w: it.w, h: it.h });

    // 以放置块切分所有相交的空闲矩形
    const next: Rect[] = [];
    for (const r of free) {
      if (!intersects(r, node)) {
        next.push(r);
        continue;
      }
      if (node.y > r.y) next.push({ x: r.x, y: r.y, w: r.w, h: node.y - r.y }); // 上
      if (node.y + node.h < r.y + r.h)
        next.push({ x: r.x, y: node.y + node.h, w: r.w, h: r.y + r.h - (node.y + node.h) }); // 下
      if (node.x > r.x) next.push({ x: r.x, y: r.y, w: node.x - r.x, h: r.h }); // 左
      if (node.x + node.w < r.x + r.w)
        next.push({ x: node.x + node.w, y: r.y, w: r.x + r.w - (node.x + node.w), h: r.h }); // 右
    }
    free = prune(next);
  }

  let usedW = 0;
  let usedH = 0;
  for (const p of placements) {
    usedW = Math.max(usedW, p.x + p.w);
    usedH = Math.max(usedH, p.y + p.h);
  }
  return { placements, count: placements.length, usedW, usedH };
}

/** 便捷：多尺寸卡片混排（按给定顺序尽量都放下，返回每个的落位）。 */
export function packMixedCards(
  cards: readonly PackItem[],
  paperW: number,
  paperH: number,
  gap = 4,
  pad = 6,
): PackResult {
  return packMaxRects(cards, { binW: paperW, binH: paperH, gap, pad });
}
