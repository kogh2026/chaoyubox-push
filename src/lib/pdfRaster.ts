// PDF 工具箱栅格操作库（图像类）。
// 浏览器环境执行：pdfjs-dist 渲染 + canvas 像素处理 + pdf-lib 重建。
// 纯分析函数（空白率 / 内容边框 / 倾斜角）与渲染解耦，可在 node 下单测。
import { PDFDocument, PDFName } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import JSZip from 'jszip';
import { PAPER_SIZES_PT, type MultiOut } from './pdfTools';
import { buildOutline, readOutline } from './pdfOutline';
import { asyncPool, pageRange } from './asyncPool';
import { withCanvas } from './canvasUtil';
import { resolveRebuildQuality, qualityForScale } from './pdfTier';

// 页面渲染并发度：受内存/GPU 约束，4 是稳妥值（B5）
const RENDER_CONCURRENCY = 4;

// worker 仅在浏览器环境注入；node（单测）下 pdfjs 用自带 fake worker
if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
}

export interface ImageDataLike {
  data: Uint8ClampedArray; // RGBA
  width: number;
  height: number;
}

/* ===== 纯分析函数 ===== */

// 非白色像素比例（0-1）。alpha < 10 视为透明背景不计入。
export function nonWhiteRatio(img: ImageDataLike, lumThreshold = 246): number {
  const { data, width, height } = img;
  if (!width || !height) return 0;
  let ink = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] ?? 255;
    if (a < 10) continue;
    total++;
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (lum < lumThreshold) ink++;
  }
  return total === 0 ? 0 : ink / total;
}

// 空白页标记：ratio 低于 thresholdPct 判空白
export function blankFlagsFromRatios(ratios: number[], thresholdPct: number): boolean[] {
  const t = Math.max(0.01, thresholdPct) / 100;
  return ratios.map((r) => r < t);
}

// 内容包围盒（像素坐标，左上原点）；全白返回 null
export function contentBBox(
  img: ImageDataLike,
  lumThreshold = 246,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const { data, width, height } = img;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3] ?? 255;
      if (a < 10) continue;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum >= lumThreshold) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

// 倾斜角估计（度）。返回使文本行水平所需施加的旋转角（顺时针为正，与 pdfjs viewport 一致）。
// 做法：按候选角做行剪切，计算列投影方差——文本行水平时列投影最尖锐（方差最大）。
export function estimateSkewAngle(gray: Uint8Array, w: number, h: number, maxDeg = 8, stepDeg = 0.5): number {
  if (!w || !h) return 0;
  const profile = new Float64Array(w);
  // 在给定角度集合上找列投影方差最大的角度（文本行被剪平时投影最尖锐）
  const scoreAt = (a: number): number => {
    const tan = Math.tan((a * Math.PI) / 180);
    profile.fill(0);
    for (let y = 0; y < h; y++) {
      // 亚像素移位 + 线性插值，避免 Math.round 量化带来的角度偏差
      const shiftF = y * tan;
      const s0 = Math.floor(shiftF);
      const frac = shiftF - s0;
      const rowOff = y * w;
      for (let x = 0; x < w; x++) {
        const sx = x + s0;
        if (sx < 0 || sx >= w) continue;
        const v0 = 255 - gray[rowOff + sx];
        if (frac > 0 && sx + 1 < w) {
          const v1 = 255 - gray[rowOff + sx + 1];
          profile[x] += v0 + (v1 - v0) * frac;
        } else {
          profile[x] += v0;
        }
      }
    }
    let mean = 0;
    for (let x = 0; x < w; x++) mean += profile[x];
    mean /= w;
    let variance = 0;
    for (let x = 0; x < w; x++) {
      const d = profile[x] - mean;
      variance += d * d;
    }
    return variance / w;
  };
  // 第一轮：粗扫
  let best = 0;
  let bestScore = -1;
  for (let a = -maxDeg; a <= maxDeg + 1e-9; a += stepDeg) {
    const s = scoreAt(a);
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  // 第二轮：在粗扫最优值附近精扫（0.1° 步进），提升估计精度
  let fine = best;
  let fineScore = bestScore;
  for (let a = best - stepDeg; a <= best + stepDeg + 1e-9; a += 0.1) {
    if (a < -maxDeg || a > maxDeg) continue;
    const s = scoreAt(a);
    if (s > fineScore) {
      fineScore = s;
      fine = a;
    }
  }
  return Math.round(fine * 10) / 10;
}

/* ===== 渲染基础设施（浏览器） ===== */

async function openPdf(data: Uint8Array): Promise<pdfjsLib.PDFDocumentProxy> {
  return pdfjsLib.getDocument({ data: new Uint8Array(data) }).promise;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

async function renderPage(
  page: pdfjsLib.PDFPageProxy,
  scale: number,
  rotation = 0,
): Promise<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }> {
  const viewport = page.getViewport({ scale, rotation });
  const canvas = makeCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布上下文');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { canvas, ctx };
}

function toGray(img: ImageDataLike): Uint8Array {
  const { data } = img;
  const out = new Uint8Array((data.length / 4) | 0);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    out[j] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
  }
  return out;
}

