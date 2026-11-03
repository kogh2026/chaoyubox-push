// 布局策略层（T0）：把单一网格算法抽象为可插拔策略
// 复用既有 computeCardGrid（标准网格）作为其中一种策略，新增「紧凑填充 / 自适应」。
// 调用方通过 resolveCardGrid(algo, ...) 统一分发，UI 提供算法切换。

import { computeCardGrid, type CardGrid, type LayoutCfg } from './idCardLayout';
import { packMaxRects } from './maxRects';

export type LayoutAlgo = 'grid' | 'compact' | 'adaptive' | 'maxrects';

export const LAYOUT_ALGOS: { id: LayoutAlgo; name: string }[] = [
  { id: 'grid', name: '标准网格' },
  { id: 'compact', name: '紧凑填充' },
  { id: 'adaptive', name: '自适应' },
  { id: 'maxrects', name: '混排装箱' },
];

const PAD2 = 12; // 与 idCardLayout.ts 中 PAD*2 对齐（打印安全边距）

function fullCapacity(paperW: number, paperH: number, cardW: number, cardH: number, gap: number): number {
  const uw = paperW - PAD2;
  const uh = paperH - PAD2;
  return Math.max(1, Math.floor((uw + gap) / (cardW + gap))) * Math.max(1, Math.floor((uh + gap) / (cardH + gap)));
}

/** 标准网格：沿用既有行为（≤3 张优先单列堆叠，贴近复印习惯） */
export function gridStrategy(
  paperW: number,
  paperH: number,
  cardW: number,
  cardH: number,
  cfg: LayoutCfg,
): CardGrid {
  return computeCardGrid(paperW, paperH, cardW, cardH, cfg);
}

/**
 * 紧凑填充：在 1..perPage 所有列数中遍历，取「缩放最大」的排布（并列时取更宽），
 * 让卡片尽量放大、少留白；不强制单列堆叠，与 grid 形成明显差异。
 */
export function compactStrategy(
  paperW: number,
  paperH: number,
  cardW: number,
  cardH: number,
  cfg: LayoutCfg,
): CardGrid {
  const uw = paperW - PAD2;
  const uh = paperH - PAD2;
  const gap = cfg.gap;
  const capacity = fullCapacity(paperW, paperH, cardW, cardH, gap);
  const n = cfg.perPage === 'auto' ? capacity : Math.min(cfg.perPage, capacity);
  if (n <= 0) return computeCardGrid(paperW, paperH, cardW, cardH, cfg);

  let best: CardGrid | null = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const sFit = Math.min(
      uw / (cols * cardW + (cols - 1) * gap),
      uh / (rows * cardH + (rows - 1) * gap),
    );
    // 不允许缩小时，放不下的排布跳过（保持既有降级语义）
    if (!cfg.shrink && sFit < 1) continue;
    const scale = Math.min(1, sFit);
    const cand: CardGrid = {
      cols,
      rows,
      usedRows: rows,
      perPage: n,
      capacity,
      scale,
      cardW: cardW * scale,
      cardH: cardH * scale,
      blockW: cols * cardW * scale + (cols - 1) * gap,
      blockH: rows * cardH * scale + (rows - 1) * gap,
    };
    const better =
      !best ||
      cand.scale > best.scale + 1e-9 ||
      (Math.abs(cand.scale - best.scale) < 1e-9 && cand.cols > best.cols);
    if (better) best = cand;
  }
  return best ?? computeCardGrid(paperW, paperH, cardW, cardH, cfg);
}

/** 自适应：按纸张方向选策略——横放纸用紧凑填充，竖放纸用标准网格 */
export function adaptiveStrategy(
  paperW: number,
  paperH: number,
  cardW: number,
  cardH: number,
  cfg: LayoutCfg,
): CardGrid {
  return paperW >= paperH
    ? compactStrategy(paperW, paperH, cardW, cardH, cfg)
    : gridStrategy(paperW, paperH, cardW, cardH, cfg);
}

/**
 * 混排装箱（D9）：用 MaxRects 实际装箱求「能装下目标张数」的最大缩放，
 * 再由落位坐标回填统一网格（CardGrid）。对统一尺寸卡，比「遍历列数」的紧凑填充更贴近真实可放性；
 * 多尺寸混排请直接用 maxRects.packMixedCards（返回每张卡的落位）。
 */
export function maxRectsStrategy(
  paperW: number,
  paperH: number,
  cardW: number,
  cardH: number,
  cfg: LayoutCfg,
): CardGrid {
  const uw = paperW - PAD2;
  const uh = paperH - PAD2;
  const gap = cfg.gap;
  const capacity = fullCapacity(paperW, paperH, cardW, cardH, gap);
  const want = cfg.perPage === 'auto' ? capacity : Math.min(cfg.perPage, capacity);
  if (want <= 0) return computeCardGrid(paperW, paperH, cardW, cardH, cfg);

  for (let s = 1; s >= 0.2 - 1e-9; s -= 0.05) {
    const scale = Math.round(s * 100) / 100;
    if (!cfg.shrink && scale < 1) break; // 不允许缩小：只尝试原尺寸
    const cw = cardW * scale;
    const ch = cardH * scale;
    const items = Array.from({ length: want }, (_, i) => ({ id: String(i), w: cw, h: ch }));
    const res = packMaxRects(items, { binW: uw, binH: uh, gap });
    if (res.count < want) continue;
    const xs = new Set(res.placements.map((p) => Math.round(p.x)));
    const ys = new Set(res.placements.map((p) => Math.round(p.y)));
    const cols = Math.max(1, xs.size);
    const rows = Math.max(1, ys.size);
    return {
      cols,
      rows,
      usedRows: rows,
      perPage: want,
      capacity,
      scale,
      cardW: cw,
      cardH: ch,
      blockW: cols * cw + (cols - 1) * gap,
      blockH: rows * ch + (rows - 1) * gap,
    };
  }
  return computeCardGrid(paperW, paperH, cardW, cardH, cfg);
}

/** 统一分发入口：UI 通过 cfg 外的 algo 选择算法 */
export function resolveCardGrid(
  algo: LayoutAlgo,
  paperW: number,
  paperH: number,
  cardW: number,
  cardH: number,
  cfg: LayoutCfg,
): CardGrid {
  // 版面预设优先：用户显式指定了行列，任何算法都不得改写这个排布
  if (cfg.preset) return computeCardGrid(paperW, paperH, cardW, cardH, cfg);
  if (algo === 'compact') return compactStrategy(paperW, paperH, cardW, cardH, cfg);
  if (algo === 'adaptive') return adaptiveStrategy(paperW, paperH, cardW, cardH, cfg);
  if (algo === 'maxrects') return maxRectsStrategy(paperW, paperH, cardW, cardH, cfg);
  return gridStrategy(paperW, paperH, cardW, cardH, cfg);
}
