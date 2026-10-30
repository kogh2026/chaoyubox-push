// 卡证矫正 Worker（方案A）：后台线程跑爱印「卡证矫正 FP32」ONNX 推理 + 涂白循环。
// 协议 1:1 对齐爱印 vendor/id2pdf-card-correction-worker.js：
//   输入 [1,3,768,768]（CHW，BGR 均值方差归一化），输出张量 scores/quads/angle/ftype。
// 会话随 Worker 常驻；模型从 appres:// 拉取一次。请求串行排队（爱印同款 q 链）。
import * as ort from 'onnxruntime-web';
import {
  modelCorrectLoop,
  type ModelOutput,
  type RgbaImage,
} from './cardCorrectMl';

export interface CardCorrectRequest {
  id: number;
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** 预装模型 URL（appres://res/card-model/card-correction-fp32.onnx） */
  modelUrl: string;
  /** ort wasm 目录（appres://res/ort/） */
  ortPath?: string;
  maxPages?: number;
  minAreaFrac?: number;
}

export interface CardCorrectPageMsg {
  angle: number;
  corners: { x: number; y: number }[];
  uprightCorners: { x: number; y: number }[];
  uprightTurns: number;
  score: number;
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type CardCorrectResponse =
  | { id: number; type: 'success'; pages: CardCorrectPageMsg[]; passes: number; room: number | null; inferMs: number }
  | { id: number; type: 'error'; error: string };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<CardCorrectRequest>) => void) | null;
  postMessage: (msg: unknown, transfer?: Transferable[]) => void;
};

let session: ort.InferenceSession | null = null;
let modelUrlCached = '';

async function ensureSession(modelUrl: string, ortPath?: string): Promise<ort.InferenceSession> {
  if (ortPath) ort.env.wasm.wasmPaths = ortPath;
  if (session && modelUrlCached === modelUrl) return session;
  const res = await fetch(modelUrl);
  if (!res.ok) throw new Error('卡证模型加载失败 ' + res.status);
  const buf = await res.arrayBuffer();
  session = await ort.InferenceSession.create(new Uint8Array(buf), {
    executionProviders: ['wasm'],
    executionMode: 'sequential',
    graphOptimizationLevel: 'all',
  });
  modelUrlCached = modelUrl;
  return session;
}

function tensorData(out: Record<string, ort.Tensor>, name: string): ArrayLike<number> {
  const t = out[name];
  if (!t) throw new Error(`Card model did not return "${name}".`);
  return t.data as Float32Array;
}

async function infer(run: (t: ort.Tensor) => Promise<Record<string, ort.Tensor>>, input: Float32Array): Promise<ModelOutput> {
  const out = await run(new ort.Tensor('float32', input, [1, 3, 768, 768]));
  return {
    scores: tensorData(out, 'scores'),
    quads: tensorData(out, 'quads'),
    angle: tensorData(out, 'angle'),
    ftype: tensorData(out, 'ftype'),
  };
}

/** ort 类型里的 inputNames 在本版本 d.ts 缺失，运行时存在 */
type SessionWithNames = ort.InferenceSession & { inputNames: readonly string[] };

let queue: Promise<void> = Promise.resolve();

scope.onmessage = (e: MessageEvent<CardCorrectRequest>) => {
  const req = e.data;
  queue = queue.then(async () => {
    const t0 = performance.now();
    try {
      const s = (await ensureSession(req.modelUrl, req.ortPath)) as SessionWithNames;
      const src: RgbaImage = { data: req.data, width: req.width, height: req.height };
      let inferMs = 0;
      const r = await modelCorrectLoop(src, async (input) => {
        const t1 = performance.now();
        const out = await infer((t) => s.run({ [s.inputNames[0]]: t }), input);
        inferMs += performance.now() - t1;
        return out;
      }, { maxPages: req.maxPages, minAreaFrac: req.minAreaFrac });
      const pages: CardCorrectPageMsg[] = r.pages.map((p) => ({
        angle: p.angle,
        corners: p.corners,
        uprightCorners: p.uprightCorners,
        uprightTurns: p.uprightTurns,
        score: p.score,
        data: p.imageData.data as Uint8ClampedArray,
        width: p.imageData.width,
        height: p.imageData.height,
      }));
      const transfer = pages.map((p) => p.data.buffer);
      scope.postMessage(
        { id: req.id, type: 'success', pages, passes: r.passes, room: r.room, inferMs } satisfies CardCorrectResponse,
        transfer,
      );
    } catch (err) {
      scope.postMessage({
        id: req.id,
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
      } satisfies CardCorrectResponse);
    }
    void t0;
  });
};
