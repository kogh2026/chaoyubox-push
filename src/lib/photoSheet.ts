/**
 * 照片拼版引擎 —— 爱印「图片拼版」工作台的 clean-room 复刻（纯几何 + 规则，无 DOM、无依赖）。
 *
 * 对应爱印 `assets/layout-CDU7TAXn.js`（9.4KB 压缩后，全部为纯函数）。复刻原则：
 *   1) 单位统一 mm。爱印把「纸张、边距、间距、文字高度」全部写成 mm 常量，只有出图时才乘 DPI，
 *      所以同一份排版结果既能画预览、也能直接写 PDF（mm 单位），不存在两套几何。
 *   2) 两种排版模式不共用代码路径：
 *      - 常规模式 `paginateNormal`：按「所有图的中位宽高比」先定一个统一单元格，
 *        再逐行取该行最高的图，行内垂直居中 → 同一页的图**顶端不齐但底端自然流动**，这是爱印的观感来源。
 *      - 排满模式 `paginateFill`：同一张图重复铺满（贴纸/标签/热转印），列宽由份数或指定宽度反推，
 *        每页按「行」堆叠，行高固定，满了换页。
 *   3) 分组（section）：一张图可以带自己的 layout 覆盖，从它开始到下一个带覆盖的图之前为一组，
 *      每组独立分页、独立页码统计。
 *
 * 门禁：src/lib/photoSheet.test.ts（常数、网格、分页、长图切分、裁切线、质检）。
 */

/* ============================== 常量（与爱印一一对应） ============================== */

/** 纸张：爱印只内置 A4 / A3 / A5（`Q`） */
export const SHEET_PAPER_MM = {
  a4: { label: 'A4', widthMm: 210, heightMm: 297 },
  a3: { label: 'A3', widthMm: 297, heightMm: 420 },
  a5: { label: 'A5', widthMm: 148, heightMm: 210 },
} as const;

export type SheetPaperId = keyof typeof SHEET_PAPER_MM;

/** 页边距（爱印 `b`）：固定 10mm，不给用户调 —— 家用打印机普遍有 5~10mm 不可打印区 */
export const SHEET_MARGIN_MM = 10;
/** 图片下方一行文字占的高度（`ot`） */
export const SHEET_CAPTION_MM = 6.8;
/** 正文字号（`j`）：4.2mm ≈ 12pt */
export const CAPTION_FONT_MM = 4.2;
/** 图片底部到文字基线的间隙（`q`） */
export const CAPTION_GAP_MM = 1.2;
/** 页脚占的高度（`X`） */
export const PAGE_NUM_MM = 7;
/** 「标注尺寸」时每个格子额外占的高度（`V`） */
export const SIZE_LABEL_MM = 5;
/** 为保证间距不超过 10mm，单元格最多能撑到多少（`D`） */
export const MAX_GAP_MM = 10;
/** 显式行列的合法范围（`k`） */
export const GRID_MIN = 1;
export const GRID_MAX = 6;
/** 间距滑杆范围（`z`） */
export const GAP_RANGE = { min: 0, max: 420, step: 1 } as const;
/** 排满模式「每个宽度」滑杆范围（`_t`） */
export const FILL_WIDTH_RANGE = { min: 10, max: 400 } as const;
/** 每页个数的快捷档（`wt`） */
export const PER_PAGE_CHOICES = [2, 4, 6, 8] as const;
/** 一份图最多复制多少张（`Z`） */
export const FILL_COUNT_MAX = 999;
/** 长图自动分段的宽高比阈值（`et`）与容差（`nt`） */
export const LONG_IMAGE_RATIO = 2.5;
export const LONG_IMAGE_TOLERANCE = 1.15;
/** 中位宽高比的钳制范围（`B`）：极端长条不参与统一单元格计算 */
export const ASPECT_CLAMP = { min: 0.3, max: 2.3 } as const;

/* ============================== 类型 ============================== */

export type SheetOrientation = 'portrait' | 'landscape';
export type SheetCaption = 'none' | 'order' | 'filename';
export type SheetAlign = 'top' | 'center' | 'bottom';

export interface SheetGridSpec {
  cols: number;
  rows: number;
}

/** 排满模式（同一张图重复铺满） */
export interface SheetFill {
  /** 数量；null = 用「排满」按纸张能放多少放多少 */
  count: number | null;
  /** 每个的宽度（mm）；null = 由数量反推 */
  widthMm: number | null;
  cutLines: boolean;
  mirror: boolean;
  sizeLabel: boolean;
}

/** 一套排版设置（一份图可以用自己的设置覆盖全局设置，从而形成一组） */
export interface SheetLayout {
  paper: SheetPaperId;
  orientation: SheetOrientation;
  gapXMm: number;
  gapYMm: number;
  /** 显式行列；null = 按每页个数自动选 */
  grid: SheetGridSpec | null;
  perPage: number;
  align: SheetAlign;
  caption: SheetCaption;
  pageNumbers: boolean;
  splitLong: boolean;
  /** 图片描边：浅色截图印在白纸上也能看清边界 */
  border: boolean;
  fillEnabled: boolean;
  fill: SheetFill;
}