async function canvasToBytes(canvas: HTMLCanvasElement, quality = 0.9): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图片导出失败'))), 'image/jpeg', quality);
  });
  return new Uint8Array(await blob.arrayBuffer());
}

/* ===== 空白页检测 ===== */

export async function analyzeBlankPages(data: Uint8Array, thresholdPct = 0.3): Promise<boolean[]> {
  const pdf = await openPdf(data);
  const flags: boolean[] = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const { ctx } = await renderPage(page, 0.5);
      const ratio = nonWhiteRatio(ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height));
      flags.push(ratio < Math.max(0.01, thresholdPct) / 100);
      page.cleanup();
    }
  } finally {
    pdf.destroy();
  }
  return flags;
}

/* ===== 裁剪白边（无损：设置 CropBox） ===== */

export interface CropResult {
  data: Uint8Array;
  cropped: number; // 实际裁剪的页数
}

export async function cropWhiteBorders(
  data: Uint8Array,
  opts: { threshold?: number; marginMm?: number; renderScale?: number } = {},
): Promise<CropResult> {
  const threshold = opts.threshold ?? 246;
  const margin = (opts.marginMm ?? 2) * (72 / 25.4);
  const scale = opts.renderScale ?? 1.5;
  const src = await PDFDocument.load(data, { ignoreEncryption: true });
  const pdf = await openPdf(data);
  const out = await PDFDocument.create();
  let cropped = 0;
  try {
    for (let i = 0; i < src.getPageCount(); i++) {
      const page = await pdf.getPage(i + 1);
      const { ctx } = await renderPage(page, scale);
      const img = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
      page.cleanup();
      const bbox = contentBBox(img, threshold);
      const srcPage = src.getPage(i);
      const rot = ((srcPage.getRotation().angle % 360) + 360) % 360;
      const { width: pw, height: ph } = srcPage.getSize();
      const [p] = await out.copyPages(src, [i]);
      if (!bbox || rot !== 0) {
        // 旋转页的 CropBox 坐标系不同，跳过裁剪保持原样
        out.addPage(p);
        continue;
      }
      const x0 = Math.max(0, bbox.x0 / scale - margin);
      const y0 = Math.max(0, bbox.y0 / scale - margin);
      const x1 = Math.min(pw, bbox.x1 / scale + margin);
      const y1 = Math.min(ph, bbox.y1 / scale + margin);
      if (x1 - x0 < pw * 0.05 || y1 - y0 < ph * 0.05) {
        out.addPage(p); // 内容几乎铺满，不裁
        continue;
      }
      // 像素坐标（上原点）-> PDF 坐标（下原点）
      const box = [x0, ph - y1, x1, ph - y0];
      p.node.set(PDFName.of('CropBox'), out.context.obj(box));
      cropped++;
      out.addPage(p);
    }
  } finally {
    pdf.destroy();
  }
  if (cropped === 0) throw new Error('没有页面检测到可裁剪的白边');
  return { data: await out.save(), cropped };
}

/* ===== 倾斜校正（重渲染为图片页） ===== */

