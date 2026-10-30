// 批注模块：通过 pdf-lib 底层对象创建真实 PDF 注释（非图片叠加，
// 在阅读器中可选中 / 删除 / 改色）。支持高亮、下划线、删除线、方框、便签。
import { PDFDocument, PDFArray, PDFDict, PDFName, PDFNumber, PDFString } from 'pdf-lib';

export type AnnotKind = 'highlight' | 'underline' | 'strikeout' | 'square' | 'note';

export interface AnnotItem {
  page: number; // 1 起
  kind: AnnotKind;
  // PDF 用户空间坐标（左下原点，pt）
  rect: { x: number; y: number; w: number; h: number };
  color: [number, number, number];
  opacity?: number; // 高亮/下划线/删除线的不透明度 0-1
  note?: string; // 批注内容（便签的文本）
}

const SUBTYPE: Record<AnnotKind, string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'StrikeOut',
  square: 'Square',
  note: 'Text',
};

const MARKUP: AnnotKind[] = ['highlight', 'underline', 'strikeout'];

export function addAnnotations(doc: PDFDocument, items: AnnotItem[]): void {
  const ctx = doc.context;
  for (const it of items) {
    if (it.page < 1 || it.page > doc.getPageCount()) continue;
    const page = doc.getPage(it.page - 1);
    const annotsName = PDFName.of('Annots');
    let annots = page.node.get(annotsName) as PDFArray | undefined;
    if (!annots) {
      annots = ctx.obj([]) as PDFArray;
      page.node.set(annotsName, annots);
    }
    const x1 = it.rect.x;
    const y1 = it.rect.y + it.rect.h; // 上边
    const x2 = it.rect.x + it.rect.w;
    const y2 = it.rect.y; // 下边
    const dict = ctx.obj({
      Type: PDFName.of('Annot'),
      Subtype: PDFName.of(SUBTYPE[it.kind]),
      Rect: ctx.obj([x1, y2, x2, y1]),
      C: ctx.obj(it.color),
      F: PDFNumber.of(4), // Print 标志
    }) as PDFDict;
    if (MARKUP.includes(it.kind)) {
      dict.set(PDFName.of('QuadPoints'), ctx.obj([x1, y1, x2, y1, x2, y2, x1, y2]));
    }
    if (it.kind === 'note') {
      dict.set(PDFName.of('Name'), PDFName.of('Note'));
    }
    if (it.opacity !== undefined && it.opacity < 1) {
      dict.set(PDFName.of('CA'), PDFNumber.of(Math.max(0.05, Math.min(1, it.opacity))));
    }
    if (it.note && it.note.trim()) {
      dict.set(PDFName.of('Contents'), PDFString.of(it.note.trim()));
      dict.set(PDFName.of('T'), PDFString.of('批注'));
    }
    // 注册为间接对象：真实 PDF 里批注字典几乎都是间接引用，
    // 部分阅读器/校验器对直接内联的批注字典兼容性较差
    annots.push(ctx.register(dict));
  }
}

export async function annotatePdf(data: Uint8Array, items: AnnotItem[]): Promise<Uint8Array> {
  if (items.length === 0) throw new Error('还没有添加任何批注');
  const doc = await PDFDocument.load(data, { ignoreEncryption: true });
  addAnnotations(doc, items);
  return doc.save();
}

// 预览坐标（像素，左上原点）-> PDF 坐标（pt，左下原点）
export function pxToPdf(
  px: number,
  py: number,
  scale: number,
  pageHeightPt: number,
): { x: number; y: number } {
  return { x: px / scale, y: pageHeightPt - py / scale };
}
