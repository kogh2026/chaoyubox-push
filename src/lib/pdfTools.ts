// PDF 工具箱核心操作库（结构类）。
// 全部本地执行：pdf-lib 做无损结构操作，pdfjs-dist 读大纲，jszip 打包多文件结果。
// 命名保持中性，不引入任何第三方产品标识。
import { PDFDocument, PDFFont, PDFName, PDFNumber, PDFDict, degrees, rgb, StandardFonts, type Color, type PDFImage } from 'pdf-lib';
import JSZip from 'jszip';
import {
  parsePageRanges,
  expandRanges,
  splitName,
  computeFitScale,
  unifyPageSize,
  rotatePdf,
  PAPER_SIZES_PT,
  type PdfInput,
  type FitMode,
} from './pdfOps';
import { readOutline, outlineSections, removeOutline } from './pdfOutline';
import { embedCjkFont } from './cjkFont';
import { pdfTextString } from './pdfText';

export { unifyPageSize, rotatePdf, PAPER_SIZES_PT };
export type { PdfInput, FitMode };

export interface MultiOut {
  name: string;
  data: Uint8Array;
}

const MM = 72 / 25.4; // mm -> pt

function stemOf(name: string): string {
  return name.replace(/\.pdf$/i, '');
}

async function loadDoc(data: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(data, { ignoreEncryption: true });
}

// 十六进制 -> pdf-lib Color（绘制站点专用）
function pdfColor(hex: string): Color {
  const [r, g, b] = hexToRgb(hex);
  return rgb(r, g, b);
}

// 源页尺寸（考虑旋转后的可见尺寸）
function pageSizeOf(page: ReturnType<PDFDocument['getPage']>): { w: number; h: number } {
  const { width, height } = page.getSize();
  return { w: width, h: height };
}

function numArrayOf(arr: { size(): number; get(i: number): unknown }): number[] {
  const out: number[] = [];
  for (let i = 0; i < arr.size(); i++) out.push((arr.get(i) as PDFNumber).asNumber());
  return out;
}

/* ===== 1. 合并（PDF + 图片混合） ===== */

export interface MergeOpts {
  compatMode: boolean; // 无法直接合并的文件自动转图片后合并
  dpi: number; // 兼容模式光栅化倍率（相对 72dpi）
  pageSize: string; // 图片落版的纸张名（PAPER_SIZES_PT）
}

const IMAGE_EXTS = /\.(jpe?g|png|webp|gif|bmp)$/i;

// 解析 PNG 是否含透明通道（纯函数，零依赖，可单测）。
// PNG 结构：8 字节签名 + IHDR 块(length4 + "IHDR"4 + width4 + height4 + bitDepth1 + colorType1 + ...)。
// colorType 在文件偏移 25：4=灰度+alpha，6=RGBA 必有透明；0/2/3 可能带 tRNS 块声明透明。
export function pngHasAlpha(data: Uint8Array): boolean {
  if (data.length < 33) return false;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (data[i] !== sig[i]) return false;
  const colorType = data[25];
  if (colorType === 4 || colorType === 6) return true;
  if (colorType === 0 || colorType === 2 || colorType === 3) {
    let off = 8; // 第一个块起点（IHDR）
    while (off + 8 <= data.length) {
      const len = (data[off] << 24) | (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3];
      const type = String.fromCharCode(data[off + 4], data[off + 5], data[off + 6], data[off + 7]);
      if (type === 'tRNS') return true;
      if (type === 'IDAT') break; // 已到图像数据，前面无 tRNS 即不透明
      if (len < 0) break;
      off += 12 + len;
    }
  }
  return false;
}