export async function deskewPdf(
  data: Uint8Array,
  opts: { auto: boolean; angle: number; dpi?: number; quality?: number },
): Promise<Uint8Array> {
  const dpi = opts.dpi ?? 2;
  const quality = resolveRebuildQuality(opts.quality, 0.88);
  const pdf = await openPdf(data);
  const out = await PDFDocument.create();
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      let rotation = opts.auto ? 0 : opts.angle;
      if (opts.auto) {
        const { ctx } = await renderPage(page, 1);
        const img = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
        const skew = estimateSkewAngle(toGray(img), img.width, img.height);
        rotation = Math.round(skew * 10) / 10;
        ctx.canvas.width = 0;
        ctx.canvas.height = 0;
      }
      const { canvas } = await renderPage(page, dpi, rotation);
      const bytes = await canvasToBytes(canvas, quality);
      const emb = await out.embedJpg(bytes);
      const viewport = page.getViewport({ scale: dpi, rotation });
      const p = out.addPage([viewport.width, viewport.height]);
      p.drawImage(emb, { x: 0, y: 0, width: viewport.width, height: viewport.height });
      page.cleanup();
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    pdf.destroy();
  }
  return out.save();
}

/* ===== 通用：整档重渲染为图片 PDF（扁平化 / 滤镜 / 蓝图 / 扫描模拟 / 压缩） ===== */

export type PageFilter = 'bw' | 'gray' | 'sharpen' | 'invert';

export interface RebuildOpts {
  dpi?: number;
  /** 显式 JPEG 质量；未给出时按渲染倍率自动选档（qualityForScale），保证体积与清晰度匹配 */
  quality?: number;
  filter?: PageFilter;
  blueprint?: boolean;
  scan?: { rotate: boolean; edge: boolean; tint: string; noise: number };
  keepBookmarks?: boolean;
}

function applyFilterToImage(img: ImageDataLike, filter: PageFilter): void {
  const { data } = img;
  if (filter === 'invert') {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255 - data[i];
      data[i + 1] = 255 - data[i + 1];
      data[i + 2] = 255 - data[i + 2];
    }
    return;
  }
  if (filter === 'gray') {
    for (let i = 0; i < data.length; i += 4) {
      const g = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
      data[i] = data[i + 1] = data[i + 2] = g;
    }
    return;
  }
  if (filter === 'bw') {
    for (let i = 0; i < data.length; i += 4) {
      const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const v = g < 165 ? 0 : 255;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
    return;
  }
  // sharpen：3x3 卷积
  const w = img.width;
  const h = img.height;
  const src = new Uint8ClampedArray(data.length);
  src.set(data);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const up = y > 0 ? src[i - w * 4 + c] : src[i + c];
        const dn = y < h - 1 ? src[i + w * 4 + c] : src[i + c];
        const lf = x > 0 ? src[i - 4 + c] : src[i + c];
        const rt = x < w - 1 ? src[i + 4 + c] : src[i + c];
        const v = 5 * src[i + c] - up - dn - lf - rt;
        data[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
}

function applyBlueprint(img: ImageDataLike): void {
  const { data } = img;
  const bg: [number, number, number] = [31, 78, 158]; // 蓝图蓝
  for (let i = 0; i < data.length; i += 4) {
    const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    // 墨迹（暗）-> 白线；纸面（亮）-> 蓝底
    const k = 1 - g / 255;
    data[i] = bg[0] + (255 - bg[0]) * k;
    data[i + 1] = bg[1] + (255 - bg[1]) * k;
    data[i + 2] = bg[2] + (255 - bg[2]) * k;
  }
}

function hexToRgbLocal(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [245, 240, 220];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function applyScanSim(img: ImageDataLike, scan: NonNullable<RebuildOpts['scan']>, pageIdx: number): void {
  const { data, width: w, height: h } = img;
  const tint = hexToRgbLocal(scan.tint);
  // 底色：向 tint 混合
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (data[i] * 0.92 + tint[0] * 0.08) | 0;
    data[i + 1] = (data[i + 1] * 0.92 + tint[1] * 0.08) | 0;
    data[i + 2] = (data[i + 2] * 0.92 + tint[2] * 0.08) | 0;
  }
  // 噪点
  if (scan.noise > 0) {
    const amp = Math.min(60, scan.noise);
    for (let i = 0; i < data.length; i += 4) {
      const n = (Math.random() - 0.5) * amp;
      data[i] = Math.max(0, Math.min(255, data[i] + n));
      data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + n));
      data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + n));
    }
  }
  // 黑边（上下左侧渐变暗角）
  if (scan.edge) {
    const band = Math.max(2, Math.round(Math.min(w, h) * 0.012));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.min(x, y, w - 1 - x, h - 1 - y);
        if (d >= band) continue;
        const k = 1 - d / band;
        const i = (y * w + x) * 4;
        data[i] *= 1 - k * 0.55;
        data[i + 1] *= 1 - k * 0.55;
        data[i + 2] *= 1 - k * 0.55;
      }
    }
  }
  void pageIdx;
}

