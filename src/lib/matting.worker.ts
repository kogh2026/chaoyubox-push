// 抠图 Worker（P1 批量加速）：在后台线程跑 @imgly ISNet 或本地 MODNet(onnxruntime-web) 推理。
// - engine='isnet'：@imgly/background-removal（发丝精细，1024，稍慢）
// - engine='modnet'：本地 MODNet ONNX（证件照专用，最短边512，快且干净，默认）
// 会话随 Worker 常驻；模型从 appres:// 拉取一次。多 Worker 并行把几十张摊到多核。
import { removeBackground, type Config } from '@imgly/background-removal';
import * as ort from 'onnxruntime-web';

interface MatteRequest {
  id: number;
  file: Blob | File;
  /** 预装模型资源根（主线程传入 appres://…，为空则走 @imgly 默认 CDN） */
  publicPath?: string;
  /** ort wasm 目录（appres://res/ort/），MODNet 引擎用 */
  ortPath?: string;
  /** MODNet 模型 URL（appres://res/matting-model/modnet/modnet.onnx） */
  modnetUrl?: string;
  engine?: 'isnet' | 'modnet';
  /** 本 Worker 的 ORT 线程数（主线程按 CPU 核数 / Worker 数下发） */
  threads?: number;
}

interface ProgressMsg {
  id: number;
  progress: { key: string; current: number; total: number };
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<MatteRequest>) => void) | null;
  postMessage: (msg: unknown, transfer?: Transferable[]) => void;
};

// ---------- MODNet 本地推理 ----------
let modnetSession: ort.InferenceSession | null = null;
let modnetUrlCached = '';

async function ensureModnetSession(ortPath: string | undefined, modelUrl: string): Promise<ort.InferenceSession> {
  if (ortPath) ort.env.wasm.wasmPaths = ortPath;
  if (modnetSession && modnetUrlCached === modelUrl) return modnetSession;
  const res = await fetch(modelUrl);
  if (!res.ok) throw new Error('MODNet 模型加载失败 ' + res.status);
  const buf = await res.arrayBuffer();
  modnetSession = await ort.InferenceSession.create(new Uint8Array(buf), {
    executionProviders: ['wasm'],
    executionMode: 'sequential',
    graphOptimizationLevel: 'all',
  });
  modnetUrlCached = modelUrl;
  return modnetSession;
}

/** 尺寸取 32 的倍数（MODNet 要求 size_divisibility=32），最短边缩到 512 */
function modnetSize(iw: number, ih: number): { w: number; h: number } {
  const scale = 512 / Math.min(iw, ih);
  const w = Math.max(32, Math.round(iw * scale));
  const h = Math.max(32, Math.round(ih * scale));
  return { w: w - (w % 32) || 32, h: h - (h % 32) || 32 };
}

/**
 * 抠图输入预缩放上限（长边）。实测依据（.tmp/bench.log）：
 * @imgly 内部恒把输入 resize 到 1024 再推理，4000×3000 / 2000×1500 / 1024×768 三档推理耗时
 * 分别为 19563 / 19541 / 19426ms —— 几乎无差别。所以把输入预缩到 ≤1024 **不损推理质量**，
 * 但能省掉：① 12MP 全图解码（~90ms/张）②12MP PNG 回传（1.3MB→0.1MB）与主线程再解码
 * ③ 每个 Worker 峰值多占 ~45MB 内存。批量 50 张时这是「每张几百毫秒 + 数百 MB」的固定开销。
 */
const MATTE_MAX_EDGE = 1024;

async function toMatteImageData(src: Blob | File): Promise<ImageData> {
  const bmp = await createImageBitmap(src);
  const iw = bmp.width;
  const ih = bmp.height;
  const s = Math.min(1, MATTE_MAX_EDGE / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * s));
  const h = Math.max(1, Math.round(ih * s));
  const oc = new OffscreenCanvas(w, h);
  const octx = oc.getContext('2d', { willReadFrequently: true })!;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return octx.getImageData(0, 0, w, h);
}

/**
 * @imgly 只认 Blob/URL/ArrayBuffer 或它自己的内部 ndarray；直接喂 ImageData 会在
 * runInference 里读 .shape 时报错。它支持「裸 RGBA8」格式：
 *   blob.type = 'image/x-rgba8;width=W;height=H'
 * → imageDecode 直接按 [H,W,4] 建 ndarray，零重采样、零 PNG 编解码。
 */
function rgba8Blob(img: ImageData): Blob {
  return new Blob([img.data.buffer as ArrayBuffer], {
    type: `image/x-rgba8;width=${img.width};height=${img.height}`,
  });
}

