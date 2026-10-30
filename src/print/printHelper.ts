// 打印载体（隐藏窗口里跑）：把主进程送来的 PDF 栅格化成高清位图，拼成一页一张的 DOM，
// 再由主进程对「这个窗口」调用 webContents.print 静默送印。
//
// 为什么不直接把 PDF 交给 Chromium 的 PDF 查看器打印：Electron 的打印合成管线拿不到
// pepper 插件（PDFium 查看器）里的内容，实测打印产物是 819 字节的空白页；同样的页面
// 用普通 HTML 承载则是 12847 字节。所以这里自己栅格化，绕开插件打印路径。
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/** 主进程下发的打印任务（与 electron/preload.cjs 的 print-job-pull 对应） */
interface PrintJob {
  data: Uint8Array | ArrayBuffer;
  opts?: {
    /** 栅格化分辨率，默认 300 */
    dpi?: number;
    /** 整份任务强制灰度（打印预设里选了「黑白」） */
    grayscale?: boolean;
    /** 原文档页序对齐的灰度标记，索引 = 页码 - 1 */
    grayPages?: boolean[];
    /** 只打印这些页（1 起），缺省为全部 */
    pages?: number[];
  };
}

interface HelperReady {
  ok: boolean;
  pageCount?: number;
  widthPt?: number;
  heightPt?: number;
  dpi?: number;
  /** 各页纸张尺寸不一致（已按首页尺寸统一装订，其余页留白边） */
  mixedSize?: boolean;
  error?: string;
}

interface Bridge {
  printJobPull?: () => Promise<PrintJob | null>;
  printHelperReady?: (info: HelperReady) => Promise<unknown>;
}

const bridge = (window as unknown as { electronAPI?: Bridge }).electronAPI;

const DEFAULT_DPI = 300;
const MIN_DPI = 96;
const MAX_DPI = 600;
/** JPEG 质量：300DPI 下 0.92 对文字/照片都够，再高只是白涨体积 */
const JPEG_QUALITY = 0.92;

/**
 * 页数极多时才降档：峰值内存只跟「单页画布」相关（一页渲染完立刻编码释放），
 * 页数主要影响耗时，所以只有超长文档才降 DPI，免得把用户要求的清晰度悄悄改掉。
 */
function clampDpi(want: number | undefined, pageCount: number): number {
  const asked = Number.isFinite(want) && (want as number) > 0 ? Math.round(want as number) : DEFAULT_DPI;
  const cap = pageCount > 100 ? 200 : pageCount > 40 ? 250 : MAX_DPI;
  return Math.min(cap, Math.max(MIN_DPI, asked));
}

function canvasToBlobUrl(cv: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    cv.toBlob(
      (b) => (b ? resolve(URL.createObjectURL(b)) : reject(new Error('位图编码失败'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

/** 灰度化：用 canvas filter 交给 GPU，比逐像素遍历快一个量级 */
function toGray(src: HTMLCanvasElement, dst: HTMLCanvasElement): void {
  dst.width = src.width;
  dst.height = src.height;
  const ctx = dst.getContext('2d');
  if (!ctx) throw new Error('无法创建灰度画布');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, dst.width, dst.height);
  ctx.filter = 'grayscale(1)';
  ctx.drawImage(src, 0, 0);
  ctx.filter = 'none';
}

async function renderJob(job: PrintJob): Promise<HelperReady> {
  const raw = job.data instanceof Uint8Array ? job.data : new Uint8Array(job.data);
  // pdfjs 会接管（并可能转移）传入的 buffer，这里给一份自己的副本，避免影响主进程那份
  const doc = await pdfjsLib.getDocument({ data: raw.slice() }).promise;
  try {
    const total = doc.numPages;
    const wanted = Array.isArray(job.opts?.pages)
      ? job.opts!.pages!.filter((p) => Number.isInteger(p) && p >= 1 && p <= total)
      : [];
    const selected = wanted.length ? [...new Set(wanted)].sort((a, b) => a - b) : Array.from({ length: total }, (_, i) => i + 1);
    if (selected.length === 0) throw new Error('没有可打印的页面');

    const dpi = clampDpi(job.opts?.dpi, selected.length);
    const scale = dpi / 72;
    const grayFlags = job.opts?.grayPages ?? [];
    const forceGray = job.opts?.grayscale === true;

    const app = document.getElementById('app');
    if (!app) throw new Error('载体页缺少挂载点');
    app.textContent = '';

    // 两块画布循环复用：一页一页渲染 → 编码 → 立刻释放，峰值内存只跟单页大小相关
    const color = document.createElement('canvas');
    const gray = document.createElement('canvas');
    const style = document.createElement('style');
    let pageW = 0;
    let pageH = 0;
    let mixedSize = false;

    for (let i = 0; i < selected.length; i++) {
      const no = selected[i];
      const page = await doc.getPage(no);
      const base = page.getViewport({ scale: 1 });
      const wPt = base.width;
      const hPt = base.height;
      if (i === 0) {
        pageW = wPt;
        pageH = hPt;
        // @page 决定打印纸张尺寸，必须与位图同比例，否则会被缩放或裁切
        style.textContent = `@page { size: ${wPt}pt ${hPt}pt; margin: 0; }`;
        document.head.appendChild(style);
      } else if (Math.abs(wPt - pageW) > 0.5 || Math.abs(hPt - pageH) > 0.5) {
        mixedSize = true;
      }

      const vp = page.getViewport({ scale });
      color.width = Math.max(1, Math.round(vp.width));
      color.height = Math.max(1, Math.round(vp.height));
      const ctx = color.getContext('2d');
      if (!ctx) throw new Error('无法创建画布上下文');
      // PDF 页面可能透明，JPEG 无 alpha，先铺白底否则会变黑
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, color.width, color.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      page.cleanup();

      const isGray = forceGray || grayFlags[no - 1] === true;
      const url = await canvasToBlobUrl(isGray ? (toGray(color, gray), gray) : color);

      const box = document.createElement('div');
      box.className = 'pg';
      box.style.width = `${pageW}pt`;
      box.style.height = `${pageH}pt`;
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      box.appendChild(img);
      app.appendChild(box);
    }

    // 位图必须解码完成再打印，否则打印管线可能拿到空白图
    const imgs = Array.from(app.querySelectorAll('img'));
    await Promise.all(imgs.map((im) => im.decode().catch(() => undefined)));
    // 两帧 rAF：确保布局与尺寸已落定
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));

    return { ok: true, pageCount: selected.length, widthPt: pageW, heightPt: pageH, dpi, mixedSize };
  } finally {
    doc.destroy().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (!bridge?.printJobPull || !bridge.printHelperReady) {
    document.title = 'print-helper: no bridge';
    return;
  }
  let info: HelperReady;
  try {
    const job = await bridge.printJobPull();
    if (!job) {
      info = { ok: false, error: 'no-job' };
    } else {
      info = await renderJob(job);
    }
  } catch (e) {
    info = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  try {
    await bridge.printHelperReady(info);
  } catch {
    /* 主进程已关闭时忽略 */
  }
}

void main();
