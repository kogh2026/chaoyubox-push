// 证卡拼版 / 证件照排版 布局引擎（纯前端，无 ML）
// 单位全部为毫米(mm)；图像以"cover"方式填满单元格，不变形。

import type { FramingSpec } from './specFraming';

export interface PaperSize {
  id: string;
  name: string;
  w: number;
  h: number;
}

export const PAPER_SIZES: PaperSize[] = [
  { id: 'r6', name: 'R6 (0寸) 横排 127×89.3', w: 127, h: 89.3 },
  { id: 'a4', name: 'A4 (210×297)', w: 210, h: 297 },
  { id: 'a5', name: 'A5 (148×210)', w: 148, h: 210 },
  { id: 'six', name: '6寸 (102×152)', w: 102, h: 152 },
  { id: 'five', name: '5寸 (89×127)', w: 89, h: 127 },
  { id: 'three', name: '3寸 (89×64)', w: 89, h: 64 },
];

export interface PhotoPreset {
  id: string;
  name: string;
  w: number;
  h: number;
  /** 发顶留白占画幅高比例（头顶留白），复刻爱印 topRatio，默认 0.08 */
  topRatio?: number;
  /** 头部占比（发顶→下巴）占画幅高比例，复刻爱印 headRatio */
  headRatio?: number;
  /** 安全边距占画幅高比例，复刻爱印 safeRatio，默认 0.035 */
  safeRatio?: number;
}

export const PHOTO_PRESETS: PhotoPreset[] = [
  { id: '1cun', name: '1寸 25×35', w: 25, h: 35, topRatio: 0.08, headRatio: 0.64, safeRatio: 0.035 },
  { id: '2cun', name: '2寸 35×49', w: 35, h: 49, topRatio: 0.08, headRatio: 0.62, safeRatio: 0.035 },
  { id: 'small1', name: '小1寸 22×32', w: 22, h: 32, topRatio: 0.08, headRatio: 0.62, safeRatio: 0.035 },
  { id: 'small2', name: '小2寸 35×45', w: 35, h: 45, topRatio: 0.08, headRatio: 0.62, safeRatio: 0.035 },
  { id: 'big1', name: '大1寸 33×48', w: 33, h: 48, topRatio: 0.08, headRatio: 0.64, safeRatio: 0.035 },
  { id: 'passport', name: '护照 33×48', w: 33, h: 48, topRatio: 0.08, headRatio: 30.5 / 48, safeRatio: 0.03 },
  { id: 'drive', name: '驾照 22×32', w: 22, h: 32, topRatio: 0.08, headRatio: 0.62, safeRatio: 0.035 },
];

/** 默认 DPI（证件照排版通用） */
export const DEFAULT_DPI = 300;

/** 毫米 → 像素（@dpi） */
export function mmToPx(mm: number, dpi: number = DEFAULT_DPI): number {
  return Math.round((mm * dpi) / 25.4);
}

/**
 * 由尺寸预设构造「按规格自动构图」所需的 FramingSpec（mm/px/比例）。
 * 预设若未标注 topRatio/headRatio/safeRatio，回落到行业通用值（0.08 / 0.64 / 0.035）。
 * 多尺寸导出时每个尺寸都独立调用本函数，得到各自规格的构图参数。
 */
export function framingSpecOf(p: PhotoPreset, dpi: number = DEFAULT_DPI): FramingSpec {
  const pxW = mmToPx(p.w, dpi);
  const pxH = mmToPx(p.h, dpi);
  return {
    mmW: p.w,
    mmH: p.h,
    pxW,
    pxH,
    topRatio: p.topRatio ?? 0.08,
    headRatio: p.headRatio ?? 0.64,
    safeRatio: p.safeRatio ?? 0.035,
  };
}

export interface LayoutResult {
  cols: number;
  rows: number;
  perSheet: number;
}