// 把 PNG 字节用 canvas 重编码为 JPEG（仅浏览器/渲染器可用；Node 单测返回 null 走回退）。
// 照片类 PNG（无透明）转 JPEG 后体积可降数倍，且观感不变。转换完即释放 canvas，避免内存堆积。
async function pngToJpegBytes(data: Uint8Array, quality: number): Promise<Uint8Array | null> {
  if (typeof document === 'undefined') return null;
  try {
    const blob = new Blob([data as unknown as BlobPart], { type: 'image/png' });
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, bmp.width);
    canvas.height = Math.max(1, bmp.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bmp.close?.();
      return null;
    }
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    const outBlob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', quality));
    if (!outBlob) return null;
    const buf = await outBlob.arrayBuffer();
    canvas.width = 0; // 释放显存
    canvas.height = 0;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

// 智能嵌入：PNG 含透明通道才保留 embedPng；否则（照片/不透明图）优先转 JPEG 再 embedJpg，
// 体积大幅下降。无 canvas 的环境（Node 单测）回退 embedPng，保证逻辑不破。JPG 直接 embedJpg。
async function embedImageSmart(doc: PDFDocument, name: string, data: Uint8Array, quality = 0.9): Promise<PDFImage> {
  const lower = name.toLowerCase();
  if (!lower.endsWith('.png') && !lower.endsWith('.jpg') && !lower.endsWith('.jpeg')) {
    throw new Error(`不支持的图片格式：${name}`);
  }
  if (lower.endsWith('.png')) {
    if (pngHasAlpha(data)) return doc.embedPng(data);
    const jpg = await pngToJpegBytes(data, quality);
    if (jpg) return doc.embedJpg(jpg);
    return doc.embedPng(data); // 无 canvas 环境回退
  }
  return doc.embedJpg(data);
}

async function rasterizeToPdf(
  data: Uint8Array,
  dpi: number,
  pageSizePt: { w: number; h: number },
  out: PDFDocument,
): Promise<void> {
  // 动态依赖栅格模块，避免结构库引入 canvas 相关代码路径
  const { rasterizePdfToPdf } = await import('./pdfRaster');
  await rasterizePdfToPdf(data, dpi, pageSizePt, out);
}

async function embedImageToPage(
  out: PDFDocument,
  img: { name: string; data: Uint8Array },
  pageSizePt: { w: number; h: number },
): Promise<void> {
  const embedded = await embedImageSmart(out, img.name, img.data);
  const p = out.addPage([pageSizePt.w, pageSizePt.h]);
  const fit = computeFitScale(embedded.width, embedded.height, pageSizePt.w, pageSizePt.h, 'contain');
  p.drawImage(embedded, {
    x: (pageSizePt.w - fit.w) / 2,
    y: (pageSizePt.h - fit.h) / 2,
    width: fit.w,
    height: fit.h,
  });
}

export async function mergePdfFiles(inputs: PdfInput[], opts: MergeOpts): Promise<Uint8Array> {
  if (inputs.length < 2) throw new Error('合并至少需要 2 个文件');
  const paper = PAPER_SIZES_PT.find((p) => p.name === opts.pageSize) ?? PAPER_SIZES_PT[1];
  const out = await PDFDocument.create();
  for (const f of inputs) {
    if (IMAGE_EXTS.test(f.name)) {
      await embedImageToPage(out, f, paper);
      continue;
    }
    try {
      const src = await loadDoc(f.data);
      const pages = await out.copyPages(src, src.getPageIndices());
      for (const p of pages) out.addPage(p);
    } catch (e) {
      if (!opts.compatMode) throw new Error(`「${f.name}」无法直接合并：${(e as Error).message}`);
      await rasterizeToPdf(f.data, opts.dpi, paper, out);
    }
  }
  return out.save();
}

/* ===== 2. 交叉合并（轮流取页） ===== */

export async function interleaveMerge(inputs: PdfInput[]): Promise<Uint8Array> {
  if (inputs.length < 2) throw new Error('交叉合并至少需要 2 个文件');
  const docs: PDFDocument[] = [];
  for (const f of inputs) docs.push(await loadDoc(f.data));
  const maxPages = Math.max(...docs.map((d) => d.getPageCount()));
  const out = await PDFDocument.create();
  for (let i = 0; i < maxPages; i++) {
    for (const d of docs) {
      if (i < d.getPageCount()) {
        const [p] = await out.copyPages(d, [i]);
        out.addPage(p);
      }
    }
  }
  return out.save();
}

/* ===== 3. 拆分 ===== */

export type SplitMode = 'ranges' | 'fixed' | 'single' | 'oddeven' | 'groups';

export interface SplitOpts {
  mode: SplitMode;
  ranges: string; // 页码范围输入
  fixed: number; // 固定页数
}

export async function splitPdfMulti(doc: Uint8Array, baseName: string, opts: SplitOpts): Promise<MultiOut[]> {
  const src = await loadDoc(doc);
  const total = src.getPageCount();
  if (total === 0) throw new Error('文档没有页面');
  const stem = stemOf(baseName);
  const out: MultiOut[] = [];

  const pushRange = async (from: number, to: number, label?: string) => {
    const d = await PDFDocument.create();
    const pages = await d.copyPages(src, expandRanges([{ from, to }]));
    for (const p of pages) d.addPage(p);
    const name = label ?? (from === to ? `${stem}_p${from}.pdf` : `${stem}_p${from}-${to}.pdf`);
    out.push({ name, data: await d.save() });
  };

  const pushIdx = async (indices: number[], label: string) => {
    const d = await PDFDocument.create();
    const pages = await d.copyPages(src, indices);
    for (const p of pages) d.addPage(p);
    out.push({ name: label, data: await d.save() });
  };

  if (opts.mode === 'ranges' || opts.mode === 'groups') {
    const ranges = parsePageRanges(opts.ranges, total);
    if (ranges.length === 0) throw new Error('没有可拆出的页面');
    for (const r of ranges) await pushRange(r.from, r.to);
  } else if (opts.mode === 'fixed') {
    const n = Math.max(1, Math.floor(opts.fixed || 1));
    for (let i = 1; i <= total; i += n) await pushRange(i, Math.min(i + n - 1, total));
  } else if (opts.mode === 'single') {
    for (let i = 1; i <= total; i++) await pushRange(i, i);
  } else {
    // 奇偶拆分：按页码奇偶取页（非连续区间）
    const odd: number[] = [];
    const even: number[] = [];
    for (let i = 1; i <= total; i++) (i % 2 === 1 ? odd : even).push(i - 1);
    if (odd.length) await pushIdx(odd, `${stem}_奇数页.pdf`);
    if (even.length) await pushIdx(even, `${stem}_偶数页.pdf`);
  }
  return out;
}

/* ===== 4/5. 书签拆分与炸开 ===== */

export async function splitByBookmarks(doc: Uint8Array, selected: number[]): Promise<Uint8Array> {
  const src = await loadDoc(doc);
  const total = src.getPageCount();
  const nodes = await readOutline(doc);
  const sections = outlineSections(nodes, total);
  if (sections.length === 0) throw new Error('该文档没有书签，无法按书签拆分');
  const picked = sections.filter((_, i) => selected.includes(i));
  if (picked.length === 0) throw new Error('请先勾选要拆出的章节');
  const out = await PDFDocument.create();
  const srcPages: number[] = [];
  for (const s of picked) {
    for (let p = s.from; p <= s.to; p++) srcPages.push(p - 1);
  }
  const pages = await out.copyPages(src, srcPages);
  for (const p of pages) out.addPage(p);
  return out.save();
}

export interface ExplodeOpts {
  addIndex: boolean; // 添加序号（自动补零）
  useFileNamePrefix: boolean; // 原文件名作为前缀
  useBookmarkName: boolean; // 使用书签名
  keepHierarchy: boolean; // 保留层级 父_子_孙
  maxDepth: number; // 最大拆分层级（1 = 只一级）
}

export async function explodeBookmarks(doc: Uint8Array, baseName: string, opts: ExplodeOpts): Promise<MultiOut[]> {
  const src = await loadDoc(doc);
  const total = src.getPageCount();
  const nodes = await readOutline(doc);
  const sections = outlineSections(nodes, total);
  if (sections.length === 0) throw new Error('该文档没有书签，无法炸开');
  const stem = stemOf(baseName);
  const picked = sections.filter((s) => s.depth < opts.maxDepth);
  const width = String(picked.length).length;
  const out: MultiOut[] = [];
  const used = new Map<string, number>();
  for (let i = 0; i < picked.length; i++) {
    const s = picked[i];
    const d = await PDFDocument.create();
    const pages = await d.copyPages(src, expandRanges([{ from: s.from, to: s.to }]));
    for (const p of pages) d.addPage(p);
    const parts: string[] = [];
    if (opts.useFileNamePrefix) parts.push(stem);
    if (opts.addIndex) parts.push(String(i + 1).padStart(width, '0'));
    if (opts.useBookmarkName) {
      parts.push(opts.keepHierarchy ? s.title : s.title.replace(/[/\\?%*:|"<>]/g, '_'));
    }
    let name = (parts.length ? parts.join('_') : `part-${i + 1}`) + '.pdf';
    const seen = used.get(name) ?? 0;
    used.set(name, seen + 1);
    if (seen > 0) name = name.replace(/\.pdf$/i, `_${seen + 1}.pdf`);
    out.push({ name, data: await d.save() });
  }
  return out;
}

/* ===== 6-9. 重排 / 倒序 / 补齐 / 删除 ===== */

export interface ReorderOpts {
  order: number[]; // 0 起的源页序；-1 表示插入空白页
  blankSize?: { w: number; h: number }; // 空白页尺寸（默认取首页）
}

export async function reorderPages(doc: Uint8Array, opts: ReorderOpts): Promise<Uint8Array> {
  const src = await loadDoc(doc);
  const total = src.getPageCount();
  if (opts.order.length === 0) throw new Error('页面顺序为空');
  const first = src.getPage(0);
  const blank = opts.blankSize ?? pageSizeOf(first);
  const out = await PDFDocument.create();
  for (const idx of opts.order) {
    if (idx < 0) {
      out.addPage([blank.w, blank.h]);
      continue;
    }
    if (idx >= total) throw new Error(`页码 ${idx + 1} 超出范围`);
    const [p] = await out.copyPages(src, [idx]);
    out.addPage(p);
  }
  return out.save();
}

export async function reversePages(doc: Uint8Array): Promise<Uint8Array> {
  const src = await loadDoc(doc);
  const total = src.getPageCount();
  const out = await PDFDocument.create();
  for (let i = total - 1; i >= 0; i--) {
    const [p] = await out.copyPages(src, [i]);
    out.addPage(p);
  }
  return out.save();
}

export type BlankPad = 'last' | 'A4' | 'Letter';

export async function padEvenPages(doc: Uint8Array, mode: BlankPad): Promise<Uint8Array> {
  const src = await loadDoc(doc);
  const total = src.getPageCount();
  if (total % 2 === 0) return src.save();
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, src.getPageIndices());
  for (const p of pages) out.addPage(p);
  const last = src.getPage(total - 1);
  let size = pageSizeOf(last);
  if (mode === 'A4') size = { w: 595.28, h: 841.89 };
  if (mode === 'Letter') size = { w: 612, h: 792 };
  out.addPage([size.w, size.h]);
  return out.save();
}

export async function deletePages(doc: Uint8Array, ranges: string): Promise<Uint8Array> {
  const src = await loadDoc(doc);
  const total = src.getPageCount();
  const drop = new Set(expandRanges(parsePageRanges(ranges, total)));
  if (drop.size >= total) throw new Error('不能删除全部页面');
  const out = await PDFDocument.create();
  for (let i = 0; i < total; i++) {
    if (drop.has(i)) continue;
    const [p] = await out.copyPages(src, [i]);
    out.addPage(p);
  }
  return out.save();
}

// blankFlags[i] = true 表示第 i+1 页被判定为空白页，删除
export async function removeBlankPages(doc: Uint8Array, blankFlags: boolean[]): Promise<Uint8Array> {
  const src = await loadDoc(doc);
  const total = src.getPageCount();
  const keep: number[] = [];
  for (let i = 0; i < total; i++) if (!blankFlags[i]) keep.push(i);
  if (keep.length === 0) throw new Error('所有页面都被判定为空白页，已取消操作');
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, keep);
  for (const p of pages) out.addPage(p);
  // 页码映射：源 i -> 目标 keep.indexOf(i)+1
  const { buildOutline } = await import('./pdfOutline');
  const nodes = await readOutline(doc);
  if (nodes.length) buildOutline(out, nodes, (p) => {
    const k = keep.indexOf(p - 1);
    return k >= 0 ? k + 1 : null;
  });
  return out.save();
}

/* ===== 12. 逐页旋转 ===== */

export type RotAngle = 0 | 90 | 180 | 270;

export async function rotatePerPage(doc: Uint8Array, angles: RotAngle[]): Promise<Uint8Array> {
  const src = await loadDoc(doc);
  const total = src.getPageCount();
  for (let i = 0; i < total; i++) {
    const a = angles[i] ?? 0;
    if (!a) continue;
    const page = src.getPage(i);
    const cur = ((page.getRotation().angle % 360) + 360) % 360;
    page.setRotation(degrees((cur + a) % 360));
  }
  return src.save();
}

/* ===== 13. 页面拼版（N-up） ===== */

export interface NupOpts {
  cols: number;
  rows: number;
  order: 'row' | 'col';
  marginMm: number;
  gapMm: number;
  border: boolean;
  skipEmpty: boolean; // 最后一组不足时整组跳过
}

export async function nupLayout(doc: Uint8Array, opts: NupOpts): Promise<Uint8Array> {
  const src = await loadDoc(doc);
  const total = src.getPageCount();
  const cols = Math.max(1, Math.floor(opts.cols));
  const rows = Math.max(1, Math.floor(opts.rows));
  const per = cols * rows;
  const first = pageSizeOf(src.getPage(0));
  const out = await PDFDocument.create();
  const margin = opts.marginMm * MM;
  const gap = opts.gapMm * MM;
  for (let start = 0; start < total; start += per) {
    const group: number[] = [];
    for (let i = start; i < Math.min(start + per, total); i++) group.push(i);
    if (opts.skipEmpty && group.length < per) break;
    const p = out.addPage([first.w, first.h]);
    const cw = (first.w - margin * 2 - gap * (cols - 1)) / cols;
    const ch = (first.h - margin * 2 - gap * (rows - 1)) / rows;
    for (let k = 0; k < group.length; k++) {
      let r: number, c: number;
      if (opts.order === 'row') {
        r = Math.floor(k / cols);
        c = k % cols;
      } else {
        c = Math.floor(k / rows);
        r = k % rows;
      }
      const x = margin + c * (cw + gap);
      const y = first.h - margin - (r + 1) * ch - r * gap;
      const [emb] = await out.embedPdf(src, [group[k]]);
      const fit = computeFitScale(emb.width, emb.height, cw, ch, 'contain');
      p.drawPage(emb, {
        x: x + (cw - fit.w) / 2,
        y: y + (ch - fit.h) / 2,
        width: fit.w,
        height: fit.h,
      });
      if (opts.border) {
        p.drawRectangle({ x, y, width: cw, height: ch, borderColor: pdfColor('#9ca3af'), borderWidth: 0.5 });
      }
    }
  }
  return out.save();
}

/* ===== 14. 小册子排版（骑马订） ===== */

export type BookletSize = 'origin' | 'A4' | 'A5' | 'A6';

const BOOKLET_PT: Record<string, { w: number; h: number }> = {
  A4: { w: 595.28, h: 841.89 },
  A5: { w: 419.53, h: 595.28 },
  A6: { w: 297.64, h: 419.53 },
};

export async function bookletImpose(doc: Uint8Array, size: BookletSize): Promise<Uint8Array> {
  const src = await loadDoc(doc);
  let total = src.getPageCount();
  if (total === 0) throw new Error('文档没有页面');
  const pad = total % 4 === 0 ? 0 : 4 - (total % 4);
  total += pad;
  const first = pageSizeOf(src.getPage(0));
  const cell = size === 'origin' ? first : BOOKLET_PT[size];
  const out = await PDFDocument.create();
  const sheetW = cell.w * 2;
  const sheetH = cell.h;
  for (let s = 0; s < total / 4; s++) {
    // 正面（左 = 末页倒着数，右 = 正页），背面
    const pairs: [number, number][] = [
      [total - 2 * s, 2 * s + 1],
      [2 * s + 2, total - 2 * s - 1],
    ];
    for (const [left, right] of pairs) {
      const p = out.addPage([sheetW, sheetH]);
      for (const [pg, x0] of [
        [left, 0],
        [right, cell.w],
      ] as [number, number][]) {
        if (pg < 1 || pg > src.getPageCount()) continue; // 补白页留空
        const [emb] = await out.embedPdf(src, [pg - 1]);
        const fit = computeFitScale(emb.width, emb.height, cell.w, cell.h, 'contain');
        p.drawPage(emb, {
          x: x0 + (cell.w - fit.w) / 2,
          y: (cell.h - fit.h) / 2,
          width: fit.w,
          height: fit.h,
        });
      }
    }
  }
  return out.save();
}

/* ===== 17. 拆分对开页 ===== */

export async function splitSpreadPages(doc: Uint8Array, force = false): Promise<Uint8Array> {
  const src = await loadDoc(doc);
  const out = await PDFDocument.create();
  let splitCount = 0;
  for (let i = 0; i < src.getPageCount(); i++) {
    const page = src.getPage(i);
    const { w, h } = pageSizeOf(page);
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    const isSpread = force || w > h * 1.15;
    if (!isSpread || rot !== 0) {
      const [p] = await out.copyPages(src, [i]);
      out.addPage(p);
      continue;
    }
    const mb = numArrayOf(page.node.get(PDFName.of('MediaBox')) as unknown as { size(): number; get(i: number): unknown });
    const [x0, y0, x1, y1] = mb.length === 4 ? mb : [0, 0, w, h];
    const xm = (x0 + x1) / 2;
    splitCount++;
    for (const side of [0, 1]) {
      const [p] = await out.copyPages(src, [i]);
      const bx = side === 0 ? [x0, y0, xm, y1] : [xm, y0, x1, y1];
      p.node.set(PDFName.of('CropBox'), out.context.obj(bx));
      out.addPage(p);
    }
  }
  if (splitCount === 0) throw new Error('没有检测到对开页（宽高比超过 1.15 的页面），可尝试勾选"强制拆分"');
  return out.save();
}

/* ===== 20. 生成空白页 ===== */

export interface BlankPdfOpts {
  preset: string; // A3/A4/A5/B5/Letter/Legal/custom
  customW: number; // mm
  customH: number; // mm
  landscape: boolean;
  count: number;
  grid: 'none' | 'quad' | 'ruled' | 'dotted'; // 方格 / 横线 / 点阵
  lineColor: string; // #rrggbb
  lineSpacingMm: number;
  header: string;
  footer: string;
}

export async function createBlankPdf(opts: BlankPdfOpts): Promise<Uint8Array> {
  let w: number, h: number;
  if (opts.preset === 'custom') {
    w = opts.customW * MM;
    h = opts.customH * MM;
  } else {
    const p = PAPER_SIZES_PT.find((x) => x.name === opts.preset) ?? PAPER_SIZES_PT[1];
    w = p.w;
    h = p.h;
  }
  if (opts.landscape) [w, h] = [h, w];
  if (!(w > 0) || !(h > 0)) throw new Error('页面尺寸必须大于 0');
  const count = Math.max(1, Math.min(200, Math.floor(opts.count)));
  const doc = await PDFDocument.create();
  const font = await embedCjkFont(doc);
  const line = pdfColor(opts.lineColor);
  const sp = Math.max(2, opts.lineSpacingMm) * MM;
  for (let i = 0; i < count; i++) {
    const p = doc.addPage([w, h]);
    if (opts.grid !== 'none') {
      const edge = 20 * MM;
      p.drawRectangle({ x: edge, y: edge, width: w - edge * 2, height: h - edge * 2, borderColor: line, borderWidth: 0.6 });
      if (opts.grid === 'ruled') {
        for (let y = h - edge - sp; y > edge + sp; y -= sp) {
          p.drawLine({ start: { x: edge, y }, end: { x: w - edge, y }, color: line, thickness: 0.4 });
        }
      } else {
        for (let x = edge + sp; x < w - edge; x += sp) {
          p.drawLine({ start: { x, y: edge }, end: { x, y: h - edge }, color: line, thickness: 0.4 });
        }
        if (opts.grid === 'quad') {
          for (let y = h - edge - sp; y > edge + sp; y -= sp) {
            p.drawLine({ start: { x: edge, y }, end: { x: w - edge, y }, color: line, thickness: 0.4 });
          }
        } else {
          // 点阵：横竖线交点上画点
          for (let x = edge + sp; x < w - edge; x += sp) {
            for (let y = h - edge - sp; y > edge + sp; y -= sp) {
              p.drawCircle({ x, y, size: 0.8, color: line });
            }
          }
        }
      }
    }
    if (font && opts.header.trim()) {
      const size = Math.max(8, Math.min(14, w / 40));
      const tw = font.widthOfTextAtSize(opts.header, size);
      p.drawText(opts.header, { x: (w - tw) / 2, y: h - 14 * MM, size, font, color: line });
    }
    if (font && opts.footer.trim()) {
      const size = Math.max(8, Math.min(14, w / 40));
      const tw = font.widthOfTextAtSize(opts.footer, size);
      p.drawText(opts.footer, { x: (w - tw) / 2, y: 10 * MM, size, font, color: line });
    }
  }
  return doc.save();
}

/* ===== 22. 图片转 PDF ===== */

export type ImagePageSize = 'A3' | 'A4' | 'A5' | 'Letter' | 'fit';

export interface ImagesToPdfOpts {
  pageSize: ImagePageSize;
  landscape: boolean;
  marginMm: number;
  fit: FitMode;
  background: string; // '#ffffff'
}

export async function imagesToPdf(inputs: PdfInput[], opts: ImagesToPdfOpts): Promise<Uint8Array> {
  if (inputs.length === 0) throw new Error('请先选择图片');
  const doc = await PDFDocument.create();
  for (const f of inputs) {
    const emb = await embedImageSmart(doc, f.name, f.data);
    let pw: number, ph: number;
    if (opts.pageSize === 'fit') {
      pw = emb.width;
      ph = emb.height;
    } else {
      const p = PAPER_SIZES_PT.find((x) => x.name === opts.pageSize) ?? PAPER_SIZES_PT[1];
      pw = p.w;
      ph = p.h;
      if (opts.landscape) [pw, ph] = [ph, pw];
    }
    const margin = opts.marginMm * MM;
    const page = doc.addPage([pw, ph]);
    page.drawRectangle({ x: 0, y: 0, width: pw, height: ph, color: pdfColor(opts.background) });
    const fit = computeFitScale(emb.width, emb.height, pw - margin * 2, ph - margin * 2, opts.fit);
    page.drawImage(emb, {
      x: (pw - fit.w) / 2,
      y: (ph - fit.h) / 2,
      width: fit.w,
      height: fit.h,
    });
  }
  return doc.save();
}
/* ===== 28. 添加页码 ===== */

export type NumberTemplate = 'n' | 'n-total' | 'cn' | 'cn-total' | 'dash';

export interface PageNumberOpts {
  template: NumberTemplate;
  position: string; // 九宫格：tl tc tr ml mc mr bl bc br
  sizePt: number;
  color: string;
  marginMm: number;
  startAt: number;
  range: string;
  font: 'regular' | 'bold';
}

const POSITIONS: Record<string, (w: number, h: number, m: number) => { x: number; y: number }> = {
  tl: (_w, h, m) => ({ x: m, y: h - m }),
  tc: (w, h, m) => ({ x: w / 2, y: h - m }),
  tr: (w, h, m) => ({ x: w - m, y: h - m }),
  ml: (_w, h, m) => ({ x: m, y: h / 2 }),
  mc: (w, h, _m) => ({ x: w / 2, y: h / 2 }),
  mr: (w, h, m) => ({ x: w - m, y: h / 2 }),
  bl: (_w, _h, m) => ({ x: m, y: m }),
  bc: (w, _h, m) => ({ x: w / 2, y: m }),
  br: (w, _h, m) => ({ x: w - m, y: m }),
};

function cnNum(n: number): string {
  const d = '零一二三四五六七八九';
  if (n <= 10) return n === 10 ? '十' : d[n];
  if (n < 20) return '十' + d[n - 10];
  const s = String(n);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const pos = s.length - i;
    out += d[+s[i]] + (pos === 2 ? '十' : pos === 3 ? '百' : pos === 4 ? '千' : '');
  }
  return out;
}

function formatPageNo(tpl: NumberTemplate, n: number, total: number): string {
  switch (tpl) {
    case 'n':
      return String(n);
    case 'n-total':
      return `${n} / ${total}`;
    case 'cn':
      return `第 ${cnNum(n)} 页`;
    case 'cn-total':
      return `第 ${cnNum(n)} 页 / 共 ${cnNum(total)} 页`;
    case 'dash':
      return `- ${n} -`;
  }
}

export async function addPageNumbers(doc: Uint8Array, opts: PageNumberOpts): Promise<Uint8Array> {
  const src = await loadDoc(doc);
  const total = src.getPageCount();
  const idx = opts.range.trim() ? expandRanges(parsePageRanges(opts.range, total)) : src.getPageIndices();
  const font = await embedCjkFont(src);
  const std = await src.embedFont(StandardFonts.HelveticaBold);
  const useFont = (opts.font === 'bold' && !font ? std : font) ?? std;
  const color = pdfColor(opts.color);
  const margin = opts.marginMm * MM;
  const size = Math.max(6, Math.min(48, opts.sizePt));
  let n = opts.startAt;
  for (const i of idx) {
    const page = src.getPage(i);
    const { w, h } = pageSizeOf(page);
    const text = formatPageNo(opts.template, n, total);
    const tw = useFont.widthOfTextAtSize(text, size);
    const pos = (POSITIONS[opts.position] ?? POSITIONS.bc)(w, h, margin);
    const alignCenter = opts.position.includes('c');
    const alignRight = opts.position.endsWith('r');
    const x = alignRight ? pos.x - tw : alignCenter ? pos.x - tw / 2 : pos.x;
    page.drawText(text, { x, y: pos.y - size, size, font: useFont, color });
    n++;
  }
  return src.save();
}

/* ===== 29. 批量编号（跨文件连续） ===== */

export interface BatesOpts {
  prefix: string;
  suffix: string;
  start: number;
  digits: number;
  position: string;
  sizePt: number;
  color: string;
  marginMm: number;
  range: string; // 每个文件内的页码范围（留空 = 全部）
  merge: boolean; // 合并为一个输出文件
}

function padNum(n: number, digits: number): string {
  return String(n).padStart(Math.max(1, Math.min(9, digits)), '0');
}

export async function batesNumbers(inputs: PdfInput[], opts: BatesOpts): Promise<MultiOut[]> {
  if (inputs.length === 0) throw new Error('请先选择文件');
  const out: MultiOut[] = [];
  let counter = opts.start;
  const merged = await PDFDocument.create();
  const font = await embedCjkFont(merged);
  const std = await merged.embedFont(StandardFonts.HelveticaBold);
  const useFont = font ?? std;
  const color = pdfColor(opts.color);
  const margin = opts.marginMm * MM;
  const size = Math.max(6, Math.min(48, opts.sizePt));
  for (const f of inputs) {
    const src = await loadDoc(f.data);
    const total = src.getPageCount();
    const idx = opts.range.trim() ? expandRanges(parsePageRanges(opts.range, total)) : src.getPageIndices();
    for (const i of idx) {
      const page = src.getPage(i);
      const { w, h } = pageSizeOf(page);
      const text = `${opts.prefix}${padNum(counter, opts.digits)}${opts.suffix}`;
      const tw = useFont.widthOfTextAtSize(text, size);
      const pos = (POSITIONS[opts.position] ?? POSITIONS.bc)(w, h, margin);
      const alignCenter = opts.position.includes('c');
      const alignRight = opts.position.endsWith('r');
      const x = alignRight ? pos.x - tw : alignCenter ? pos.x - tw / 2 : pos.x;
      page.drawText(text, { x, y: pos.y - size, size, font: useFont, color });
      counter++;
    }
    const data = await src.save();
    out.push({ name: `${stemOf(f.name)}_编号.pdf`, data });
    if (opts.merge) {
      const copied = await merged.copyPages(src, src.getPageIndices());
      for (const p of copied) merged.addPage(p);
    }
  }
  if (opts.merge) out.push({ name: '合并_编号.pdf', data: await merged.save() });
  return out;
}

/* ===== 30/31/32. 水印与图章 ===== */

export interface WatermarkPos {
  x: number; // 0-1 归一化（相对页面）
  y: number;
}

export interface TextWatermarkOpts {
  text: string;
  sizePt: number;
  color: string;
  opacity: number; // 0-1
  angle: number; // 度
  pos: WatermarkPos;
  tile: boolean;
  tileStepMm: number;
  range: string;
  bold: boolean;
}

// 以 (cx, cy) 为旋转中心绘制文字
async function drawTextAtCenter(
  page: ReturnType<PDFDocument['getPage']>,
  font: PDFFont,
  text: string,
  size: number,
  cx: number,
  cy: number,
  color: Color,
  opacity: number,
  angleDeg: number,
): Promise<void> {
  const tw = font.widthOfTextAtSize(text, size);
  const th = size;
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  // 原点 = 中心 - R(a)·(tw/2, th/2)
  const ox = cx - ((tw / 2) * cos - (th / 2) * sin);
  const oy = cy - ((tw / 2) * sin + (th / 2) * cos);
  page.drawText(text, { x: ox, y: oy, size, font, color, opacity, rotate: degrees(angleDeg) });
}

export async function textWatermark(doc: Uint8Array, opts: TextWatermarkOpts): Promise<Uint8Array> {
  const text = opts.text.trim();
  if (!text) throw new Error('请输入水印文字');
  const src = await loadDoc(doc);
  const total = src.getPageCount();
  const idx = opts.range.trim() ? expandRanges(parsePageRanges(opts.range, total)) : src.getPageIndices();
  const font = await embedCjkFont(src);
  const std = opts.bold ? await src.embedFont(StandardFonts.HelveticaBold) : await src.embedFont(StandardFonts.Helvetica);
  const useFont = font ?? std;
  const color = pdfColor(opts.color);
  const size = Math.max(6, Math.min(120, opts.sizePt));
  const opacity = Math.max(0.05, Math.min(1, opts.opacity));
  for (const i of idx) {
    const page = src.getPage(i);
    const { w, h } = pageSizeOf(page);
    if (opts.tile) {
      const step = Math.max(20, opts.tileStepMm) * MM;
      const tw = useFont.widthOfTextAtSize(text, size);
      const rows = Math.ceil(h / step) + 1;
      const cols = Math.ceil(w / (step + tw)) + 1;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cx = (c * (step + tw)) % (w + tw);
          const cy = h - r * step;
          await drawTextAtCenter(page, useFont, text, size, cx, cy, color, opacity, opts.angle);
        }
      }
    } else {
      await drawTextAtCenter(page, useFont, text, size, opts.pos.x * w, (1 - opts.pos.y) * h, color, opacity, opts.angle);
    }
  }
  return src.save();
}

