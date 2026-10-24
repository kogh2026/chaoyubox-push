import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export type ColorMode = 'bw' | 'dot' | 'color';

export interface PageColor {
  page: number;
  mode: ColorMode;
  colorRatio: number;
  redRatio?: number; // 红章/红头像素占比
  size?: string; // 识别出的纸张尺寸（A4/A3/A5…，空=非常规）
}

export interface FileAnalysis {
  name: string;
  pages: number;
  perPage: PageColor[];
  thumbs: string[]; // 每页缩略图（JPEG dataURL，宽约 150px）
  warnings: string[];
  detectedSize?: string; // 全文主导纸张尺寸
}

// 阈值：彩色像素占比。bw 极少，dot 是小面积彩色（如红章），color 是大面积。
const DOT_THRESHOLD = 0.005;
const COLOR_THRESHOLD = 0.02;
// 红章：偏红像素占比超过该值视为"有红章"（BatchPrint 用同一常量判断）
export const RED_STAMP_THRESHOLD = 0.004;

function makeThumb(src: HTMLCanvasElement): string {
  const tw = 150;
  const th = Math.max(1, Math.round((src.height * tw) / src.width));
  const c = document.createElement('canvas');
  c.width = tw;
  c.height = th;
  c.getContext('2d')!.drawImage(src, 0, 0, tw, th);
  return c.toDataURL('image/jpeg', 0.6);
}

// 在一张已栅格化的 imageData 上采样，算彩色像素占比
export function colorRatioOf(img: ImageData): number {
  const d = img.data;
  let colored = 0;
  const total = img.width * img.height;
  const step = Math.max(1, Math.floor(total / 4000));
  let sampled = 0;
  for (let i = 0; i < d.length; i += 4 * step) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const diff = max - min;
    if (diff > 40 && max > 30) colored++;
    sampled++;
  }
  return sampled === 0 ? 0 : colored / sampled;
}

// 红章/红头检测：明显偏红（R 远大于 G、B）的像素占比
export function redRatioOf(img: ImageData): number {
  const d = img.data;
  let red = 0;
  const total = img.width * img.height;
  const step = Math.max(1, Math.floor(total / 6000));
  let sampled = 0;
  for (let i = 0; i < d.length; i += 4 * step) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    if (r > 110 && r - g > 45 && r - b > 45) red++;
    sampled++;
  }
  return sampled === 0 ? 0 : red / sampled;
}

export function classify(ratio: number): ColorMode {
  if (ratio < DOT_THRESHOLD) return 'bw';
  if (ratio < COLOR_THRESHOLD) return 'dot';
  return 'color';
}

/* ===== 纸张尺寸识别（按 PDF 页面物理尺寸，单位 pt，1pt=1/72 英寸） ===== */
const PAPER_SIZES: [string, number, number][] = [
  // [名称, 短边pt, 长边pt]（竖版口径，判断时与方向无关）
  ['A5', 419.5, 595.3],
  ['B5', 498.9, 708.7],
  ['A4', 595.3, 841.9],
  ['Letter', 612, 792],
  ['Legal', 612, 1008],
  ['A3', 841.9, 1190.6],
  ['A2', 1190.6, 1683.8],
  ['A1', 1683.8, 2383.9],
  ['A0', 2383.9, 3370.4],
];

/** 按 pt 尺寸识别纸张名；非常规尺寸返回 '' */
export function classifyPaper(wPt: number, hPt: number): string {
  const s = Math.min(wPt, hPt);
  const l = Math.max(wPt, hPt);
  for (const [name, sw, lw] of PAPER_SIZES) {
    if (Math.abs(s - sw) / sw < 0.03 && Math.abs(l - lw) / lw < 0.03) return name;
  }
  return '';
}

/** 从一组页尺寸里取主导尺寸（出现最多的非空值） */
function dominantSize(sizes: string[]): string {
  const cnt: Record<string, number> = {};
  let best = '';
  let bestN = 0;
  for (const v of sizes) {
    if (!v) continue;
    cnt[v] = (cnt[v] ?? 0) + 1;
    if (cnt[v] > bestN) {
      bestN = cnt[v];
      best = v;
    }
  }
  return best;
}

async function analyzeImageFile(file: File): Promise<FileAnalysis> {
  const url = URL.createObjectURL(file);
  const imgEl = new Image();
  imgEl.src = url;
  await imgEl.decode().catch(() => {});
  const w = Math.min(imgEl.naturalWidth || 800, 400);
  const h = Math.round((w * (imgEl.naturalHeight || 800)) / (imgEl.naturalWidth || 800));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(imgEl, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const ratio = colorRatioOf(img);
  const red = redRatioOf(img);
  URL.revokeObjectURL(url);
  return {
    name: file.name,
    pages: 1,
    perPage: [{ page: 1, mode: classify(ratio), colorRatio: ratio, redRatio: red }],
    thumbs: [makeThumb(canvas)],
    warnings: [],
  };
}

async function analyzePdfFile(file: File): Promise<FileAnalysis> {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const warnings: string[] = [];
  const perPage: PageColor[] = [];
  const thumbs: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const scale = 0.3;
    const viewport = page.getViewport({ scale });
    // 物理尺寸（pt）→ 纸张名
    const vp1 = page.getViewport({ scale: 1 });
    const paper = classifyPaper(vp1.width, vp1.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d')!;
    await page.render({ canvasContext: ctx, viewport }).promise;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const ratio = colorRatioOf(img);
    perPage.push({ page: i, mode: classify(ratio), colorRatio: ratio, redRatio: redRatioOf(img), size: paper });
    thumbs.push(makeThumb(canvas));
    if (viewport.width > viewport.height) {
      warnings.push(`第 ${i} 页为横版`);
    }
  }
  return { name: file.name, pages: pdf.numPages, perPage, thumbs, warnings, detectedSize: dominantSize(perPage.map((p) => p.size ?? '')) };
}

export async function analyzeFile(file: File): Promise<FileAnalysis> {
  const t = file.type;
  if (t === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    return analyzePdfFile(file);
  }
  if (t.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name)) {
    return analyzeImageFile(file);
  }
  return {
    name: file.name,
    pages: 1,
    perPage: [{ page: 1, mode: 'bw', colorRatio: 0, redRatio: 0 }],
    thumbs: [],
    warnings: ['非 PDF/图片，第一阶段暂按 1 页计；需先转 PDF'],
  };
}
