import { jsPDF } from 'jspdf';
import type { LayoutResult, PaperSize } from './cardLayout';

export interface ExportOpts {
  paper: PaperSize;
  layout: LayoutResult;
  itemW: number;
  itemH: number;
  margin: number;
  gap: number;
  cutLines: boolean;
  sheets: HTMLCanvasElement[];
  fileName?: string;
}

// 把一张排版好的纸导出为 PDF（mm 单位，300DPI 图像质量）
export function exportSheetPdf(o: ExportOpts): void {
  const doc = new jsPDF({
    unit: 'mm',
    format: [o.paper.w, o.paper.h],
    orientation: o.paper.w > o.paper.h ? 'l' : 'p',
    compress: true,
  });
  const cellW = o.itemW;
  const cellH = o.itemH;
  const startX = o.margin;
  const startY = o.margin;
  let idx = 0;
  for (let r = 0; r < o.layout.rows; r++) {
    for (let c = 0; c < o.layout.cols; c++) {
      const x = startX + c * (cellW + o.gap);
      const y = startY + r * (cellH + o.gap);
      if (o.cutLines) {
        doc.setDrawColor(190);
        doc.setLineWidth(0.1);
        doc.rect(x, y, cellW, cellH);
      }
      const img = o.sheets[idx++];
      if (img) {
        try {
          doc.addImage(img as unknown as HTMLCanvasElement, 'JPEG', x, y, cellW, cellH, undefined, 'FAST');
        } catch {
          doc.addImage(img as unknown as HTMLCanvasElement, 'PNG', x, y, cellW, cellH);
        }
      }
    }
  }
  doc.save(o.fileName ?? '证卡拼版.pdf');
}

// 增强模式：把渲染好的整页画布逐页写入 PDF
export function exportPagesPdf(
  paperW: number,
  paperH: number,
  pages: HTMLCanvasElement[],
  fileName: string,
): void {
  if (pages.length === 0) return;
  const doc = new jsPDF({
    unit: 'mm',
    format: [paperW, paperH],
    orientation: paperW > paperH ? 'l' : 'p',
    compress: true,
  });
  pages.forEach((pg, i) => {
    if (i > 0) doc.addPage([paperW, paperH], paperW > paperH ? 'l' : 'p');
    try {
      doc.addImage(pg as unknown as HTMLCanvasElement, 'JPEG', 0, 0, paperW, paperH, undefined, 'FAST');
    } catch {
      doc.addImage(pg as unknown as HTMLCanvasElement, 'PNG', 0, 0, paperW, paperH);
    }
  });
  doc.save(fileName);
}
