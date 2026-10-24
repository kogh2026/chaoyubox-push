import { jsPDF } from 'jspdf';
import { renderPreview, type LayoutResult, type PaperSize } from './cardLayout';

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
  pages: HTMLCanvasElement[][];
  fileName?: string;
}

// 多页网格排版导出 PDF（每页一张纸）
export function exportGridPdf(o: GridPdfOpts): void {
  const orient = o.paper.w > o.paper.h ? 'l' : 'p';
  const doc = new jsPDF({
    unit: 'mm',
    format: [o.paper.w, o.paper.h],
    orientation: orient,
    compress: true,
  });
  o.pages.forEach((cells, p) => {
    if (p > 0) doc.addPage([o.paper.w, o.paper.h], orient);
    let idx = 0;
    for (let r = 0; r < o.layout.rows; r++) {
      for (let c = 0; c < o.layout.cols; c++) {
        const x = o.margin + c * (o.itemW + o.gap);
        const y = o.margin + r * (o.itemH + o.gap);
        if (o.cutLines) {
          doc.setDrawColor(190);
          doc.setLineWidth(0.1);
          doc.rect(x, y, o.itemW, o.itemH);
        }
        const img = cells[idx++];
        if (img) {
          try {
            doc.addImage(img as unknown as HTMLCanvasElement, 'JPEG', x, y, o.itemW, o.itemH, undefined, 'FAST');
          } catch {
            doc.addImage(img as unknown as HTMLCanvasElement, 'PNG', x, y, o.itemW, o.itemH);
          }
        }
      }
    }
  });
  doc.save(o.fileName ?? '拼版.pdf');
}