export interface ImageWatermarkOpts {
  image: Uint8Array;
  imageName: string;
  scalePct: number; // 相对页面宽度百分比
  opacity: number;
  angle: number;
  pos: WatermarkPos;
  range: string;
}

async function embedAnyImage(doc: PDFDocument, name: string, data: Uint8Array) {
  return embedImageSmart(doc, name, data);
}

export async function imageWatermark(doc: Uint8Array, opts: ImageWatermarkOpts): Promise<Uint8Array> {
  const src = await loadDoc(doc);
  const total = src.getPageCount();
  const idx = opts.range.trim() ? expandRanges(parsePageRanges(opts.range, total)) : src.getPageIndices();
  const emb = await embedAnyImage(src, opts.imageName, opts.image);
  const opacity = Math.max(0.05, Math.min(1, opts.opacity));
  const pct = Math.max(2, Math.min(200, opts.scalePct)) / 100;
  for (const i of idx) {
    const page = src.getPage(i);
    const { w, h } = pageSizeOf(page);
    const iw = w * pct;
    const ih = (emb.height / emb.width) * iw;
    const cx = opts.pos.x * w;
    const cy = (1 - opts.pos.y) * h;
    page.drawImage(emb, {
      x: cx - iw / 2,
      y: cy - ih / 2,
      width: iw,
      height: ih,
      opacity,
      rotate: degrees(opts.angle),
    });
  }
  return src.save();
}