// 整档重建：可选滤镜 / 蓝图 / 扫描模拟 / 保留书签
export async function rebuildPdfAsImages(data: Uint8Array, opts: RebuildOpts = {}): Promise<Uint8Array> {
  const dpi = opts.dpi ?? 2;
  const quality = resolveRebuildQuality(opts.quality, qualityForScale(dpi));
  const pdf = await openPdf(data);
  const out = await PDFDocument.create();
  try {
    // B5：并发渲染各页（受 RENDER_CONCURRENCY 限制），再按页序写入，结果与串行一致
    const rendered = await asyncPool(pageRange(pdf.numPages), RENDER_CONCURRENCY, async (i) => {
      const page = await pdf.getPage(i);
      const rotation = opts.scan?.rotate ? (i % 2 === 0 ? 0.6 : -0.7) : 0;
      const { ctx } = await renderPage(page, dpi, rotation);
      const img = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
      if (opts.filter) applyFilterToImage(img, opts.filter);
      if (opts.blueprint) applyBlueprint(img);
      if (opts.scan) applyScanSim(img, opts.scan, i);
      ctx.putImageData(img, 0, 0);
      const bytes = await canvasToBytes(ctx.canvas, quality);
      const viewport = page.getViewport({ scale: dpi, rotation });
      page.cleanup();
      ctx.canvas.width = 0; // F13：及时释放位图内存
      ctx.canvas.height = 0;
      return { bytes, w: viewport.width, h: viewport.height };
    });
    for (const r of rendered) {
      const emb = await out.embedJpg(r.bytes);
      const p = out.addPage([r.w, r.h]);
      p.drawImage(emb, { x: 0, y: 0, width: r.w, height: r.h });
    }
  } finally {
    pdf.destroy();
  }
  if (opts.keepBookmarks) {
    const nodes = await readOutline(data);
    if (nodes.length) buildOutline(out, nodes, (p) => p); // 页码 1:1
  }
  return out.save();
}

// 扁平化 = 重渲染为图片（保留书签）
export async function flattenPdf(data: Uint8Array, dpi?: number): Promise<Uint8Array> {
  return rebuildPdfAsImages(data, { dpi, keepBookmarks: true });
}

// 把源 PDF 逐页渲染后嵌入 out 文档（合并兼容模式 / 深度压缩用）
export async function rasterizePdfToPdf(
  data: Uint8Array,
  dpi: number,
  pageSizePt: { w: number; h: number },
  out: PDFDocument,
  keepAspect = false,
  quality?: number,
): Promise<void> {
  const q = resolveRebuildQuality(quality, qualityForScale(dpi));
  const pdf = await openPdf(data);
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const { canvas } = await renderPage(page, dpi);
      const bytes = await canvasToBytes(canvas, q);
      const emb = await out.embedJpg(bytes);
      let pw = pageSizePt.w;
      let ph = pageSizePt.h;
      if (keepAspect) {
        const v = page.getViewport({ scale: dpi });
        pw = v.width;
        ph = v.height;
      }
      const p = out.addPage([pw, ph]);
      const k = Math.min(pw / emb.width, ph / emb.height);
      const iw = emb.width * k;
      const ih = emb.height * k;
      p.drawImage(emb, { x: (pw - iw) / 2, y: (ph - ih) / 2, width: iw, height: ih });
      page.cleanup();
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    pdf.destroy();
  }
}

/* ===== PDF 转图片（ZIP） ===== */

export interface ToImagesOpts2 {
  dpi: number;
  format: 'image/jpeg' | 'image/png';
  quality: number;
}