export interface SheetSource {
  id: string;
  name: string;
  /** 源图像素尺寸（用于比例与 PPI 质检） */
  width: number;
  height: number;
  /** 份数；null/undefined = 排满这一页 */
  copies?: number | null;
  /** 从这张图开始，用这套设置另起一组 */
  section?: Partial<SheetLayout> | null;
  /** 逐行空白标记（长图切分用）；没有就退化成整张 */
  blankRows?: Uint8Array | null;
}

export interface SheetPart {
  figure: number;
  sourceId: string;
  partIndex: number;
  partCount: number;
  /** 源图裁剪区（像素）：从 sy 起高 sh */
  sh: number;
  sy: number;
  x: number;
  y: number;
  widthMm: number;
  heightMm: number;
  caption: string;
  captionX: number;
  captionY: number;
  mirrored: boolean;
}

export interface SheetCutLines {
  /** 竖线：带各自的 y 范围（首组贯通到纸顶、末组贯通到纸底，方便整刀裁） */
  xs: { x: number; y1: number; y2: number }[];
  /** 横线：整页通宽 */
  ys: number[];
}

export interface SheetPage {
  widthMm: number;
  heightMm: number;
  parts: SheetPart[];
  cutLines: SheetCutLines | null;
  /** 右下角页码文案 */
  footer: string | null;
}

export interface SheetSectionInfo {
  firstImage: number;
  firstPage: number;
  imageCount: number;
  pageCount: number;
  grid: SheetGrid;
  fillTooLarge: boolean;
  narrowestScreenshotMm: number | null;
  layout: Partial<SheetLayout>;
}

export interface SheetGrid {
  cols: number;
  rows: number;
  cellWidthMm: number;
  cellHeightMm: number;
  imageHeightMm: number;
  gapXMm: number;
  gapYMm: number;
  maxGapXMm: number;
  maxGapYMm: number;
}

export interface SheetResult {
  pages: SheetPage[];
  sections: SheetSectionInfo[];
  /** 第一组的网格（展示「3 列 × 2 行 = 6 张」） */
  grid: SheetGrid;
  /** 有图在排满模式下「放不下指定宽度」→ 界面提示换小一点/换大纸 */
  fillTooLarge: boolean;
  narrowestScreenshotMm: number | null;
}

/** 默认设置（爱印 `Lt`）：A4 竖版、每页 6 个、5mm 间距、文字印「图 N」、长图自动分段 */
export const DEFAULT_SHEET_LAYOUT: SheetLayout = {
  paper: 'a4',
  orientation: 'portrait',
  gapXMm: 5,
  gapYMm: 5,
  grid: null,
  perPage: 6,
  align: 'center',
  caption: 'order',
  pageNumbers: false,
  splitLong: true,
  border: false,
  fillEnabled: false,
  fill: { count: 4, widthMm: null, cutLines: true, mirror: false, sizeLabel: false },
};

/* ============================== 小工具 ============================== */

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function clampGap(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, GAP_RANGE.min, GAP_RANGE.max) : fallback;
}

/** 四舍五入到 0.01mm：裁切线/坐标去重时用，避免浮点尾差生成一堆重复线 */
function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 纸张方向换算：竖版取 max 为高，横版取 max 为宽 */
export function resolvePaper(
  paper: SheetPaperId,
  orientation: SheetOrientation,
): { widthMm: number; heightMm: number } {
  const p = SHEET_PAPER_MM[paper] ?? SHEET_PAPER_MM.a4;
  const long = Math.max(p.widthMm, p.heightMm);
  const short = Math.min(p.widthMm, p.heightMm);
  return orientation === 'portrait'
    ? { heightMm: long, widthMm: short }
    : { heightMm: short, widthMm: long };
}

/** 中位数（爱印 `st`）：用中位宽高比而不是平均，避免一张超长截图把整页拖窄 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/* ============================== 网格 ============================== */

export interface GridMetrics {
  captionMm: number;
  contentWidthMm: number;
  contentHeightMm: number;
  gapXMm: number;
  gapYMm: number;
}

/**
 * 给定行列与可用区，算出单元格尺寸（爱印 `Y`）。
 *
 * 关键点：间距不是「用户填多少就多少」，而是先算出「还能塞下多大间距」的上限（最多 10mm），
 * 再取 min。这样用户把间距拉到 50mm 时，不会出现「间距比格子还宽、格子负宽」的崩坏排版。
 */
