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
  const usableW = paperW - 2 * margin;
  const usableH = paperH - 2 * margin;
  const cols = Math.max(1, Math.floor((usableW + gap) / (itemW + gap)));
  const rows = Math.max(1, Math.floor((usableH + gap) / (itemH + gap)));
  return { cols, rows, perSheet: cols * rows };
}

// 把源图以 cover 方式裁切填满目标像素尺寸的画布
export function fitCover(img: HTMLImageElement, pxW: number, pxH: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(pxW));
  c.height = Math.max(1, Math.round(pxH));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  const sr = img.naturalWidth / img.naturalHeight;
  const tr = pxW / pxH;
  let sx = 0,
    sy = 0,
    sw = img.naturalWidth,
    sh = img.naturalHeight;
  if (sr > tr) {
    sw = sh * tr;
    sx = (img.naturalWidth - sw) / 2;
  } else {
    sh = sw / tr;
    sy = (img.naturalHeight - sh) / 2;
  }
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
