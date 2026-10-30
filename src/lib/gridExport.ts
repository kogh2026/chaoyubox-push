import { renderPreview, type CanvasLike, type LayoutResult, type PaperSize } from './cardLayout';
import {
  writeGridPages,
  defaultPdfDoc,
  type PdfDocFactory,
} from './sheetPdf';

export interface GridPageOpts {
  paper: PaperSize;
  layout: LayoutResult;
  itemW: number;
  itemH: number;
  margin: number;
  gap: number;
  cutLines: boolean;
  cells: HTMLCanvasElement[];
  scale: number;
}

// 把一页排版渲染到预览 canvas（复用证卡拼版的预览绘制）
export function renderGridPage(canvas: HTMLCanvasElement, o: GridPageOpts): void {
  renderPreview(canvas, {
    paper: o.paper,
    layout: o.layout,
    itemW: o.itemW,
    itemH: o.itemH,
    margin: o.margin,
    gap: o.gap,
    cutLines: o.cutLines,
    sheets: o.cells,
    scale: o.scale,
  });
}

export interface GridPdfOpts {
  paper: PaperSize;
  layout: LayoutResult;
  itemW: number;
  itemH: number;
  margin: number;
  gap: number;
  cutLines: boolean;
  pages: CanvasLike[][];
  fileName?: string;
}

/**
 * 多页网格排版导出 PDF（每页一张纸）。
 * 桌面端优先返回字节交给主进程做 tmp + rename 原子写盘；
 * 拿不到字节（测试桩 / 环境限制）时退回原来的下载行为，返回 null。
 */
export function exportGridPdf(o: GridPdfOpts, createDoc: PdfDocFactory = defaultPdfDoc): Uint8Array | null {
  const doc = createDoc(o.paper.w, o.paper.h);
  writeGridPages(doc, {
    paper: o.paper,
    layout: o.layout,
    itemW: o.itemW,
    itemH: o.itemH,
    margin: o.margin,
    gap: o.gap,
    cutLines: o.cutLines,
    pages: o.pages,
  });
  try {
    const ab = doc.output?.('arraybuffer');
    if (ab) return new Uint8Array(ab);
  } catch {
    /* 拿不到字节就走下载路径 */
  }
  doc.save(o.fileName ?? '拼版.pdf');
  return null;
}