export function computeGrid(cols: number, rows: number, m: GridMetrics): SheetGrid {
  const c = Math.max(1, Math.floor(cols));
  const r = Math.max(1, Math.floor(rows));
  const maxGapX = c > 1 ? Math.max(0, Math.floor((m.contentWidthMm - c * MAX_GAP_MM) / (c - 1))) : 0;
  const maxGapY =
    r > 1 ? Math.max(0, Math.floor((m.contentHeightMm - r * (MAX_GAP_MM + m.captionMm)) / (r - 1))) : 0;
  const gx = Math.min(clampGap(m.gapXMm, 0), maxGapX);
  const gy = Math.min(clampGap(m.gapYMm, 0), maxGapY);
  const cellWidthMm = Math.max(1, (m.contentWidthMm - gx * (c - 1)) / c);
  const cellHeightMm = Math.max(1, (m.contentHeightMm - gy * (r - 1)) / r);
  return {
    cols: c,
    rows: r,
    cellWidthMm,
    cellHeightMm,
    imageHeightMm: Math.max(1, cellHeightMm - m.captionMm),
    gapXMm: gx,
    gapYMm: gy,
    maxGapXMm: maxGapX,
    maxGapYMm: maxGapY,
  };
}

/**
 * 自动选行列（爱印 `it`）：在 perPage 的所有因数分解里找「单个图最大」的那一种。
 * 限制单边 ≤4（4×4 以内），否则 50 张图会被排成 1×50 的碎条。
 */
export function autoGrid(
  count: number,
  metrics: GridMetrics & { aspect: number },
): SheetGrid {
  const total = Math.max(1, Math.floor(count));
  let best: { grid: SheetGrid; width: number } | null = null;
  for (let cols = total; cols >= 1; cols -= 1) {
    if (total % cols !== 0) continue;
    const rows = total / cols;
    if (cols > 4 || rows > 4) continue;
    const grid = computeGrid(cols, rows, metrics);
    const width = Math.min(grid.cellWidthMm, grid.imageHeightMm / Math.max(0.01, metrics.aspect));
    if (!best || width > best.width + 1e-6) best = { grid, width };
  }
  return best?.grid ?? computeGrid(1, 1, metrics);
}

/** 显式行列的合法性（爱印 `at`）：1..6 的整数，否则当作没填 */
export function normalizeGridSpec(spec: unknown): SheetGridSpec | null {
  if (!spec || typeof spec !== 'object') return null;
  const { cols, rows } = spec as SheetGridSpec;
  const ok = (v: number) => Number.isInteger(v) && v >= GRID_MIN && v <= GRID_MAX;
  return ok(cols) && ok(rows) ? { cols, rows } : null;
}

/** 解析一套 layout 的网格：优先用显式行列，否则按每页个数自动选（爱印 `ct`） */
export function resolveLayoutGrid(
  layout: SheetLayout,
  metrics: GridMetrics & { aspect: number },
): SheetGrid {
  const spec = normalizeGridSpec(layout.grid);
  return spec ? computeGrid(spec.cols, spec.rows, metrics) : autoGrid(layout.perPage, metrics);
}

/* ============================== 长图切分 ============================== */

/**
 * 逐行空白检测（爱印 `dt`）：取每行中间那个像素当基准，统计该行与基准差异 >14 的像素数，
 * 低于「宽度 × 0.004」即视为空白行。用于在聊天气泡/文字的间隙处切开长图，不切断文字。
 */
export function detectBlankRows(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  tolerance = 14,
  ratio = 0.004,
): Uint8Array {
  const flags = new Uint8Array(height);
  const limit = Math.max(1, Math.floor(width * ratio));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width * 4;
    const mid = rowStart + Math.floor(width / 2) * 4;
    const r0 = rgba[mid];
    const g0 = rgba[mid + 1];
    const b0 = rgba[mid + 2];
    let diff = 0;
    for (let x = 0; x < width && diff <= limit; x += 1) {
      const i = rowStart + x * 4;
      if (
        Math.abs((rgba[i] ?? 0) - r0) > tolerance ||
        Math.abs((rgba[i + 1] ?? 0) - g0) > tolerance ||
        Math.abs((rgba[i + 2] ?? 0) - b0) > tolerance
      ) {
        diff += 1;
      }
    }
    flags[y] = diff <= limit ? 1 : 0;
  }
  return flags;
}

/** 找连续空白区间（爱印 `J`） */
function blankRuns(flags: Uint8Array, from: number, to: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let i = from;
  while (i <= to) {
    if (!flags[i]) {
      i += 1;
      continue;
    }
    let start = i;
    while (start > 0 && flags[start - 1]) start -= 1;
    let end = i;
    while (end + 1 < flags.length && flags[end + 1]) end += 1;
    out.push({ start, end });
    i = end + 1;
  }
  return out;
}

/**
 * 求切点（爱印 `K`）：每段目标高度 `chunk`，在 [chunk, chunk*0.55] 的前瞻窗口里找
 * 「最靠近窗口中点、且足够宽（≥ 图宽的 2.5%）」的空白区间。找不到就按窗口右端硬切。
 */
