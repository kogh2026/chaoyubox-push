// PDF 核心操作库：合并 / 拆分 / 旋转 / 统一页面大小 / 转图片。
// 与打印流水线衔接：处理结果可直接进批量打印（File 对象）或图片拼版。
// 浏览器侧实现：pdf-lib（结构操作，无损）+ pdfjs-dist（栅格化）。
import { PDFDocument, degrees } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/* ===== 页码范围解析（纯函数） ===== */

export interface PageRange {
  from: number; // 1 起，含
  to: number; // 含
}

// 解析 "1-3,5,8-10" / "" / "all"；越界或非法输入抛 Error（消息面向用户）
export function parsePageRanges(input: string, total: number): PageRange[] {
  const s = (input || '').trim();
  if (!s || s.toLowerCase() === 'all') return total > 0 ? [{ from: 1, to: total }] : [];
  if (!/^\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*$/.test(s)) {
    throw new Error('页码范围格式不对，示例：1-3,5,8-10');
  }
  const out: PageRange[] = [];
  for (const part of s.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error(`无法识别的页码范围「${part.trim()}」`);
    let from = parseInt(m[1], 10);
    let to = m[2] === undefined ? from : parseInt(m[2], 10);
    if (from < 1 || to < 1 || from > total || to > total) {
      throw new Error(`页码超出范围：本文档共 ${total} 页`);
    }
    if (from > to) [from, to] = [to, from]; // 容忍 "5-3" 写法
    out.push({ from, to });
  }
  return out;
}

// 范围 -> 0 起页索引数组（展开为逐页）
export function expandRanges(ranges: PageRange[]): number[] {
  const idx: number[] = [];
  for (const r of ranges) {
    for (let p = r.from; p <= r.to; p++) idx.push(p - 1);
  }
  return idx;
}

// 拆分结果命名：原名_p1-3.pdf
export function splitName(base: string, r: PageRange): string {
  const stem = base.replace(/\.pdf$/i, '');
  return r.from === r.to ? `${stem}_p${r.from}.pdf` : `${stem}_p${r.from}-${r.to}.pdf`;
}

/* ===== 统一页面大小的缩放计算（纯函数） ===== */

export type FitMode = 'contain' | 'cover' | 'stretch';

// 源页尺寸 -> 目标框内的绘制尺寸（pt）。contain 全包容留白，cover 填满裁切，
// stretch 双向拉满。旋转 90/270 的页先交换宽高再算。
export function computeFitScale(
  srcW: number,
  srcH: number,
  tgtW: number,
  tgtH: number,
  mode: FitMode,
): { w: number; h: number } {
  if (!(srcW > 0) || !(srcH > 0) || !(tgtW > 0) || !(tgtH > 0)) {
    throw new Error('页面尺寸必须大于 0');
  }
  if (mode === 'stretch') return { w: tgtW, h: tgtH };
  const k = mode === 'contain' ? Math.min(tgtW / srcW, tgtH / srcH) : Math.max(tgtW / srcW, tgtH / srcH);
  return { w: srcW * k, h: srcH * k };
}

/* ===== 1. 合并 ===== */

export interface PdfInput {
  name: string;
  data: Uint8Array;
}

