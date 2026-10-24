// 证卡拼版 / 证件照排版 布局引擎（纯前端，无 ML）
// 单位全部为毫米(mm)；图像以"cover"方式填满单元格，不变形。

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
}

export const PHOTO_PRESETS: PhotoPreset[] = [
  { id: '1cun', name: '1寸 25×35', w: 25, h: 35 },
  { id: '2cun', name: '2寸 35×49', w: 35, h: 49 },
  { id: 'small1', name: '小1寸 22×32', w: 22, h: 32 },
  { id: 'small2', name: '小2寸 35×45', w: 35, h: 45 },
  { id: 'big1', name: '大1寸 33×48', w: 33, h: 48 },
  { id: 'passport', name: '护照 33×48', w: 33, h: 48 },
  { id: 'drive', name: '驾照 22×32', w: 22, h: 32 },
];

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

// 把源图以 cover 方式裁切填满目标像素尺寸的画布
export function fitCover(img: HTMLImageElement, pxW: number, pxH: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(pxW));
  c.height = Math.max(1, Math.round(pxH));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  const { sx, sy, sw, sh } = coverSrcRect(img.naturalWidth, img.naturalHeight, pxW, pxH);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

export interface BuildOpts {
  sources: HTMLImageElement[];
  layout: LayoutResult;
  itemW: number;
  itemH: number;
  mode: 'single' | 'multi';
  dpi?: number;
}

// 生成一张纸上每个单元格的图像画布（300DPI 输出质量）
export function buildSheetImages(opts: BuildOpts): HTMLCanvasElement[] {
  const dpi = opts.dpi ?? 300;
  const pxW = (opts.itemW / 25.4) * dpi;
  const pxH = (opts.itemH / 25.4) * dpi;
  const arr: HTMLCanvasElement[] = [];
  if (opts.mode === 'single') {
    const src = opts.sources[0];
    if (!src) return arr;
    const c = fitCover(src, pxW, pxH);
    for (let i = 0; i < opts.layout.perSheet; i++) arr.push(c); // 复用同一画布
  } else {
    for (let i = 0; i < opts.layout.perSheet; i++) {
      const src = opts.sources[i % opts.sources.length];
      if (!src) break;
      arr.push(fitCover(src, pxW, pxH));
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
  sheets: HTMLCanvasElement[];
  scale: number; // 预览像素/毫米
}

// 在给定 canvas 上绘制整张排版预览
export function renderPreview(canvas: HTMLCanvasElement, o: PreviewOpts): void {
  canvas.width = Math.round(o.paper.w * o.scale);
  canvas.height = Math.round(o.paper.h * o.scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cellW = o.itemW * o.scale;
  const cellH = o.itemH * o.scale;
  const gapPx = o.gap * o.scale;
  const totalW = o.layout.cols * cellW + (o.layout.cols - 1) * gapPx;
  const totalH = o.layout.rows * cellH + (o.layout.rows - 1) * gapPx;
  const startX = o.margin * o.scale;
  const startY = o.margin * o.scale;
  void totalW;
  void totalH; // 居中由 margin 决定，这里仅占位

  let idx = 0;
  for (let r = 0; r < o.layout.rows; r++) {
    for (let c = 0; c < o.layout.cols; c++) {
      const x = startX + c * (cellW + gapPx);
      const y = startY + r * (cellH + gapPx);
      if (o.cutLines) {
        ctx.strokeStyle = 'rgba(0,0,0,0.28)';
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 0.6;
        ctx.strokeRect(x, y, cellW, cellH);
        ctx.setLineDash([]);
      }
      const img = o.sheets[idx++];
      if (img) ctx.drawImage(img, x, y, cellW, cellH);
    }
  }
}
