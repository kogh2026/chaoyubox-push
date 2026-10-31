// 矢量拼版导出（A2）：照片按「同源图 + 同风格 + 同输出尺寸」去重后只嵌一次，
// 裁切口与水印走矢量绘制 —— 放大不糊、体积显著小于整页位图。
// 整页位图路径（sheetPdf.exportPagesPdf）保留为预览与兜底。
import { PDFDocument, rgb } from 'pdf-lib';
import {
  colorFilter,
  coverDraw,
  roundRectPath,
  type ColorMode,
  type Placement,
} from './idCardLayout';
import { embedCjkFont } from './cjkFont';
import { saveBytes, type SaveOutcome } from './exporter';

const MM = 72 / 25.4; // mm -> pt

export interface VectorCell {
  img: HTMLImageElement;
  rotation: number; // 0/90/180/270
}

export interface VectorSheetStyle {
  colorMode: ColorMode;
  sat: number;
  sharpen: number;
  cropMarks?: boolean; // 蚂蚁线裁切口（与预览同源）
  wm?: { on: boolean; text: string };
  cornerRadiusMm?: number; // 卡片圆角半径（mm）；undefined 由渲染端按自然比例处理
}

/** 单元格编码签名：同源图 + 同风格 + 同输出像素尺寸 + 同圆角 → 复用同一份 JPEG（去重依据） */
export function cellFingerprint(
  c: VectorCell,
  pxW: number,
  pxH: number,
  filter: string,
  radiusMm = 0,
): string {
  const img = c.img as HTMLImageElement & { currentSrc?: string };
  const src = img.currentSrc || img.src || '';
  return `${src}|${c.rotation}|${Math.round(pxW)}x${Math.round(pxH)}|${filter}|r${Math.round(radiusMm * 100) / 100}`;
}

export interface VectorPlanItem {
  page: number;
  cell: number;
  rect: Placement; // mm，左上原点（与 pagePlacements 一致）
  fingerprint: string;
  pxW: number;
  pxH: number;
}

export interface VectorPlan {
  items: VectorPlanItem[];
  uniqueImages: number; // 去重后实际需要嵌入的图片数
  totalCells: number; // 总格子数（不去重）
}

/** 纯函数（可单测）：把「页 × 格」的图与 mm 布局矩形求交，产出绘制计划与去重计数。 */
export function planVectorPages(
  pages: VectorCell[][],
  placements: Placement[],
  dpi = 300,
  style?: VectorSheetStyle,
): VectorPlan {
  const filter = style ? colorFilter(style.colorMode, style.sat, style.sharpen) : '';
  const radiusMm = style?.cornerRadiusMm ?? 0;
  const items: VectorPlanItem[] = [];
  const seen = new Set<string>();
  pages.forEach((cells, pi) => {
    (cells ?? []).forEach((cell, ci) => {
      const rect = placements[ci];
      if (!rect || !cell || !cell.img) return;
      const pxW = (rect.w / 25.4) * dpi;
      const pxH = (rect.h / 25.4) * dpi;
      const fp = cellFingerprint(cell, pxW, pxH, filter, radiusMm);
      if (!seen.has(fp)) seen.add(fp);
      items.push({ page: pi, cell: ci, rect, fingerprint: fp, pxW, pxH });
    });
  });
  return { items, uniqueImages: seen.size, totalCells: items.length };
}

/** 纯函数（可单测）：mm 矩形（左上原点）→ 绘制矩形（原点左下，y 翻转）。 */
export function toPdfRect(rect: Placement, paperH: number): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: rect.x * MM,
    y: (paperH - rect.y - rect.h) * MM,
    width: rect.w * MM,
    height: rect.h * MM,
  };
}

/* ===== 文档抽象：真实 pdf-lib 适配器 + 测试桩 ===== */

export interface VectorPageLike {
  drawImage(img: unknown, o: { x: number; y: number; width: number; height: number }): void;
  drawLine(o: {
    start: { x: number; y: number };
    end: { x: number; y: number };
    color?: unknown;
    thickness?: number;
    opacity?: number;
    dashArray?: number[];
  }): void;
  drawText(
    t: string,
    o: {
      x: number;
      y: number;
      size: number;
      font?: unknown;
      color?: unknown;
      opacity?: number;
      rotate?: unknown;
    },
  ): void;
}

export interface VectorDocLike {
  addPage(size: [number, number]): VectorPageLike;
  embedJpg(bytes: Uint8Array): Promise<unknown>;
  embedCjkFont(): Promise<unknown | null>;
  save(): Promise<Uint8Array>;
}

export type VectorDocFactory = () => Promise<VectorDocLike>;

/** 真实实现：pdf-lib 文档适配到 VectorDocLike */
export const pdfLibVectorDoc: VectorDocFactory = async () => {
  const doc = await PDFDocument.create();
  return {
    addPage: (size) => doc.addPage(size) as unknown as VectorPageLike,
    embedJpg: (bytes) => doc.embedJpg(bytes),
    embedCjkFont: () => embedCjkFont(doc),
    save: () => doc.save(),
  };
};

/** 单元格编码器：把一张卡（含旋转/滤镜/圆角）编码为 JPEG 字节。可注入以便无 canvas 环境测试。 */
export type EncodeCell = (
  cell: VectorCell,
  pxW: number,
  pxH: number,
  filter: string,
  quality: number,
  radiusPx?: number,
) => Promise<Uint8Array>;