// 计算一张纸上能排多少张
export function computeLayout(
  paperW: number,
  paperH: number,
  itemW: number,
  itemH: number,
  margin: number,
  gap: number,
): LayoutResult {
  // 异常输入防护：非法项尺寸 → 单张降级；非法 gap → 0；非法纸/边距 → 0 化后由 max(1,…) 兜底
  if (!Number.isFinite(itemW) || !Number.isFinite(itemH) || itemW <= 0 || itemH <= 0) {
    return { cols: 1, rows: 1, perSheet: 1 };
  }
  const g = Number.isFinite(gap) && gap > 0 ? gap : 0;
  const m = Number.isFinite(margin) ? margin : 0;
  const pw = Number.isFinite(paperW) ? paperW : 0;
  const ph = Number.isFinite(paperH) ? paperH : 0;
  const usableW = pw - 2 * m;
  const usableH = ph - 2 * m;
  const cols = Math.max(1, Math.floor((usableW + g) / (itemW + g)));
  const rows = Math.max(1, Math.floor((usableH + g) / (itemH + g)));
  return { cols, rows, perSheet: cols * rows };
}

/** cover 裁切的源矩形计算（纯函数）：把 natW×natH 的图裁成与 pxW×pxH 同比例的最大居中矩形。
 *  宽原图（sr>tr）→ 裁左右；高原图 → 裁上下；非法尺寸 → 空矩形（drawImage 空操作）。 */
export function coverSrcRect(
  natW: number,
  natH: number,
  pxW: number,
  pxH: number,
): { sx: number; sy: number; sw: number; sh: number } {
  if (!Number.isFinite(natW) || !Number.isFinite(natH) || natW <= 0 || natH <= 0) {
    return { sx: 0, sy: 0, sw: 0, sh: 0 };
  }
  if (!Number.isFinite(pxW) || !Number.isFinite(pxH) || pxW <= 0 || pxH <= 0) {
    return { sx: 0, sy: 0, sw: 0, sh: 0 };
  }
  const sr = natW / natH;
  const tr = pxW / pxH;
  if (sr > tr) {
    const sw = natH * tr;
    return { sx: (natW - sw) / 2, sy: 0, sw, sh: natH };
  }
  const sh = natW / tr;
  return { sx: 0, sy: (natH - sh) / 2, sw: natW, sh };
}

export interface BuildOpts {
  sources: HTMLImageElement[];
  layout: LayoutResult;
  itemW: number;
  itemH: number;
  mode: 'single' | 'multi';
  dpi?: number;
}

/** 多图模式下每格用哪个源图索引（取模循环填充）；源图数为 0 时全 null（调用方遇到 null/空洞即停）。
 *  从 buildSheetImages 的多图分支提取，纯函数，node 环境可直接测。 */
export function assignSources(count: number, sourcesLen: number): (number | null)[] {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (n === 0) return [];
  if (!Number.isFinite(sourcesLen) || sourcesLen <= 0) return new Array(n).fill(null);
  const out: (number | null)[] = [];
  for (let i = 0; i < n; i++) out.push(i % sourcesLen);
  return out;
}

/* ===== 可测接缝：最小 canvas / 2d context 接口 =====
   真实 HTMLCanvasElement 天然满足这两个结构类型，调用点无需改动；
   测试传入桩对象即可在 node 环境断言绘制行为。 */

/** 最小 2d context（桩友好；drawImage 宽松签名同时覆盖 5 参/9 参两种调用） */
export interface Ctx2DLike {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  setLineDash(segments: number[]): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  drawImage(
    image: unknown,
    sx: number,
    sy: number,
    sw?: number,
    sh?: number,
    dx?: number,
    dy?: number,
    dw?: number,
    dh?: number,
  ): void;
}

/** 最小 canvas */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(id: '2d'): Ctx2DLike | null;
}

/** 单元格矩形（行主序，左上起） */
export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一张纸上所有单元格的矩形（纯函数）。
 *  scale=1 时即毫米坐标（PDF 导出复用同一套坐标）；
 *  非法行列 → 空数组。renderPreview / exportGridPdf / exportSheetPdf 共用。 */