async function runModnet(file: ImageData, ortPath: string | undefined, modelUrl: string): Promise<ArrayBuffer> {
  const session = await ensureModnetSession(ortPath, modelUrl);
  const iw = file.width, ih = file.height;
  const { w, h } = modnetSize(iw, ih);

  // 0) 原尺寸画布：显存一份输入，供推理缩放与最终 alpha 回贴共用
  const outC = new OffscreenCanvas(iw, ih);
  const octxC = outC.getContext('2d')!;
  octxC.putImageData(file, 0, 0);

  // 1) 缩放 + 归一化(mean/std=0.5) → NCHW
  const oc = new OffscreenCanvas(w, h);
  const octx = oc.getContext('2d', { willReadFrequently: true })!;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(outC, 0, 0, w, h);
  const id = octx.getImageData(0, 0, w, h).data;
  const px = w * h;
  const data = new Float32Array(3 * px);
  for (let i = 0; i < px; i++) {
    const j = i * 4;
    data[i] = id[j] / 255 * 2 - 1;
    data[i + px] = id[j + 1] / 255 * 2 - 1;
    data[i + 2 * px] = id[j + 2] / 255 * 2 - 1;
  }
  // 注意：图像画布是 w 宽 × h 高；MODNet 输入是 NCHW [batch,3,height,width]，
  // 故第一空间维应为 h(行数)、第二维为 w(列数)。写成 [1,3,w,h] 会把宽高对调，
  // 使模型按转置图推理、alpha 回贴错位——非正方形人像会整脸透明（已实测复现）。
  const feeds = { input: new ort.Tensor('float32', data, [1, 3, h, w]) };
  const out = await session.run(feeds);
  const alpha = out.output.data as Float32Array; // [1,1,h,w] 已 sigmoid，0..1

  // 2) alpha → 原尺寸灰度掩膜
  const aoc = new OffscreenCanvas(w, h);
  const actx = aoc.getContext('2d', { willReadFrequently: true })!;
  const aimg = actx.createImageData(w, h);
  for (let i = 0; i < px; i++) {
    const v = Math.max(0, Math.min(255, Math.round(alpha[i] * 255)));
    aimg.data[i * 4] = 255; aimg.data[i * 4 + 1] = 255; aimg.data[i * 4 + 2] = 255; aimg.data[i * 4 + 3] = v;
  }
  actx.putImageData(aimg, 0, 0);

  // 3) 合成原尺寸透明 PNG：原 RGB + 掩膜 alpha
  octxC.globalCompositeOperation = 'destination-in';
  octxC.drawImage(aoc, 0, 0, iw, ih);
  const blob = await outC.convertToBlob({ type: 'image/png' });
  return await blob.arrayBuffer();
}

// ---------- 线程数覆写 ----------
// @imgly 内部写死 `ort.env.wasm.numThreads = navigator.hardwareConcurrency`，
// 4 个常驻 Worker 会在 4 核机器上各开 4 线程 → 16 线程抢 4 核（实测单张 8.3s 退化到 34s）。
// 在 Worker 里覆写 hardwareConcurrency = 核数/Worker 数，等效于给每个 Worker 固定线程配额。
function overrideThreads(n?: number): void {
  if (!n || n < 1) return;
  try {
    Object.defineProperty(self.navigator, 'hardwareConcurrency', {
      value: n,
      configurable: true,
      enumerable: true,
    });
  } catch {
    /* 不可覆写时保持默认：只影响性能，不影响正确性 */
  }
}

// ---------- 消息分发 ----------
scope.onmessage = async (e: MessageEvent<MatteRequest>) => {
  const { id, file, publicPath, ortPath, modnetUrl, engine, threads } = e.data;
  try {
    overrideThreads(threads);
    // 统一先缩到 ≤1024 长边：推理耗时与输入像素无关（@imgly 内部也 resize 到 1024），
    // 但解码/回传/主线程再解码的开销与像素成正比 —— 批量时这是纯赚。
    const src = await toMatteImageData(file);
    if (engine === 'modnet' && modnetUrl) {
      if (!modnetUrl.startsWith('appres://') && !modnetUrl.startsWith('http')) {
        throw new Error('MODNet 模型 URL 无效');
      }
      const buf = await runModnet(src, ortPath, modnetUrl);
      scope.postMessage({ id, ok: true, blob: buf } as unknown, [buf]);
      return;
    }
    // isnet（@imgly，默认）
    const config: Config = {
      output: { format: 'image/png' },
      publicPath,
      progress: (key: string, current: number, total: number) => {
        const msg: ProgressMsg = { id, progress: { key, current, total } };
        scope.postMessage(msg);
      },
    };
    const blob = await removeBackground(rgba8Blob(src), config);
    const buf = await blob.arrayBuffer();
    scope.postMessage({ id, ok: true, blob: buf } as unknown, [buf]);
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
