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
        try {
          doc.addImage(img, 'JPEG', rc.x, rc.y, rc.w, rc.h, undefined, 'FAST');
        } catch {
          doc.addImage(img, 'PNG', rc.x, rc.y, rc.w, rc.h);
        }
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
export function exportSheetPdf(o: ExportOpts, createDoc: PdfDocFactory = defaultPdfDoc): void {
  const doc = createDoc(o.paper.w, o.paper.h);
  writeGridPages(doc, { ...o, pages: [o.sheets] });
  doc.save(o.fileName ?? '证卡拼版.pdf');
}

// 增强模式：把渲染好的整页画布逐页写入 PDF
export function exportPagesPdf(
  paperW: number,
  paperH: number,
  pages: CanvasLike[],
  fileName: string,
  createDoc: PdfDocFactory = defaultPdfDoc,
): void {
  if (pages.length === 0) return;
  const doc = createDoc(paperW, paperH);
  pages.forEach((pg, i) => {
    if (i > 0) doc.addPage([paperW, paperH], paperW > paperH ? 'l' : 'p');
    try {
      doc.addImage(pg, 'JPEG', 0, 0, paperW, paperH, undefined, 'FAST');
    } catch {
      doc.addImage(pg, 'PNG', 0, 0, paperW, paperH);
    }
  });
  doc.save(fileName);
}