export function cellRects(o: {
  cols: number;
  rows: number;
  itemW: number;
  itemH: number;
  margin: number;
  gap: number;
  scale: number;
}): CellRect[] {
  const cols = Number.isFinite(o.cols) ? Math.floor(o.cols) : 0;
  const rows = Number.isFinite(o.rows) ? Math.floor(o.rows) : 0;
  if (cols <= 0 || rows <= 0) return [];
  const cellW = o.itemW * o.scale;
  const cellH = o.itemH * o.scale;
  const gapPx = o.gap * o.scale;
  const startX = o.margin * o.scale;
  const startY = o.margin * o.scale;
  const out: CellRect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({
        x: startX + c * (cellW + gapPx),
        y: startY + r * (cellH + gapPx),
        w: cellW,
        h: cellH,
      });
    }
  }
  return out;
}

/** canvas 工厂（默认 document.createElement；测试注入桩） */
export type CanvasFactory = () => CanvasLike;

const defaultCanvas: CanvasFactory = () => document.createElement('canvas');

// 把源图以 cover 方式裁切填满目标像素尺寸的画布
export function fitCover(
  img: HTMLImageElement,
  pxW: number,
  pxH: number,
  createCanvas: CanvasFactory = defaultCanvas,
): CanvasLike {
  const c = createCanvas();
  c.width = Math.max(1, Math.round(pxW));
  c.height = Math.max(1, Math.round(pxH));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  const { sx, sy, sw, sh } = coverSrcRect(img.naturalWidth, img.naturalHeight, pxW, pxH);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

// 生成一张纸上每个单元格的图像画布（300DPI 输出质量）
export function buildSheetImages(opts: BuildOpts, createCanvas: CanvasFactory = defaultCanvas): CanvasLike[] {
  const dpi = opts.dpi ?? 300;
  const pxW = (opts.itemW / 25.4) * dpi;
  const pxH = (opts.itemH / 25.4) * dpi;
  const arr: CanvasLike[] = [];
  if (opts.mode === 'single') {
    const src = opts.sources[0];
    if (!src) return arr;
    const c = fitCover(src, pxW, pxH, createCanvas);
    for (let i = 0; i < opts.layout.perSheet; i++) arr.push(c); // 复用同一画布
  } else {
    const assign = assignSources(opts.layout.perSheet, opts.sources.length);
    for (let i = 0; i < assign.length; i++) {
      const si = assign[i];
      const src = si === null ? undefined : opts.sources[si];
      if (!src) break;
      arr.push(fitCover(src, pxW, pxH, createCanvas));
    }
  }
  return arr;
}

export interface PreviewOpts {
  paper: PaperSize;
  layout: LayoutResult;
  itemW: number;
  itemH: number;
  margin: number;
  gap: number;
  cutLines: boolean;
  sheets: CanvasLike[];
  scale: number; // 预览像素/毫米
}

// 在给定 canvas 上绘制整张排版预览
export function renderPreview(canvas: CanvasLike, o: PreviewOpts): void {
  canvas.width = Math.round(o.paper.w * o.scale);
  canvas.height = Math.round(o.paper.h * o.scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  cellRects({
    cols: o.layout.cols,
    rows: o.layout.rows,
    itemW: o.itemW,
    itemH: o.itemH,
    margin: o.margin,
    gap: o.gap,
    scale: o.scale,
  }).forEach((rc, idx) => {
    if (o.cutLines) {
      ctx.strokeStyle = 'rgba(0,0,0,0.28)';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 0.6;
      ctx.strokeRect(rc.x, rc.y, rc.w, rc.h);
      ctx.setLineDash([]);
    }
    const img = o.sheets[idx];
    if (img) ctx.drawImage(img, rc.x, rc.y, rc.w, rc.h);
  });
}