export function findCutPoints(flags: Uint8Array, chunk: number, limit: number): number[] {
  const n = flags.length;
  const cuts = [0];
  const step = Math.max(1, Math.floor(chunk));
  const minRun = Math.max(2, Math.round(limit * 0.025));
  let i = 0;
  while (n - i > step) {
    const right = i + step;
    const left = i + Math.max(1, Math.floor(step * 0.55));
    const runs = blankRuns(flags, left, right);
    const pick = (list: { start: number; end: number }[]): number => {
      let best = -1;
      for (const run of list) {
        const mid = Math.floor((run.start + run.end + 1) / 2);
        const v = Math.min(right, Math.max(left, mid));
        if (v > best) best = v;
      }
      return best;
    };
    let cut = pick(runs.filter((r) => r.end - r.start + 1 >= minRun));
    if (cut < 0) cut = pick(runs);
    if (cut < 0) cut = right;
    cuts.push(cut);
    i = cut;
  }
  cuts.push(n);
  return cuts;
}

/**
 * 长图自动分段（爱印 `rt`）：
 * 只有「开了开关 + 有空白行程信息 + 高度超过单元格比例 1.15 倍且 ≥2.5」才切。
 * 返回若干 { sy, sh }，同一张图会在页面上标「（1/3）」。
 */
export function splitLongParts(
  source: Pick<SheetSource, 'width' | 'height' | 'blankRows'>,
  cellAspect: number,
  splitLong: boolean,
): { sy: number; sh: number }[] {
  const ratio = source.height / Math.max(1, source.width);
  const limit = Math.max(cellAspect * LONG_IMAGE_TOLERANCE, LONG_IMAGE_RATIO);
  if (!splitLong || !source.blankRows || ratio <= limit) return [{ sy: 0, sh: source.height }];
  const blankFrac = source.blankRows.length / source.height;
  const chunk = Math.max(1, Math.floor(source.width * cellAspect * blankFrac));
  const cuts = findCutPoints(source.blankRows, chunk, source.width * cellAspect);
  const parts: { sy: number; sh: number }[] = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const sy = Math.round(cuts[i] / blankFrac);
    // cuts 给的是「切点坐标」，最后一段直接用图高收尾；这里统一换算成 (起点, 高度)
    const end = i === cuts.length - 2 ? source.height : Math.round(cuts[i + 1] / blankFrac);
    if (end > sy) parts.push({ sh: end - sy, sy });
  }
  return parts.length ? parts : [{ sy: 0, sh: source.height }];
}

/* ============================== 文字 ============================== */

/** 字宽权重（爱印 `ht`）：CJK 记 1，西文记 0.6（em） */
function charWeight(codePoint: number): number {
  return codePoint >= 8192 ? 1 : 0.6;
}

function textWidthMm(text: string, fontMm: number): number {
  let w = 0;
  for (const ch of text) w += charWeight(ch.codePointAt(0) ?? 0);
  return w * fontMm;
}