export async function pdfToImagesZip(data: Uint8Array, baseName: string, opts: ToImagesOpts2): Promise<Blob> {
  const scale = Math.max(0.5, opts.dpi);
  const pdf = await openPdf(data);
  const zip = new JSZip();
  const ext = opts.format === 'image/png' ? 'png' : 'jpg';
  const stem = baseName.replace(/\.pdf$/i, '');
  try {
    const pages = await asyncPool(pageRange(pdf.numPages), RENDER_CONCURRENCY, async (i) => {
      const page = await pdf.getPage(i);
      const { canvas } = await renderPage(page, scale);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图片导出失败'))), opts.format, opts.quality);
      });
      page.cleanup();
      canvas.width = 0; // F13
      canvas.height = 0;
      return { i, blob };
    });
    for (const { i, blob } of pages) {
      zip.file(`${stem}_p${String(i).padStart(3, '0')}.${ext}`, blob);
    }
  } finally {
    pdf.destroy();
  }
  return zip.generateAsync({ type: 'blob' });
}

/* ===== 提取 PDF 内嵌图片 ===== */

export interface ExtractedImage {
  name: string;
  blob: Blob;
  width: number;
  height: number;
}

export async function extractImages(data: Uint8Array): Promise<ExtractedImage[]> {
  const pdf = await openPdf(data);
  const out: ExtractedImage[] = [];
  const seen = new Set<string>();
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const ops = await page.getOperatorList();
      for (let k = 0; k < ops.fnArray.length; k++) {
        if (ops.fnArray[k] !== pdfjsLib.OPS.paintImageXObject) continue;
        const name = String(ops.argsArray[k][0]);
        if (seen.has(name)) continue;
        seen.add(name);
        try {
          const img = (await page.objs.get(name)) as unknown;
          const canvas = img as HTMLCanvasElement;
          if (!canvas || typeof canvas.getContext !== 'function') continue;
          const w = canvas.width;
          const h = canvas.height;
          if (!w || !h) continue;
          // F13：临时画布用 withCanvas 包裹，结束后自动释放位图内存
          const blob = await withCanvas(w, h, async (c, ctx) => {
            ctx.drawImage(canvas, 0, 0);
            return new Promise<Blob>((resolve, reject) => {
              c.toBlob((b) => (b ? resolve(b) : reject(new Error('图片导出失败'))), 'image/png');
            });
          });
          out.push({ name: `img_p${i}_${out.length + 1}.png`, blob, width: w, height: h });
        } catch {
          // 单张图片解析失败不影响整体
        } finally {
          // F13：释放 pdfjs 页面对象缓存，避免大文档图片常驻内存
          try {
            (page as unknown as { objs?: { destroy?: (id: string) => void } }).objs?.destroy?.(name);
          } catch {
            /* 某些 pdfjs 版本无 destroy，忽略 */
          }
        }
      }
      page.cleanup();
    }
  } finally {
    pdf.destroy();
  }
  if (out.length === 0) throw new Error('没有在该文档中找到可提取的图片');
  return out;
}

export async function extractImagesZip(data: Uint8Array, baseName: string): Promise<Blob> {
  const imgs = await extractImages(data);
  const zip = new JSZip();
  const stem = baseName.replace(/\.pdf$/i, '');
  for (const im of imgs) zip.file(im.name.replace(/^img_/, `${stem}_`), im.blob);
  return zip.generateAsync({ type: 'blob' });
}

/* ===== 缩略图（重排 / 逐页旋转面板用） ===== */

export interface Thumb {
  index: number; // 0 起
  url: string; // Blob URL（G15：比 base64 dataURL 更省内存，不再常驻大字符串）
  w: number;
  h: number;
}

export async function renderThumbs(data: Uint8Array, scale = 0.32): Promise<Thumb[]> {
  const pdf = await openPdf(data);
  try {
    const out = await asyncPool(pageRange(pdf.numPages), RENDER_CONCURRENCY, async (i) => {
      const page = await pdf.getPage(i);
      const { canvas } = await renderPage(page, scale);
      const w = canvas.width;
      const h = canvas.height;
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('缩略图导出失败'))), 'image/jpeg', 0.72);
      });
      const url = URL.createObjectURL(blob);
      page.cleanup();
      canvas.width = 0; // F13
      canvas.height = 0;
      return { index: i - 1, url, w, h };
    });
    return out;
  } finally {
    pdf.destroy();
  }
}

