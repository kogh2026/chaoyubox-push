// 卡证矫正主线程客户端（方案A）：把导入图投递给 cardCorrect Worker，
// 拿回「已 warp + 摆正」的卡面页，转换成 CardLayout 可直接使用的条目。
// 模型不可用（浏览器预览无资源根 / 加载失败 / 未检出卡面）时由调用方回退经典 CV。
import type { Quad } from './cardDetect';
import type { CardCorrectPageMsg, CardCorrectResponse } from './cardCorrect.worker';
import { IdleUnloader } from './idleUnload';

function resBase(): string | undefined {
  const base =
    typeof window !== 'undefined'
      ? (window as unknown as { electronAPI?: { appResBase?: string } }).electronAPI?.appResBase
      : undefined;
  return typeof base === 'string' && base ? base : undefined;
}

/** 桌面端离线可用（模型在安装包内）；浏览器预览返回 false，调用方走经典 CV */
export function cardCorrectAvailable(): boolean {
  return !!resBase();
}

// ---------- Worker 单例 + 串行排队 ----------

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (r: SuccessResp) => void; reject: (e: Error) => void }>();

// 测试可覆盖的 Worker 工厂：生产默认 new Worker(new URL('./cardCorrect.worker.ts', import.meta.url))。
// 单测通过 __setWorkerFactoryForTest 注入 mock Worker，从而直接驱动真实客户端协议逻辑
// （ensureWorker / killWorker / 超时 / dispose），无需改动协议本体。
let makeWorkerImpl: () => Worker = () =>
  new Worker(new URL('./cardCorrect.worker.ts', import.meta.url), { type: 'module' });
/** 仅供单元测试注入 mock Worker；生产代码不应调用。 */
export function __setWorkerFactoryForTest(fn: () => Worker): void {
  makeWorkerImpl = fn;
}

type SuccessResp = Extract<CardCorrectResponse, { type: 'success' }>;
/** 与爱印一致的单请求超时（rF=120s）：ort wasm 偶发挂死时销毁 Worker 重来 */
const REQUEST_TIMEOUT_MS = 120_000;
/**
 * 空闲卸载阈值：最后一次推理完成后再过这么久没有任何请求，就 terminate Worker 释放
 * 41MB 模型 + wasm 常驻内存。避免长任务间歇期（用户看预览/排版）白白占内存，
 * 也避免「活跃工作集」只增不减。下次请求 ensureWorker 会懒加载重建（首次加载约数百 ms）。
 */
const IDLE_UNLOAD_MS = 90_000;

// 空闲卸载器：默认 onIdle = 释放 Worker；测试可注入 scheduler 与回调
let idleUnloader: IdleUnloader | null = null;
function getUnloader(): IdleUnloader {
  if (!idleUnloader) {
    idleUnloader = new IdleUnloader(() => killWorker('card-correct-idle-unload'), IDLE_UNLOAD_MS);
  }
  return idleUnloader;
}

function killWorker(reason: string): void {
  worker?.terminate();
  worker = null;
  for (const [, p] of pending) p.reject(new Error(reason));
  pending.clear();
  idleUnloader?.clear();
}

function ensureWorker(): Worker | null {
  if (worker) {
    getUnloader().clear(); // 复用已有 Worker：取消空闲倒计时
    return worker;
  }
  try {
    worker = makeWorkerImpl();
    worker.onmessage = (e: MessageEvent<CardCorrectResponse>) => {
      const msg = e.data;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.type === 'success') p.resolve(msg);
      else p.reject(new Error(msg.error));
    };
    worker.onerror = () => {
      // Worker 级失败：拒绝全部在途请求并复位，下次调用重建
      killWorker('card-correct-worker-crashed');
    };
    return worker;
  } catch {
    worker = null;
    return null;
  }
}

/** 退出证卡工具时释放 Worker（41MB 模型 + wasm 常驻内存，不用了要还） */
export function disposeCardCorrectWorker(): void {
  killWorker('card-correct-disposed');
}

export interface ModelCorrectRaw {
  pages: (Omit<CardCorrectPageMsg, 'data'> & { data: Uint8ClampedArray })[];
  passes: number;
  room: number | null;
}