/** 中间省略（爱印 `lt`）：保留首尾、舍弃中段，文件名前后都有信息 */
export function ellipsizeMiddle(text: string, maxWidthMm: number, fontMm: number): string {
  if (textWidthMm(text, fontMm) <= maxWidthMm) return text;
  const chars = [...text];
  let head = Math.ceil(chars.length / 2);
  let tail = Math.floor(chars.length / 2);
  while (head + tail > 1) {
    if (head >= tail) head -= 1;
    else tail -= 1;
    const out = `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
    if (textWidthMm(out, fontMm) <= maxWidthMm) return out;
  }
  return '…';
}

/** 图注文案（爱印 `Mt`） */
export function captionFor(
  part: { figure: number; partIndex?: number; partCount?: number },
  mode: SheetCaption,
  name: string,
  maxWidthMm = Number.POSITIVE_INFINITY,
): string {
  if (mode === 'none') return '';
  const base =
    mode === 'order' ? `图 ${part.figure}` : name.replace(/\.[^./\\]+$/, '') || name;
  const suffix = (part.partCount ?? 1) > 1 ? `（${part.partIndex} / ${part.partCount}）` : '';
  const room = maxWidthMm - textWidthMm(suffix, CAPTION_FONT_MM);
  return `${ellipsizeMiddle(base, room, CAPTION_FONT_MM)}${suffix}`;
}

/** 尺寸标注文案（爱印 `mt`）：mm → cm，保留一位小数 */
export function sizeLabel(widthMm: number, heightMm: number): string {
  return `${(widthMm / 10).toFixed(1)} × ${(heightMm / 10).toFixed(1)} cm`;
}

/* ============================== 排满模式 ============================== */

export interface FillGridInfo {
  cols: number;
  rows: number;
  widthMm: number;
  heightMm: number;
  tooLarge: boolean;
}

/**
 * 排满模式的网格（爱印 `gt`）：两种入口
 *  - 指定每个宽度：直接用宽度反推列数与行数；放不下就缩到「一页放一个」并标记 tooLarge；
 *  - 指定数量：在数量的因数分解里挑「图最大」的，再按「剩余空间还能再塞几列几行」补满。
 */
export function fillGrid(
  aspect: number,
  layout: SheetLayout,
  paper: { widthMm: number; heightMm: number },
): FillGridInfo {
  const fill = layout.fill;
  const footer = layout.pageNumbers ? PAGE_NUM_MM : 0;
  const label = fill.sizeLabel ? SIZE_LABEL_MM : 0;
  const usableW = paper.widthMm - SHEET_MARGIN_MM * 2;
  const usableH = paper.heightMm - SHEET_MARGIN_MM * 2 - footer;
  const gapX = clampGap(layout.gapXMm, 0);
  const gapY = clampGap(layout.gapYMm, 0);
  const a = Math.max(0.01, aspect);

  if (fill.widthMm !== null) {
    const h = fill.widthMm * a;
    const cols = Math.floor((usableW + gapX) / (fill.widthMm + gapX));
    const rows = Math.floor((usableH + gapY) / (h + label + gapY));
    if (cols >= 1 && rows >= 1) {
      return { cols, rows, widthMm: fill.widthMm, heightMm: h, tooLarge: false };
    }
    const w = Math.min(usableW, (usableH - label) / a);
    return { cols: 1, rows: 1, widthMm: w, heightMm: w * a, tooLarge: true };
  }

  const count = Math.max(1, Math.min(FILL_COUNT_MAX, Math.round(fill.count ?? 1)));
  let best: FillGridInfo | null = null;
  for (let cols = count; cols >= 1; cols -= 1) {
    if (count % cols) continue;
    const rows = count / cols;
    const cw = (usableW - gapX * (cols - 1)) / cols;
    const ch = (usableH - gapY * (rows - 1)) / rows - label;
    const w = Math.min(cw, ch / a);
    if (w > 0 && (!best || w > best.widthMm + 1e-6)) {
      best = { cols, rows, widthMm: w, heightMm: w * a, tooLarge: false };
    }
  }
  const base: FillGridInfo =
    best ?? { cols: 1, rows: 1, widthMm: usableW, heightMm: usableW * a, tooLarge: false };
  return {
    ...base,
    cols: Math.max(base.cols, Math.floor((usableW + gapX + 1e-6) / (base.widthMm + gapX))),
    rows: Math.max(
      base.rows,
      Math.floor((usableH + gapY + 1e-6) / (base.heightMm + label + gapY)),
    ),
  };
}

/* ============================== 分页 ============================== */

interface PageDraft {
  closed: boolean;
  next: number;
  parts: SheetPart[];
  rows: { edges: number[]; height: number; key: string; used: number; y: number }[];
}

/** 排满模式分页（爱印 `ft`）：同一张图重复，列宽固定，行高固定，满了换页 */
export function paginateFill(
  sources: SheetSource[],
  layout: SheetLayout,
  firstIndex: number,
): { pages: SheetPage[]; grid: SheetGrid; fillTooLarge: boolean; narrowestScreenshotMm: null } {
  const paper = resolvePaper(layout.paper, layout.orientation);
  const fill = layout.fill;
  const footerH = layout.pageNumbers ? PAGE_NUM_MM : 0;
  const labelH = fill.sizeLabel ? SIZE_LABEL_MM : 0;
  const usableW = paper.widthMm - SHEET_MARGIN_MM * 2;
  const usableH = paper.heightMm - SHEET_MARGIN_MM * 2 - footerH;
  const pageBottom = SHEET_MARGIN_MM + usableH;
  const gapX = clampGap(layout.gapXMm, 0);
  const gapY = clampGap(layout.gapYMm, 0);

  let tooLarge = false;
  let maxCols = 0;
  let maxRows = 0;
  const drafts: PageDraft[] = [];

  const openPage = (g: FillGridInfo): PageDraft => {
    const contentH = g.rows * (g.heightMm + labelH) + gapY * (g.rows - 1);
    const draft: PageDraft = {
      closed: false,
      next: SHEET_MARGIN_MM + Math.max(0, (usableH - contentH) / 2),
      parts: [],
      rows: [],
    };
    drafts.push(draft);
    return draft;
  };

  sources.forEach((src, si) => {
    const g = fillGrid(src.height / Math.max(1, src.width), layout, paper);
    tooLarge = tooLarge || g.tooLarge;
    maxCols = Math.max(maxCols, g.cols);
    maxRows = Math.max(maxRows, g.rows);

    const fillWholePage = !src.copies;
    const copies = fillWholePage
      ? g.cols * g.rows
      : Math.min(Math.max(1, Math.round(src.copies ?? 1)), FILL_COUNT_MAX);
    const rowWidth = g.cols * g.widthMm + gapX * (g.cols - 1);
    const left = SHEET_MARGIN_MM + (usableW - rowWidth) / 2;
    const edges = Array.from({ length: g.cols }, (_, i) => [
      r2(left + i * (g.widthMm + gapX)),
      r2(left + i * (g.widthMm + gapX) + g.widthMm),
    ]).flat();
    const key = `${r2(g.widthMm)}|${r2(g.heightMm)}|${g.cols}`;

    let page = drafts[drafts.length - 1];
    if (fillWholePage || !page || page.closed) page = openPage(g);

    for (let copy = 1; copy <= copies; copy += 1) {
      let row = page.rows[page.rows.length - 1];
      if (!row || row.key !== key || row.used >= g.cols) {
        if (page.next + g.heightMm + labelH > pageBottom + 1e-6) page = openPage(g);
        row = {
          edges,
          height: g.heightMm,
          key,
          used: 0,
          y: page.next,
        };
        page.rows.push(row);
        page.next = row.y + g.heightMm + labelH + gapY;
      }
      const x = left + row.used * (g.widthMm + gapX);
      row.used += 1;
      page.parts.push({
        caption: fill.sizeLabel ? sizeLabel(g.widthMm, g.heightMm) : '',
        captionX: x + g.widthMm / 2,
        captionY: row.y + g.heightMm + CAPTION_GAP_MM,
        figure: firstIndex + si + 1,
        heightMm: g.heightMm,
        mirrored: fill.mirror,
        partCount: copies,
        partIndex: copy,
        sh: src.height,
        sourceId: src.id,
        sy: 0,
        widthMm: g.widthMm,
        x,
        y: row.y,
      });
    }
    if (fillWholePage) page.closed = true;
  });


  const pages: SheetPage[] = drafts.map((draft) => {
    let cutLines: SheetCutLines | null = null;
    if (fill.cutLines) {
      const ys: number[] = [];
      const xs: { x: number; y1: number; y2: number }[] = [];
      const bands: { edges: number[]; top: number; bottom: number }[] = [];
      for (const row of draft.rows) {
        ys.push(r2(row.y), r2(row.y + row.height));
        const last = bands[bands.length - 1];
        // 相邻两行列边界一致 → 合并成一条竖直带，避免画出一堆首尾相接的短线
        if (last && last.edges.join() === row.edges.join()) last.bottom = row.y + row.height;
        else bands.push({ bottom: row.y + row.height, edges: row.edges, top: row.y });
      }
      bands.forEach((band, i) => {
        // 首带从纸顶开始、末带到纸底结束：裁刀一刀到底，不用对位
        const y1 = i === 0 ? 0 : r2(band.top);
        const y2 = i === bands.length - 1 ? paper.heightMm : r2(band.bottom);
        for (const x of new Set(band.edges)) xs.push({ x: r2(x), y1, y2 });
      });
      cutLines = { xs, ys: [...new Set(ys)].sort((a, b) => a - b) };
    }
    return {
      cutLines,
      footer: null,
      heightMm: paper.heightMm,
      parts: draft.parts,
      widthMm: paper.widthMm,
    };
  });

  const metrics: GridMetrics = {
    captionMm: labelH,
    contentHeightMm: usableH,
    contentWidthMm: usableW,
    gapXMm: gapX,
    gapYMm: gapY,
  };
  return {
    fillTooLarge: tooLarge,
    grid: computeGrid(Math.max(1, maxCols), Math.max(1, maxRows), metrics),
    narrowestScreenshotMm: null,
    pages,
  };
}

/* ============================== 常规分页 ============================== */

/**
 * 常规分页（爱印 `ut`）。与排满模式最大的不同：
 * 单元格先由「中位宽高比」定出一个方框，实际图片按自己的比例在框内**等比缩放**，
 * 于是同一行里矮图不会撑高行，高图也不会被裁 —— 行高取该行最高者，行内水平居中、顶端对齐。
 */
export function paginateNormal(
  sources: SheetSource[],
  layout: SheetLayout,
  firstIndex: number,
): { pages: SheetPage[]; grid: SheetGrid; fillTooLarge: boolean; narrowestScreenshotMm: number | null } {
  const paper = resolvePaper(layout.paper, layout.orientation);
  const gapX = clampGap(layout.gapXMm, 0);
  const gapY = clampGap(layout.gapYMm, 0);
  const captionH = layout.caption === 'none' ? 0 : SHEET_CAPTION_MM;
  const footerH = layout.pageNumbers ? PAGE_NUM_MM : 0;
  const usableW = paper.widthMm - SHEET_MARGIN_MM * 2;
  const usableH = paper.heightMm - SHEET_MARGIN_MM * 2 - footerH;
  const aspect = clamp(
    median(sources.map((s) => s.height / Math.max(1, s.width))) ?? 1.4,
    ASPECT_CLAMP.min,
    ASPECT_CLAMP.max,
  );
  const grid = resolveLayoutGrid(layout, {
    aspect,
    captionMm: captionH,
    contentHeightMm: usableH,
    contentWidthMm: usableW,
    gapXMm: gapX,
    gapYMm: gapY,
  });
  const cellAspect = grid.imageHeightMm / grid.cellWidthMm;

  const sourceById = new Map(sources.map((s) => [s.id, s] as const));
  const entries: {
    figure: number;
    partIndex: number;
    partCount: number;
    sourceId: string;
    sh: number;
    sy: number;
  }[] = [];
  sources.forEach((src, i) => {
    const parts = splitLongParts(src, cellAspect, layout.splitLong);
    parts.forEach((p, pi) => {
      entries.push({
        figure: firstIndex + i + 1,
        partCount: parts.length,
        partIndex: pi + 1,
        sh: p.sh,
        sourceId: src.id,
        sy: p.sy,
      });
    });
  });

  const perPage = grid.cols * grid.rows;
  const pageCount = Math.ceil(entries.length / perPage);
  let narrowest: number | null = null;
  const pages: SheetPage[] = [];

  for (let p = 0; p < pageCount; p += 1) {
    const cells = entries.slice(p * perPage, (p + 1) * perPage).map((entry, i) => {
      const src = sourceById.get(entry.sourceId);
      const ratio = entry.sh / Math.max(1, src?.width ?? 1);
      const widthMm = Math.min(grid.cellWidthMm, grid.imageHeightMm / Math.max(0.01, ratio));
      // 「窄到看不清」只统计被切段的长图/超高图：正常横图本来就窄，不该报警
      if (entry.partCount > 1 || ratio >= 1.6) {
        narrowest = narrowest === null ? widthMm : Math.min(narrowest, widthMm);
      }
      return {
        col: i % grid.cols,
        heightMm: widthMm * ratio,
        part: entry,
        row: Math.floor(i / grid.cols),
        widthMm,
      };
    });

    const rowHeights: number[] = [];
    for (const c of cells) rowHeights[c.row] = Math.max(rowHeights[c.row] ?? 0, c.heightMm + captionH);
    const totalH =
      rowHeights.reduce((a, b) => a + b, 0) + grid.gapYMm * Math.max(0, rowHeights.length - 1);
    const free = Math.max(0, usableH - totalH);
    const topEdge =
      SHEET_MARGIN_MM +
      (layout.align === 'center' ? free / 2 : layout.align === 'bottom' ? free : 0);
    const rowY: number[] = [];
    let y = topEdge;
    rowHeights.forEach((h, i) => {
      rowY[i] = y;
      y += h + grid.gapYMm;
    });

    const parts: SheetPart[] = cells.map((c) => {
      const src = sourceById.get(c.part.sourceId);
      const x = SHEET_MARGIN_MM + c.col * (grid.cellWidthMm + grid.gapXMm);
      const rowTop = rowY[c.row] ?? topEdge;
      return {
        caption: captionFor(c.part, layout.caption, src?.name ?? '', grid.cellWidthMm),
        captionX: x + grid.cellWidthMm / 2,
        captionY: rowTop + (rowHeights[c.row] ?? 0) + CAPTION_GAP_MM,
        figure: c.part.figure,
        heightMm: c.heightMm,
        mirrored: false,
        partCount: c.part.partCount,
        partIndex: c.part.partIndex,
        sh: c.part.sh,
        sourceId: c.part.sourceId,
        sy: c.part.sy,
        widthMm: c.widthMm,
        // 框内水平居中：竖图比格子窄，居中比贴左顺眼
        x: x + (grid.cellWidthMm - c.widthMm) / 2,
        y: rowTop,
      };
    });

    pages.push({ cutLines: null, footer: null, heightMm: paper.heightMm, parts, widthMm: paper.widthMm });
  }

  return { fillTooLarge: false, grid, narrowestScreenshotMm: narrowest, pages };
}

/* ============================== 编排：分组 + 页码 ============================== */

export function normalizeLayout(layout: Partial<SheetLayout>): SheetLayout {
  const merged = { ...DEFAULT_SHEET_LAYOUT, ...layout, fill: { ...DEFAULT_SHEET_LAYOUT.fill, ...layout.fill } };
  return {
    ...merged,
    gapXMm: clampGap(merged.gapXMm, DEFAULT_SHEET_LAYOUT.gapXMm),
    gapYMm: clampGap(merged.gapYMm, DEFAULT_SHEET_LAYOUT.gapYMm),
    perPage: Math.max(1, Math.min(9, Math.round(merged.perPage || 1))),
    paper: SHEET_PAPER_MM[merged.paper] ? merged.paper : 'a4',
  };
}

/**
 * 完整排版：分组 → 每组独立分页 → 合并页序列 → 统一编页码。
 *
 * 分组规则（同爱印）：`section` 挂在某张图上，表示「从这张起用这套覆盖设置」，
 * 直到出现下一个带 `section` 的图为止。没有图时产出 0 页（界面走空状态），与爱印一致。
 */
export function layoutSheets(
  sources: SheetSource[],
  layout: Partial<SheetLayout> = DEFAULT_SHEET_LAYOUT,
): SheetResult {
  const base = normalizeLayout(layout);
  const groups: { first: number; layout: Partial<SheetLayout>; sources: SheetSource[] }[] = [];
  sources.forEach((s, i) => {
    const last = groups[groups.length - 1];
    if (last && !s.section) last.sources.push(s);
    else groups.push({ first: i, layout: s.section ?? {}, sources: [s] });
  });
  if (groups.length === 0) groups.push({ first: 0, layout: {}, sources: [] });

  const pages: SheetPage[] = [];
  const sections: SheetSectionInfo[] = [];
  let fillTooLarge = false;
  let narrowest: number | null = null;

  for (const g of groups) {
    const merged = normalizeLayout({ ...base, ...g.layout });
    const res = merged.fillEnabled
      ? paginateFill(g.sources, merged, g.first)
      : paginateNormal(g.sources, merged, g.first);
    fillTooLarge = fillTooLarge || res.fillTooLarge;
    if (res.narrowestScreenshotMm !== null) {
      narrowest =
        narrowest === null ? res.narrowestScreenshotMm : Math.min(narrowest, res.narrowestScreenshotMm);
    }
    sections.push({
      fillTooLarge: res.fillTooLarge,
      firstImage: g.first,
      firstPage: pages.length,
      grid: res.grid,
      imageCount: g.sources.length,
      layout: g.layout,
      narrowestScreenshotMm: res.narrowestScreenshotMm,
      pageCount: res.pages.length,
    });
    pages.push(...res.pages);
  }

  pages.forEach((p, i) => {
    p.footer = base.pageNumbers ? `第 ${i + 1} 页 / 共 ${pages.length} 页` : null;
  });

  return {
    fillTooLarge,
    grid: sections[0].grid,
    narrowestScreenshotMm: narrowest,
    pages,
    sections,
  };
}

/* ============================== 打印质检 ============================== */

export interface SheetIssue {
  kind: 'blurry' | 'edge' | 'strip' | 'fillTooTall' | 'font';
  page: number;
  figure: number;
  message: string;
  value: number;
}

/** 质检阈值（与爱印 page-checks 一致） */
export const CHECK_LIMITS = {
  /** 低于这个 PPI 视为「模糊」 */
  blurryPpi: 120,
  /** 距纸边小于这个毫米数视为「会被裁掉 / 打不全」 */
  edgeMm: 5,
  /** 长图判定：高 ≥ 宽 × 2.5 且印出来的宽 < 90mm */
  stripRatio: 2.5,
  stripWidthMm: 90,
} as const;

/**
 * 打印质检：把「导出来才发现的糊/裁/看不清」提前到排版阶段。
 * 口径直接对齐爱印 page-checks：PPI < 120、边距 < 5mm、长条图宽度 < 90mm。
 */
export function checkSheets(result: SheetResult, sources: SheetSource[]): SheetIssue[] {
  const byId = new Map(sources.map((s) => [s.id, s] as const));
  const issues: SheetIssue[] = [];
  result.pages.forEach((page, pi) => {
    for (const part of page.parts) {
      const src = byId.get(part.sourceId);
      if (!src) continue;
      const ppi = src.width / Math.max(0.01, part.widthMm / 25.4);
      if (ppi < CHECK_LIMITS.blurryPpi) {
        issues.push({
          figure: part.figure,
          kind: 'blurry',
          message: `图 ${part.figure} 只有 ${Math.round(ppi)} ppi，印出来会糊（建议 ≥120）`,
          page: pi,
          value: ppi,
        });
      }
      const margins = [
        part.x,
        part.y,
        page.widthMm - (part.x + part.widthMm),
        page.heightMm - (part.y + part.heightMm),
      ];
      const minMargin = Math.min(...margins);
      if (minMargin < CHECK_LIMITS.edgeMm) {
        issues.push({
          figure: part.figure,
          kind: 'edge',
          message: `图 ${part.figure} 距纸边仅 ${minMargin.toFixed(1)}mm，可能被裁掉（建议 ≥5mm）`,
          page: pi,
          value: minMargin,
        });
      }
      const ratio = part.heightMm / Math.max(0.01, part.widthMm);
      if (ratio >= CHECK_LIMITS.stripRatio && part.widthMm < CHECK_LIMITS.stripWidthMm) {
        issues.push({
          figure: part.figure,
          kind: 'strip',
          message: `图 ${part.figure} 是长条图且只有 ${Math.round(part.widthMm)}mm 宽，建议打开「长图自动分段」或每页少放几张`,
          page: pi,
          value: part.widthMm,
        });
      }
    }
  });
  if (result.fillTooLarge) {
    issues.push({
      figure: 0,
      kind: 'fillTooTall',
      message: '指定的「每个宽度」放不下：已缩到一页一个，建议换小一点或换大纸',
      page: 0,
      value: 0,
    });
  }
  return issues;
}
