// 批量打印的送印计划：把「页级打印模式」翻译成一次送印所需的参数。
//
// 这里不再把 PDF 按颜色拆成多个子 PDF 依次送印。拆任务有两个隐患：
//   1) 多个打印任务进队列后，页序只能靠队列先后保证，中间插进别的文档就乱序；
//   2) 黑白/彩色交替的文档会被拆成几十个任务，每个任务都要重新走一遍打印初始化。
// 改为「一个文件一次送印」，页级灰度改成送印参数里的 grayPages 标记（索引 = 页码-1），
// 由主进程的打印载体页在栅格化时按页套用灰度，页序天然不变。
import type { PageMode } from './quote';

export interface PrintPage {
  /** 1 起的页码（与 pdfAnalyze 的 perPage.page 一致） */
  page: number;
  mode: PageMode;
}

export interface PrintPlan {
  /** 需要送印的页码（1 起、升序，已剔除「不打印」） */
  pageIndexes: number[];
  /** 与原文档页序对齐的灰度标记：索引 = 页码 - 1，跳过的页留 false */
  grayPages: boolean[];
  /** 各模式页数统计（UI 提示用） */
  counts: { bw: number; dot: number; color: number };
}

/** 该模式是否走灰度：仅「黑白」灰度；「点彩」含红章，必须彩色输出才不丢信息。 */
export function grayscaleOfMode(mode: Exclude<PageMode, 'none'>): boolean {
  return mode === 'bw';
}

/** 纯函数（可单测）：页模式 → 送印计划。'none'（不打印）的页直接剔除。 */
export function buildPrintPlan(perPage: PrintPage[]): PrintPlan {
  const pageIndexes: number[] = [];
  const grayPages: boolean[] = [];
  const counts = { bw: 0, dot: 0, color: 0 };
  for (const p of perPage) {
    if (p.mode === 'none') continue;
    pageIndexes.push(p.page);
    counts[p.mode] += 1;
    // 索引必须严格等于「页码 - 1」：中间被跳过的页要留空位，否则灰度标记整体错位
    while (grayPages.length < p.page - 1) grayPages.push(false);
    grayPages[p.page - 1] = grayscaleOfMode(p.mode);
  }
  return { pageIndexes, grayPages, counts };
}

/**
 * 图片文件 → 单页 PDF（页面尺寸按图片像素以 96DPI 折算为 pt，保持原始成像尺寸）。
 * 批量打印允许直接拖入图片，送印前需要统一的 PDF 载体。
 */
export async function imageFileToPdfBytes(file: File): Promise<Uint8Array> {
  if (typeof document === 'undefined') throw new Error('图片转 PDF 需要浏览器画布环境');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('图片加载失败'));
      el.src = url;
    });
    const w = Math.max(1, Math.round((img.naturalWidth * 72) / 96));
    const h = Math.max(1, Math.round((img.naturalHeight * 72) / 96));
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d');
    if (!ctx) throw new Error('无法创建画布上下文');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0);
    const jpg = cv.toDataURL('image/jpeg', 0.95);
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit: 'pt', format: [w, h] });
    doc.addImage(jpg, 'JPEG', 0, 0, w, h);
    const ab = doc.output('arraybuffer');
    return new Uint8Array(ab as ArrayBuffer);
  } finally {
    URL.revokeObjectURL(url);
  }
}