/* ===== 33. 骑缝章 ===== */

export interface SeamStampOpts {
  text: string;
  sizePt: number;
  color: string;
  charsPerPage: number; // 每页字数
  range: string;
  fan: boolean; // 扇形渐变旋转
}

export async function seamStamp(doc: Uint8Array, opts: SeamStampOpts): Promise<Uint8Array> {
  const text = [...opts.text.trim()];
  if (text.length === 0) throw new Error('请输入印章文字');
  const src = await loadDoc(doc);
  const total = src.getPageCount();
  const idx = opts.range.trim() ? expandRanges(parsePageRanges(opts.range, total)) : src.getPageIndices();
  const font = await embedCjkFont(src);
  const std = await src.embedFont(StandardFonts.HelveticaBold);
  const useFont = font ?? std;
  const color = pdfColor(opts.color);
  const size = Math.max(6, Math.min(72, opts.sizePt));
  const per = Math.max(1, Math.floor(opts.charsPerPage));
  // 每页 per 个字，按页顺序排布；奇数页放右边缘、偶数页放左边缘（对折后连成一列）
  const chars: { ch: string; page: number; slot: number }[] = [];
  const seq = text.slice(0, idx.length * per);
  seq.forEach((ch, i) => {
    chars.push({ ch, page: idx[Math.floor(i / per)] ?? 0, slot: i % per });
  });
  for (const { ch, page, slot } of chars) {
    const pg = src.getPage(page);
    const { w, h } = pageSizeOf(pg);
    const rightEdge = page % 2 === 0; // 第 1、3、5 页（索引偶数）在右缘
    const tw = useFont.widthOfTextAtSize(ch, size);
    const x = rightEdge ? w - 6 * MM : 6 * MM - tw;
    const y = h - 10 * MM - slot * (size * 1.2) - (opts.fan ? slot * 1.5 : 0);
    const rot = opts.fan ? -6 + slot * 3 : 90;
    pg.drawText(ch, { x, y, size, font: useFont, color, rotate: degrees(rot) });
  }
  return src.save();
}

