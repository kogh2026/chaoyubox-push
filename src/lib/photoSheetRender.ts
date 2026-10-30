/**
 * 拼版渲染层：把 photoSheet 的 mm 几何画成像素。
 *
 * 之所以只做「mm → px」这一件事：
 *   - 预览用 2.2 px/mm，导出用 300dpi（11.8 px/mm），同一份排版结果两处共用，不会出现「预览一套、PDF 另一套」；
 *   - PDF 走「整页画布 → 图片写满整页」的路径（sheetPdf.exportPagesPdf），
 *     因为拼版里有跨行的裁切线和任意位置的行高，用矢量逐格重建反而容易与预览产生毫米级偏差。
 *
 * 字体大小同样以 mm 定义（4.2mm ≈ 12pt），所以在任何 DPI 下字与图的相对比例都一致。
 */

import { CAPTION_FONT_MM, type SheetPage } from './photoSheet';

/** 单张源图（只要能被 drawImage 接受即可，测试里可传桩） */
export interface SheetImageLike {
  width: number;
  height: number;
}

export interface SheetRenderOpts {
  /** 每毫米多少像素：预览 2.2，导出 300/25.4 ≈ 11.81 */
  pxPerMm: number;
  /** 源图查表 */
  imageOf: (sourceId: string) => CanvasImageSource | null;
  /** 图片描边（浅色截图印在白纸上也能看清边界） */
  border?: boolean;
  /** 水印文字；null/空串不画 */
  watermark?: string | null;
}

const CUT_LINE = '#9aa6b2';
const CAPTION_COLOR = '#334155';
const FOOTER_COLOR = '#64748b';
const BORDER_COLOR = '#cbd5e1';

function mmToPx(mm: number, pxPerMm: number): number {
  return mm * pxPerMm;
}

/**
 * 渲染一页。
 * 注意：调用方负责把 canvas 的宽高设成 `page.widthMm * pxPerMm` 等比例尺寸；
 * 这里只在尺寸不符时纠正，避免把上一页的尺寸带进来。
 */
export function renderSheetPage(
  canvas: HTMLCanvasElement,
  page: SheetPage,
  opts: SheetRenderOpts,
): void {
  const k = opts.pxPerMm;
  const w = Math.max(1, Math.round(page.widthMm * k));
  const h = Math.max(1, Math.round(page.heightMm * k));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);

  for (const part of page.parts) {
    const img = opts.imageOf(part.sourceId);
    if (!img) continue;
    const dw = mmToPx(part.widthMm, k);
    const dh = mmToPx(part.heightMm, k);
    const dx = mmToPx(part.x, k);
    const dy = mmToPx(part.y, k);
    const srcW = (img as { naturalWidth?: number }).naturalWidth ?? (img as SheetImageLike).width;

    ctx.save();
    if (part.mirrored) {
      // 水平镜像：热转印纸要反过来印
      ctx.translate(dx + dw, dy);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, part.sy, srcW, part.sh, 0, 0, dw, dh);
    } else {
      ctx.drawImage(img, 0, part.sy, srcW, part.sh, dx, dy, dw, dh);
    }
    ctx.restore();

    if (opts.border) {
      ctx.strokeStyle = BORDER_COLOR;
      ctx.lineWidth = Math.max(0.6, mmToPx(0.2, k));
      ctx.strokeRect(dx, dy, dw, dh);
    }
  }

  // 图注：字号以 mm 定义，任何 DPI 下视觉一致
  const fontPx = mmToPx(CAPTION_FONT_MM, k);
  ctx.fillStyle = CAPTION_COLOR;
  ctx.font = `${fontPx}px system-ui, "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const part of page.parts) {
    if (!part.caption) continue;
    ctx.fillText(part.caption, mmToPx(part.captionX, k), mmToPx(part.captionY, k));
  }

  // 裁切线：细虚线，颜色刻意压淡（不要抢照片的注意力）
  if (page.cutLines) {
    const { xs, ys } = page.cutLines;
    if (xs.length > 0 || ys.length > 0) {
      ctx.save();
      ctx.strokeStyle = CUT_LINE;
      ctx.lineWidth = Math.max(0.5, mmToPx(0.12, k));
      ctx.setLineDash([mmToPx(2.4, k), mmToPx(1.6, k)]);
      for (const line of xs) {
        ctx.beginPath();
        ctx.moveTo(mmToPx(line.x, k), mmToPx(line.y1, k));
        ctx.lineTo(mmToPx(line.x, k), mmToPx(line.y2, k));
        ctx.stroke();
      }
      for (const y of ys) {
        ctx.beginPath();
        ctx.moveTo(0, mmToPx(y, k));
        ctx.lineTo(w, mmToPx(y, k));
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  if (page.footer) {
    ctx.fillStyle = FOOTER_COLOR;
    ctx.font = `${mmToPx(3.4, k)}px system-ui, "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(page.footer, w / 2, h - mmToPx(2.5, k));
  }

  const mark = (opts.watermark ?? '').trim();
  if (mark) {
    // 斜向平铺：预览与导出用同一套画法，避免「预览没水印、导出全是水印」
    ctx.save();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.10)';
    const size = mmToPx(9, k);
    ctx.font = `600 ${size}px system-ui, "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const stepX = size * 7;
    const stepY = size * 5;
    ctx.rotate(-Math.PI / 6);
    for (let y = -h; y < h * 2; y += stepY) {
      for (let x = -w; x < w * 2; x += stepX) {
        ctx.fillText(mark, x, y);
      }
    }
    ctx.restore();
  }
}

/** 导出用的离屏画布（整页位图） */
export function renderSheetPageToCanvas(
  page: SheetPage,
  opts: SheetRenderOpts,
  doc: Document = document,
): HTMLCanvasElement {
  const canvas = doc.createElement('canvas');
  renderSheetPage(canvas, page, opts);
  return canvas;
}

/** 300dpi 的「每毫米像素」= 11.811；导出与打印都用它，保证 PDF 里是 300dpi 位图 */
export const EXPORT_PX_PER_MM = 300 / 25.4;