/** 释放缩略图 Blob URL（组件卸载 / 重新加载时调用，避免内存泄漏） */
export function releaseThumbs(thumbs: Thumb[]): void {
  for (const t of thumbs) {
    try {
      URL.revokeObjectURL(t.url);
    } catch {
      /* 已释放或非 blob URL，忽略 */
    }
  }
}

/* ===== 小册子拆分（扫描对开页切开重排） ===== */

export type SplitDir = 'auto' | 'lr' | 'tb';

export async function bookletSplit(inputs: { name: string; data: Uint8Array }[], dir: SplitDir): Promise<Uint8Array> {
  const halves: { canvas: HTMLCanvasElement }[] = [];
  for (const f of inputs) {
    const pdf = await openPdf(f.data);
    try {
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const { canvas } = await renderPage(page, 2);
        const w = canvas.width;
        const h = canvas.height;
        let vertical = w > h * 1.1;
        if (dir === 'tb') vertical = false;
        if (dir === 'lr') vertical = true;
        if (vertical) {
          const c = makeCanvas(w / 2, h);
          const ctx = c.getContext('2d');
          if (!ctx) throw new Error('无法创建画布上下文');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(canvas, 0, 0, w / 2, h, 0, 0, w / 2, h);
          halves.push({ canvas: c });
          const c2 = makeCanvas(w / 2, h);
          const ctx2 = c2.getContext('2d');
          if (!ctx2) throw new Error('无法创建画布上下文');
          ctx2.fillStyle = '#fff';
          ctx2.fillRect(0, 0, c2.width, c2.height);
          ctx2.drawImage(canvas, w / 2, 0, w / 2, h, 0, 0, w / 2, h);
          halves.push({ canvas: c2 });
        } else {
          const c = makeCanvas(w, h / 2);
          const ctx = c.getContext('2d');
          if (!ctx) throw new Error('无法创建画布上下文');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(canvas, 0, 0, w, h / 2, 0, 0, w, h / 2);
          halves.push({ canvas: c });
          const c2 = makeCanvas(w, h / 2);
          const ctx2 = c2.getContext('2d');
          if (!ctx2) throw new Error('无法创建画布上下文');
          ctx2.fillStyle = '#fff';
          ctx2.fillRect(0, 0, c2.width, c2.height);
          ctx2.drawImage(canvas, 0, h / 2, w, h / 2, 0, 0, w, h / 2);
          halves.push({ canvas: c2 });
        }
        page.cleanup();
      }
    } finally {
      pdf.destroy();
    }
  }
  if (halves.length < 2) throw new Error('至少需要 1 页对开内容');
  // 输入顺序约定：每张纸的正面、背面交替（第1张正/反、第2张正/反……）。
  // 骑马订阅读序：正右、次左 交替向前，再反向收尾。
  // 推导：第1张=[n,1]、第2张=[2,n-1]、第3张=[n-2,3]…
  // 阅读序 = h1(1), h2(2), h5(3), h6(4), h7(5), h4(6), h3(7), h0(8)（n=8）
  // 对开数不是 4 的倍数时补白，保证顺序推导成立
  while (halves.length % 4 !== 0) {
    const c = makeCanvas(600, 800);
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
    }
    halves.push({ canvas: c });
  }
  const mm = halves.length;
  const order: number[] = [];
  if (mm === 2) {
    order.push(0, 1); // 单张两页：本身就是顺序
  } else {
    for (let j = 0; j < mm / 2; j += 2) {
      order.push(2 * j + 1); // 第 j 张右半
      if (2 * j + 2 < mm) order.push(2 * j + 2); // 第 j+1 张左半
    }
    for (let j = Math.floor(mm / 2) - 1; j >= 1; j -= 2) {
      order.push(2 * j + 1); // 第 j 张右半
      order.push(2 * j - 2); // 第 j-1 张左半
    }
  }
  const out = await PDFDocument.create();
  for (const idx of order) {
    if (idx < 0 || idx >= mm) continue;
    const bytes = await canvasToBytes(halves[idx].canvas, 0.88);
    const emb = await out.embedJpg(bytes);
    const p = out.addPage([emb.width, emb.height]);
    p.drawImage(emb, { x: 0, y: 0, width: emb.width, height: emb.height });
  }
  return out.save();
}

export { PAPER_SIZES_PT };
export type { MultiOut };