/* ===== 35/36. 元数据与书签移除 ===== */

export interface PdfMetadata {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
}

export async function readMetadata(data: Uint8Array): Promise<PdfMetadata> {
  const doc = await loadDoc(data);
  return {
    title: doc.getTitle() ?? '',
    author: doc.getAuthor() ?? '',
    subject: doc.getSubject() ?? '',
    keywords: doc.getKeywords() ?? '',
    creator: doc.getCreator() ?? '',
    producer: doc.getProducer() ?? '',
  };
}

// 取（或建）文档的 /Info 字典（pdf-lib 的 getInfoDict 是私有的，这里用公开 API 复刻）
function getInfoDict(doc: PDFDocument): PDFDict {
  const ctx = doc.context;
  const existing = ctx.lookup(ctx.trailerInfo.Info);
  if (existing instanceof PDFDict) return existing;
  const fresh = ctx.obj({}) as PDFDict;
  ctx.trailerInfo.Info = ctx.register(fresh);
  return fresh;
}

export async function writeMetadata(data: Uint8Array, meta: PdfMetadata): Promise<Uint8Array> {
  const doc = await loadDoc(data);
  const info = getInfoDict(doc);
  const set = (key: string, value: string) => {
    if (value) info.set(PDFName.of(key), pdfTextString(value));
    else info.delete(PDFName.of(key));
  };
  set('Title', meta.title);
  set('Author', meta.author);
  set('Subject', meta.subject);
  set('Creator', meta.creator);
  set('Producer', meta.producer);
  // 关键词统一用逗号连接（pdf-lib 的 setKeywords 用空格连接，不符合常见习惯）
  const kws = meta.keywords
    ? meta.keywords
        .split(/[,，;；]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(', ')
    : '';
  if (kws) info.set(PDFName.of('Keywords'), pdfTextString(kws));
  else info.delete(PDFName.of('Keywords'));
  return doc.save();
}

export async function removeBookmarks(data: Uint8Array): Promise<Uint8Array> {
  const doc = await loadDoc(data);
  removeOutline(doc);
  return doc.save();
}

/* ===== 37. 签名信息查看 ===== */

export interface SignatureInfo {
  field: string;
  signed: boolean;
  subFilter: string;
  signer: string;
  reason: string;
  location: string;
  date: string;
  byteRange: string;
  hexLen: number;
}

export interface SignatureReport {
  hasForm: boolean;
  items: SignatureInfo[];
  note: string;
}

function latin1Decode(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return s;
}

// 尽力解析：扫描原始字节中的签名字段（/FT/Sig）。加密对象流中的字段可能解析不到。
export async function inspectSignatures(data: Uint8Array): Promise<SignatureReport> {
  const raw = latin1Decode(data);
  const items: SignatureInfo[] = [];
  const seen = new Set<number>();
  const ftRe = /\/FT\s*\/Sig/g;
  let m: RegExpExecArray | null;
  while ((m = ftRe.exec(raw))) {
    const pos = m.index;
    if (seen.has(pos)) continue;
    seen.add(pos);
    // 向前找字段名 /T(...)，向后找 /V 字典
    const before = raw.slice(Math.max(0, pos - 400), pos);
    const tm = /\/T\s*\(([^)]*)\)\s*$/.exec(before);
    const after = raw.slice(pos, pos + 3000);
    const pick = (re: RegExp): string => {
      const mm = re.exec(after);
      return mm ? mm[1] : '';
    };
    const hexm = /\/Contents\s*<([0-9A-Fa-f\s]*)>/.exec(after);
    items.push({
      field: tm ? tm[1] : '（未命名字段）',
      signed: /\/Contents\s*<[0-9A-Fa-f\s]+>/.test(after),
      subFilter: pick(/\/SubFilter\s*\/([\w.]+)/),
      signer: pick(/\/Name\s*\(([^)]*)\)/),
      reason: pick(/\/Reason\s*\(([^)]*)\)/),
      location: pick(/\/Location\s*\(([^)]*)\)/),
      date: pick(/\/M\s*\((?:D:)?([^)]*)\)/),
      byteRange: pick(/\/ByteRange\s*\[([^\]]*)\]/),
      hexLen: hexm ? hexm[1].replace(/\s/g, '').length / 2 : 0,
    });
  }
  return {
    hasForm: items.length > 0 || /\/SigFlags/.test(raw),
    items,
    note: items.length
      ? '以上信息来自文档内签名字段。校验签名有效性需在专业阅读器中进行。'
      : '未在该文档中检测到电子签名字段。',
  };
}