// 默认实现：与预览同源，用 coverDraw 保证「所见即所得」
const defaultEncodeCell: EncodeCell = async (cell, pxW, pxH, filter, quality, radiusPx = 0) => {
  if (typeof document === 'undefined') throw new Error('矢量导出需要浏览器画布环境');
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(pxW));
  canvas.height = Math.max(1, Math.round(pxH));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布上下文');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const img = cell.img;
  ctx.save();
  if (radiusPx > 0.5) {
    const r = Math.min(radiusPx, canvas.width / 2, canvas.height / 2);
    roundRectPath(ctx, 0, 0, canvas.width, canvas.height, r);
    ctx.clip();
  }
  coverDraw(ctx, img, img.naturalWidth, img.naturalHeight, cell.rotation, 0, 0, canvas.width, canvas.height, filter);
  ctx.restore();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
  canvas.width = 0; // 及时释放
  canvas.height = 0;
  if (!blob) throw new Error('单元格 JPEG 编码失败');
  return new Uint8Array(await blob.arrayBuffer());
};

export interface VectorSheetOpts {
  paper: { w: number; h: number }; // mm
  placements: Placement[]; // mm
  pages: VectorCell[][]; // 每页每格的图
  style: VectorSheetStyle;
  dpi?: number; // 默认 300
  quality?: number; // 默认 0.92
  encodeCell?: EncodeCell; // 注入：便于无 canvas 环境（Node 单测）
  createDoc?: VectorDocFactory; // 注入：便于断言绘制调用
}

/** 矢量拼版：生成 PDF 字节。图像去重嵌入，裁切口/水印为矢量。 */
export async function exportVectorSheetPdf(o: VectorSheetOpts): Promise<Uint8Array> {
  if (o.pages.length === 0) throw new Error('没有可导出的页面');
  const dpi = o.dpi ?? 300;
  const quality = o.quality ?? 0.92;
  const filter = colorFilter(o.style.colorMode, o.style.sat, o.style.sharpen);

  const doc = await (o.createDoc ?? pdfLibVectorDoc)();
  const pw = o.paper.w * MM;
  const ph = o.paper.h * MM;

  // 指纹 -> 已嵌入图像：去重关键，同一张照片只编码/嵌入一次
  const cache = new Map<string, unknown>();

  const wmText = o.style.wm?.on ? (o.style.wm.text ?? '').trim() : '';
  let font: unknown = null;
  if (wmText) {
    try {
      font = await doc.embedCjkFont();
    } catch {
      font = null;
    }
  }

  for (let pi = 0; pi < o.pages.length; pi++) {
    const page = doc.addPage([pw, ph]);
    const cells = o.pages[pi] ?? [];

    for (let ci = 0; ci < cells.length; ci++) {
      const rect = o.placements[ci];
      const cell = cells[ci];
      if (!rect || !cell || !cell.img) continue;

      const pxW = (rect.w / 25.4) * dpi;
      const pxH = (rect.h / 25.4) * dpi;
      const radiusPx = (o.style.cornerRadiusMm ?? 0) * (dpi / 25.4);
      const fp = cellFingerprint(cell, pxW, pxH, filter, o.style.cornerRadiusMm ?? 0);
      let img = cache.get(fp);
      if (img === undefined) {
        const bytes = await (o.encodeCell ?? defaultEncodeCell)(
          cell,
          pxW,
          pxH,
          filter,
          quality,
          radiusPx,
        );
        img = await doc.embedJpg(bytes);
        cache.set(fp, img);
      }
      page.drawImage(img, toPdfRect(rect, o.paper.h));
    }

    // 矢量裁切口：四角外缘短虚线（放大仍锐利）
    if (o.style.cropMarks) {
      for (const p of o.placements) {
        const tick = 2.5; // mm
        const corners: [number, number, number, number][] = [
          [p.x, p.y, 1, 1],
          [p.x + p.w, p.y, -1, 1],
          [p.x + p.w, p.y + p.h, -1, -1],
          [p.x, p.y + p.h, 1, -1],
        ];
        for (const [cx, cy, dx, dy] of corners) {
          const color = rgb(80 / 255, 80 / 255, 80 / 255);
          page.drawLine({
            start: { x: cx * MM, y: ph - cy * MM },
            end: { x: (cx + dx * tick) * MM, y: ph - cy * MM },
            color,
            thickness: 0.18,
            opacity: 0.85,
            dashArray: [0.9 * MM, 0.7 * MM],
          });
          page.drawLine({
            start: { x: cx * MM, y: ph - cy * MM },
            end: { x: cx * MM, y: ph - (cy + dy * tick) * MM },
            color,
            thickness: 0.18,
            opacity: 0.85,
            dashArray: [0.9 * MM, 0.7 * MM],
          });
        }
      }
    }

    // 矢量水印：平铺文字，放大清晰
    if (font && wmText) {
      const step = Math.max(pw, ph) / 3;
      const size = step / 6;
      const span = (pw + ph) * 1.2;
      for (let y = -span / 2; y < span / 2; y += step) {
        for (let x = -span / 2; x < span / 2; x += step * 2.2) {
          page.drawText(wmText, {
            x: pw / 2 + x,
            y: ph / 2 + y,
            size,
            font,
            color: rgb(0, 0, 0),
            opacity: 0.07,
            rotate: { type: 'degrees', angle: -25 },
          });
        }
      }
    }
  }

  return doc.save();
}

/**
 * 便捷：生成矢量拼版 PDF 并导出。
 * 桌面端走主进程 tmp + rename 原子写盘并返回真实路径，浏览器环境回退下载。
 * 名字带 save 而非 download —— 桌面端根本不走浏览器下载。
 */
export async function saveVectorSheetPdf(o: VectorSheetOpts, fileName: string): Promise<SaveOutcome> {
  const bytes = await exportVectorSheetPdf(o);
  return saveBytes(bytes, fileName, { filters: [{ name: 'PDF 文档', extensions: ['pdf'] }] });
}
