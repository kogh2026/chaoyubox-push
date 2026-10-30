import { jsPDF } from 'jspdf';
import { cellRects, type CanvasLike, type LayoutResult, type PaperSize } from './cardLayout';

/** 最小 jsPDF 接口（测试可传桩；真实 jsPDF 实例满足） */
export interface PdfDocLike {
  addPage(size: [number, number], orient: 'l' | 'p'): void;
  rect(x: number, y: number, w: number, h: number): void;
  addImage(
    image: unknown,
    format: string,
    x: number,
    y: number,
    w: number,
    h: number,
    alias?: string,
    compression?: string,
  ): void;
  setDrawColor(channel: number): void;
  setLineWidth(width: number): void;
  save(filename?: string): void;
  /** 可选：直接产出字节（jsPDF 实例具备）。用于交给主进程做 tmp + rename 原子写盘，
   *  没有它时退回 doc.save(filename) 的浏览器下载行为。 */
  output?: (type: 'arraybuffer') => ArrayBuffer;
}

/** 毫米单位文档工厂（默认真实 jsPDF；测试注入桩） */
export type PdfDocFactory = (w: number, h: number) => PdfDocLike;

export const defaultPdfDoc: PdfDocFactory = (w, h) =>
  new jsPDF({
    unit: 'mm',
    format: [w, h],
    orientation: w > h ? 'l' : 'p',
    compress: true,
  }) as unknown as PdfDocLike;

const JPEG_Q = 0.92;

/** 保证以 JPEG 写入 PDF：canvas 先转 JPEG dataURL（体积可控，不再静默回退 PNG）。
 *  若 JPEG 编码真的失败（极少见，如跨域污染画布），直接抛出由上层提示，而非默默把体积炸弹塞回去。 */
function addImageJpeg(
  doc: PdfDocLike,
  img: CanvasLike | string,
  x: number,
  y: number,
  w: number,
  h: number,
  alias?: string,
  compression?: string,
): void {
  let payload: unknown = img;
  const c = img as { toDataURL?: (t: string, q?: number) => string };
  if (typeof c.toDataURL === 'function') {
    payload = c.toDataURL('image/jpeg', JPEG_Q); // 保证 JPEG
  }
  doc.addImage(payload, 'JPEG', x, y, w, h, alias, compression);
}

/** 格子页写入 PDF 的共享实现（mm 坐标 = scale 1 的 cellRects）。
 *  exportSheetPdf / exportGridPdf 共用；doc 可注入便于测试。 */
export function writeGridPages(
  doc: PdfDocLike,
  o: {
    paper: PaperSize;
    layout: LayoutResult;
    itemW: number;
    itemH: number;
    margin: number;
    gap: number;
    cutLines: boolean;
    pages: CanvasLike[][];
  },
): void {
  const orient = o.paper.w > o.paper.h ? 'l' : 'p';
  o.pages.forEach((cells, p) => {
    if (p > 0) doc.addPage([o.paper.w, o.paper.h], orient);
    cellRects({
      cols: o.layout.cols,
      rows: o.layout.rows,
      itemW: o.itemW,
      itemH: o.itemH,
      margin: o.margin,
      gap: o.gap,
      scale: 1, // PDF 单位即 mm
    }).forEach((rc, idx) => {
      if (o.cutLines) {
        doc.setDrawColor(190);
        doc.setLineWidth(0.1);
        doc.rect(rc.x, rc.y, rc.w, rc.h);
      }
      const img = cells[idx];
      if (img) {
        addImageJpeg(doc, img, rc.x, rc.y, rc.w, rc.h, undefined, 'FAST');
      }
    });
  });
}

export interface ExportOpts {
  paper: PaperSize;
  layout: LayoutResult;
  itemW: number;
  itemH: number;
  margin: number;
  gap: number;
  cutLines: boolean;
  sheets: CanvasLike[];
  fileName?: string;
}

// 把一张排版好的纸导出为 PDF（mm 单位，300DPI 图像质量）
/**
 * 单页拼版导出。优先返回字节交给主进程原子写盘；
 * 拿不到字节时退回原来的下载行为，返回 null。
 */
export function exportSheetPdf(
  o: ExportOpts,
  createDoc: PdfDocFactory = defaultPdfDoc,
): Uint8Array | null {
  const doc = createDoc(o.paper.w, o.paper.h);
  writeGridPages(doc, { ...o, pages: [o.sheets] });
  try {
    const ab = doc.output?.('arraybuffer');
    if (ab) return new Uint8Array(ab);
  } catch {
    /* 拿不到字节就走下载路径 */
  }
  doc.save(o.fileName ?? '证卡拼版.pdf');
  return null;
}

/**
 * 增强模式：把渲染好的整页画布逐页写入 PDF。
 * 桌面端优先返回字节，交给主进程做 tmp + rename 原子写盘；
 * 拿不到字节（测试桩 / 环境限制）时退回原来的下载行为，返回 null。
 */
export function exportPagesPdf(
  paperW: number,
  paperH: number,
  pages: CanvasLike[],
  fileName: string,
  createDoc: PdfDocFactory = defaultPdfDoc,
): Uint8Array | null {
  if (pages.length === 0) return null;
  const doc = createDoc(paperW, paperH);
  pages.forEach((pg, i) => {
    if (i > 0) doc.addPage([paperW, paperH], paperW > paperH ? 'l' : 'p');
    addImageJpeg(doc, pg, 0, 0, paperW, paperH, undefined, 'FAST');
  });
  try {
    const ab = doc.output?.('arraybuffer');
    if (ab) return new Uint8Array(ab);
  } catch {
    /* 拿不到字节就走下载路径 */
  }
  doc.save(fileName);
  return null;
}