/* ===== 38. 压缩 ===== */

export interface CompressResult {
  data: Uint8Array;
  before: number;
  after: number;
  mode: 'light' | 'deep';
}

export async function compressPdf(data: Uint8Array, mode: 'light' | 'deep', dpi = 2): Promise<CompressResult> {
  if (mode === 'light') {
    const doc = await loadDoc(data);
    const saved = await doc.save({ useObjectStreams: true });
    return { data: saved, before: data.length, after: saved.length, mode };
  }
  const { rasterizePdfToPdf } = await import('./pdfRaster');
  const paper = { w: 595.28, h: 841.89 };
  const out = await PDFDocument.create();
  await rasterizePdfToPdf(data, dpi, paper, out, true);
  const saved = await out.save();
  return { data: saved, before: data.length, after: saved.length, mode };
}

/* ===== 39/40. 解密与加密 ===== */

// 说明：pdf-lib 只能重新保存来「去除权限限制」（所有者密码/禁止打印复制等）。
// 设有「打开密码」的文档需输入密码才能读取内容，解除打开密码不在能力范围内，
// 此类文档可改用「压缩 - 深度模式」得到不含密码的图片版。
export async function decryptPdf(data: Uint8Array, password = ''): Promise<Uint8Array> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(data, { ignoreEncryption: true });
  } catch (e) {
    if (password) {
      // 用户提供了密码：pdf-lib 不支持带密码加载，给出明确提示
      throw new Error('该文档设有打开密码，当前无法直接解除；可改用「压缩 - 深度模式」转换');
    }
    throw new Error(`无法读取文档：${(e as Error).message}`);
  }
  // 能加载即重新保存为无加密版本（剥离 /Encrypt 与权限限制）
  return doc.save();
}

export interface EncryptOpts {
  userPassword: string;
  ownerPassword: string;
  printing: boolean;
  copying: boolean;
  modifying: boolean;
  annotating: boolean;
  r3?: boolean; // 128 位 RC4（默认 true）；false = 40 位，兼容旧阅读器
}

export async function encryptPdf(data: Uint8Array, opts: EncryptOpts): Promise<Uint8Array> {
  if (!opts.userPassword && !opts.ownerPassword) throw new Error('请至少设置打开密码或权限密码');
  const doc = await loadDoc(data);
  const { encryptWithPasswords } = await import('./pdfSecure');
  return encryptWithPasswords(doc, {
    userPassword: opts.userPassword,
    ownerPassword: opts.ownerPassword || opts.userPassword,
    permissions: {
      printing: opts.printing,
      copying: opts.copying,
      modifying: opts.modifying,
      annotating: opts.annotating,
    },
    r3: opts.r3 !== false,
  });
}

/* ===== 工具函数 ===== */

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export async function packZip(files: MultiOut[]): Promise<Blob> {
  const zip = new JSZip();
  for (const f of files) zip.file(f.name, f.data);
  return zip.generateAsync({ type: 'blob' });
}

export { splitName };