/** 底层：位图 → Worker → 页列表（warp 已完成，坐标为源图像素） */
export function correctImageRaw(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  opts: { maxPages?: number; minAreaFrac?: number } = {},
): Promise<ModelCorrectRaw> {
  const w = ensureWorker();
  const base = resBase();
  if (!w || !base) return Promise.reject(new Error('card-correct-unavailable'));
  const id = ++seq;
  return new Promise<ModelCorrectRaw>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      killWorker(`card-correct-timeout#${id}`);
      reject(new Error('card-correct-timeout'));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, {
      resolve: (r) => {
        clearTimeout(timer);
        getUnloader().touch(); // 推理完成 → 重置空闲倒计时
        resolve({ pages: r.pages, passes: r.passes, room: r.room });
      },
      reject: (e) => {
        clearTimeout(timer);
        getUnloader().touch(); // 即使失败也计空闲（异常不应阻止释放模型）
        reject(e);
      },
    });
    try {
      const copy = new Uint8ClampedArray(data); // 拷贝后 transfer，不detach调用方缓冲
      w.postMessage(
        {
          id,
          data: copy,
          width,
          height,
          modelUrl: `${base}card-model/card-correction-fp32.onnx`,
          ortPath: `${base}ort/`,
          maxPages: opts.maxPages,
          minAreaFrac: opts.minAreaFrac,
        },
        [copy.buffer],
      );
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ---------- 高层：HTMLImageElement → 可直接入列的卡面条目 ----------

export interface ModelCardEntry {
  /** 摆正后角点（归一化，p0=左上 约定与经典 CV 一致），供手动裁切/换类型重 warp */
  quad: Quad;
  confidence: number;
  /** 已 warp + 摆正的卡面（长边压到 1100，与经典 CV 的 corrected 同规格） */
  corrected: { img: HTMLImageElement; dataUrl: string };
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return cv;
}

function imageDataToCanvas(d: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const cv = makeCanvas(w, h);
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('canvas ctx 不可用');
  const im = ctx.createImageData(w, h);
  im.data.set(d);
  ctx.putImageData(im, 0, 0);
  return cv;
}

/** 模型 warp 出的是卡面原生分辨率（可能几千px），显示/排版统一压到长边 1100 */
function downscaleLong(src: HTMLCanvasElement, long: number): HTMLCanvasElement {
  const s = Math.min(1, long / Math.max(src.width, src.height));
  if (s >= 1) return src;
  const cv = makeCanvas(Math.max(1, Math.round(src.width * s)), Math.max(1, Math.round(src.height * s)));
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('canvas ctx 不可用');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, cv.width, cv.height);
  return cv;
}

function canvasToImage(cv: HTMLCanvasElement, quality = 0.92): Promise<{ img: HTMLImageElement; dataUrl: string }> {
  const url = cv.toDataURL('image/jpeg', quality);
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve({ img: im, dataUrl: url });
    im.onerror = () => reject(new Error('校正图加载失败'));
    im.src = url;
  });
}

/**
 * 增强识别：一张图 → 0..N 条已校正卡面。
 * 返回 [] 表示「模型正常但没检出卡面」（调用方回退经典 CV）；抛错表示环境/模型不可用。
 */
export async function correctImageWithModel(
  img: HTMLImageElement,
  opts: { maxPages?: number; minAreaFrac?: number; correctedLongEdge?: number } = {},
): Promise<ModelCardEntry[]> {
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  if (!sw || !sh) return [];
  // 工作图长边上限：模型输入反正归一化到 768，warp 精度也来自模型角点；
  // 限到 3200 只为控制内存与传输，仍远高于 1100 的输出规格。
  const s = Math.min(1, 3200 / Math.max(sw, sh));
  const w = Math.max(8, Math.round(sw * s));
  const h = Math.max(8, Math.round(sh * s));
  const cv = makeCanvas(w, h);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas ctx 不可用');
  ctx.drawImage(img, 0, 0, w, h);
  const sd = ctx.getImageData(0, 0, w, h);
  const r = await correctImageRaw(sd.data, w, h, opts);
  const long = opts.correctedLongEdge ?? 1100;
  const entries: ModelCardEntry[] = [];
  for (const p of r.pages) {
    const full = imageDataToCanvas(p.data, p.width, p.height);
    const shown = downscaleLong(full, long);
    const corrected = await canvasToImage(shown);
    const q = p.uprightCorners;
    entries.push({
      // 摆正角点归一化（相对工作图；工作图与原图同长宽比，归一化坐标通用）
      quad: {
        p0: { x: q[0].x / w, y: q[0].y / h },
        p1: { x: q[1].x / w, y: q[1].y / h },
        p2: { x: q[2].x / w, y: q[2].y / h },
        p3: { x: q[3].x / w, y: q[3].y / h },
      },
      confidence: p.score,
      corrected,
    });
  }
  return entries;
}