export async function mergePdfs(inputs: PdfInput[]): Promise<Uint8Array> {
  if (inputs.length < 2) throw new Error('合并至少需要 2 个 PDF 文件');
  const out = await PDFDocument.create();
  for (const f of inputs) {
    const src = await PDFDocument.load(f.data);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  return out.save();
}

/* ===== 2. 拆分 ===== */

export interface SplitOutput {
  name: string;
  data: Uint8Array;
}

// 按页码范围拆成多个 PDF；范围数量 = 输出数量
export async function splitPdf(doc: Uint8Array, rangeInput: string, baseName: string): Promise<SplitOutput[]> {
  const src = await PDFDocument.load(doc);
  const total = src.getPageCount();
  const ranges = parsePageRanges(rangeInput, total);
  if (ranges.length === 0) throw new Error('没有可拆出的页面');
  const out: SplitOutput[] = [];
  for (const r of ranges) {
    const d = await PDFDocument.create();
    const pages = await d.copyPages(src, expandRanges([r]));
    for (const p of pages) d.addPage(p);
    out.push({ name: splitName(baseName, r), data: await d.save() });
  }
  return out;
}

/* ===== 3. 旋转 ===== */

// angle：90 / 180 / 270（顺时针累加）。rangeInput 空 = 全部页
export async function rotatePdf(doc: Uint8Array, angle: 90 | 180 | 270, rangeInput = ''): Promise<Uint8Array> {
  if (![90, 180, 270].includes(angle)) throw new Error('旋转角度只支持 90 / 180 / 270');
  const src = await PDFDocument.load(doc);
  const total = src.getPageCount();
  const idx = rangeInput.trim() ? expandRanges(parsePageRanges(rangeInput, total)) : src.getPageIndices();
  for (const i of idx) {
    const page = src.getPage(i);
    const cur = ((page.getRotation().angle % 360) + 360) % 360;
    page.setRotation(degrees((cur + angle) % 360));
  }
  return src.save();
}

/* ===== 4. 统一页面大小 ===== */

export interface PageSizePt {
  w: number;
  h: number;
}

// pdf-lib 的 embedPdf 对「无 Contents 流的页」不报错，但 save() 时 embedIntoContext
// 会抛 Can't embed page with missing Contents（双面打印的填充页在真实文件里很常见）。
// 这里在 embed 前预检：无 Contents 的页缩放后仍是空白，直接给目标尺寸空页。
function pageHasContents(page: ReturnType<PDFDocument['getPage']>): boolean {
  const c = page.node.Contents();
  if (!c) return false;
  // Contents 可能是流或流数组；空数组同样视为无内容
  const maybeArray = c as { size?: () => number };
  if (typeof maybeArray.size === 'function') return maybeArray.size() > 0;
  return true;
}

// 把选中页缩放绘制到 target 大小的新页上（embedPdf 无损缩放，不栅格化）。
// rangeInput 空 = 全部页；未选中的页按原样保留。
export async function unifyPageSize(
  doc: Uint8Array,
  target: PageSizePt,
  mode: FitMode,
  rangeInput = '',
): Promise<Uint8Array> {
  if (!(target.w > 0) || !(target.h > 0)) throw new Error('目标页面尺寸必须大于 0');
  const src = await PDFDocument.load(doc);
  const total = src.getPageCount();
  const selected = new Set(rangeInput.trim() ? expandRanges(parsePageRanges(rangeInput, total)) : src.getPageIndices());
  const out = await PDFDocument.create();
  for (let i = 0; i < total; i++) {
    const page = src.getPage(i);
    if (!selected.has(i)) {
      // 未选中的页原样保留
      const [copied] = await out.copyPages(src, [i]);
      out.addPage(copied);
      continue;
    }
    const p = out.addPage([target.w, target.h]);
    if (!pageHasContents(page)) continue; // 空白页：目标尺寸空页，不 embed
    const [embedded] = await out.embedPdf(src, [i]);
    // embedPdf 后的尺寸已考虑源页旋转
    const srcW = embedded.width;
    const srcH = embedded.height;
    const fit = computeFitScale(srcW, srcH, target.w, target.h, mode);
    p.drawPage(embedded, {
      x: (target.w - fit.w) / 2,
      y: (target.h - fit.h) / 2,
      width: fit.w,
      height: fit.h,
    });
  }
  return out.save();
}

/* ===== 5. PDF 转图片 ===== */

export interface ToImagesOpts {
  scale?: number; // 相对 72dpi 的倍率，1.5 ≈ 108dpi，2 ≈ 144dpi，3 ≈ 216dpi
  format?: 'image/jpeg' | 'image/png';
  quality?: number; // jpeg 质量 0-1
}

export interface PageImage {
  name: string;
  blob: Blob;
  width: number;
  height: number;
}

// 每页栅格化为一张图。canvas 走 document.createElement（浏览器环境）。
export async function pdfToImages(data: Uint8Array, opts: ToImagesOpts = {}): Promise<PageImage[]> {
  const scale = opts.scale ?? 2;
  const format = opts.format ?? 'image/jpeg';
  const quality = opts.quality ?? 0.85;
  if (!(scale > 0)) throw new Error('缩放倍率必须大于 0');
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(data) }).promise;
  const out: PageImage[] = [];
  const ext = format === 'image/png' ? 'png' : 'jpg';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(viewport.width));
    c.height = Math.max(1, Math.round(viewport.height));
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('无法创建画布上下文');
    if (format === 'image/jpeg') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
    }
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise<Blob>((resolve, reject) => {
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('图片导出失败'))), format, quality);
    });
    out.push({ name: `page-${String(i).padStart(3, '0')}.${ext}`, blob, width: c.width, height: c.height });
    page.cleanup();
  }
  return out;
}

/* ===== 常用纸张尺寸（pt，1mm = 2.8346pt） ===== */

export const PAPER_SIZES_PT: { name: string; w: number; h: number }[] = [
  { name: 'A3', w: 842, h: 1191 },
  { name: 'A4', w: 595, h: 842 },
  { name: 'A5', w: 420, h: 595 },
  { name: 'B5', w: 499, h: 709 },
  { name: 'Letter', w: 612, h: 792 },
  { name: 'Legal', w: 612, h: 1008 },
];

// 读取 PDF 每页物理尺寸（pt）与主导尺寸名（供工具页回显）
export async function readPageSizes(data: Uint8Array): Promise<{ w: number; h: number }[]> {
  const src = await PDFDocument.load(data);
  return src.getPages().map((p) => {
    const { width, height } = p.getSize();
    return { w: Math.round(width), h: Math.round(height) };
  });
}
