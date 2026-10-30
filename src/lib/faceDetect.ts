// 本地人脸检测（P1-A）：BlazeFace 轻量模型（ONNX，424KB），onnxruntime-web CPU 推理。
// 输出人脸框 + 6 个关键点（左右眼/鼻尖/嘴中心/左右耳），供证件照自动构图与「人脸角度」检测。
// 模型/anchors/ORT 运行时都预装在安装包内（appres://res/），完全离线。
import * as ort from 'onnxruntime-web';

export interface Pt {
  x: number;
  y: number;
}

export interface DetectedFace {
  score: number;
  /** 归一化 0..1 的人脸框（相对原图） */
  box: { x: number; y: number; w: number; h: number };
  /** 6 个关键点，归一化 0..1：0 右眼 1 左眼 2 鼻尖 3 嘴 4 右耳 5 左耳 */
  kp: Pt[];
}

const INPUT = 128;
const SCORE_TH = 0.75;
const NMS_IOU = 0.3;

function resBase(): string | undefined {
  const base =
    typeof window !== 'undefined'
      ? (window as unknown as { electronAPI?: { appResBase?: string } }).electronAPI?.appResBase
      : undefined;
  return typeof base === 'string' && base ? base : undefined;
}

/** 桌面端可离线使用（模型在安装包内）；浏览器预览没有资源根，返回 false 由调用方跳过 */
export function faceDetectAvailable(): boolean {
  return !!resBase();
}

let sessionP: Promise<ort.InferenceSession> | null = null;
let anchorsP: Promise<number[][]> | null = null;

async function getSession(): Promise<ort.InferenceSession> {
  const base = resBase();
  if (!base) throw new Error('face-model-unavailable');
  if (!sessionP) {
    // 预装 ORT wasm：与 node_modules 同版本（1.21.0），无需联网
    ort.env.wasm.wasmPaths = `${base}ort/`;
    ort.env.wasm.numThreads = 1; // file:// 下没有跨源隔离，线程版会退化，直接单线程更稳
    sessionP = ort.InferenceSession.create(`${base}face/face_detection_front.onnx`, {
      executionProviders: ['wasm'],
    }).catch((e) => {
      sessionP = null;
      throw e;
    });
  }
  return sessionP;
}

async function getAnchors(): Promise<number[][]> {
  const base = resBase();
  if (!base) throw new Error('face-model-unavailable');
  if (!anchorsP) {
    anchorsP = fetch(`${base}face/anchors.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('anchors ' + r.status))))
      .then((j: number[][]) => j)
      .catch((e) => {
        anchorsP = null;
        throw e;
      });
  }
  return anchorsP;
}

function iou(a: DetectedFace['box'], b: DetectedFace['box']): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * 纯函数（可单测）：把网络原始输出解码成人脸列表。
 * regressors: [896,16]（前 4 个是框偏移，之后 6 组关键点），classificators: [896]（logit）。
 */
export function decodeFaces(
  regressors: Float32Array | number[],
  classificators: Float32Array | number[],
  anchors: number[][],
  scoreTh = SCORE_TH,
): DetectedFace[] {
  const n = Math.min(anchors.length, Math.floor(regressors.length / 16));
  const raw: DetectedFace[] = [];
  for (let i = 0; i < n; i++) {
    const logit = Number(classificators[i] ?? 0);
    const score = 1 / (1 + Math.exp(-Math.max(-100, Math.min(100, logit))));
    if (score < scoreTh) continue;
    const a = anchors[i];
    const r = i * 16;
    const g = (k: number) => Number(regressors[r + k] ?? 0);
    const cx = (g(0) / INPUT) * a[2] + a[0];
    const cy = (g(1) / INPUT) * a[3] + a[1];
    const w = (g(2) / INPUT) * a[2];
    const h = (g(3) / INPUT) * a[3];
    // 退化的零尺寸框没有意义（NMS 也不会合并它）
    if (!(w > 0) || !(h > 0)) continue;
    const kp: Pt[] = [];
    for (let k = 0; k < 6; k++) {
      kp.push({
        x: (g(4 + k * 2) / INPUT) * a[2] + a[0],
        y: (g(5 + k * 2) / INPUT) * a[3] + a[1],
      });
    }
    raw.push({ score, box: { x: cx - w / 2, y: cy - h / 2, w, h }, kp });
  }
  // 按分数降序贪心 NMS
  raw.sort((x, y) => y.score - x.score);
  const kept: DetectedFace[] = [];
  for (const f of raw) {
    if (kept.every((k) => iou(k.box, f.box) < NMS_IOU)) kept.push(f);
  }
  return kept;
}

/** 把任意图片铺满 128×128 → NCHW Float32 输入（与训练时一致的拉伸缩放） */
function toTensor(img: HTMLImageElement): ort.Tensor {
  const cv = document.createElement('canvas');
  cv.width = INPUT;
  cv.height = INPUT;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, INPUT, INPUT);
  const { data } = ctx.getImageData(0, 0, INPUT, INPUT);
  const chw = new Float32Array(3 * INPUT * INPUT);
  const plane = INPUT * INPUT;
  for (let i = 0; i < plane; i++) {
    chw[i] = data[i * 4] / 127.5 - 1;
    chw[plane + i] = data[i * 4 + 1] / 127.5 - 1;
    chw[2 * plane + i] = data[i * 4 + 2] / 127.5 - 1;
  }
  return new ort.Tensor('float32', chw, [1, 3, INPUT, INPUT]);
}

const cache = new WeakMap<HTMLImageElement, Promise<DetectedFace[]>>();

/** 检测人脸；同一张图只跑一次（WeakMap 缓存，图片被回收时自动释放） */
export function detectFaces(img: HTMLImageElement): Promise<DetectedFace[]> {
  if (!faceDetectAvailable()) return Promise.resolve([]);
  const hit = cache.get(img);
  if (hit) return hit;
  const p = (async () => {
    const [session, anchors] = await Promise.all([getSession(), getAnchors()]);
    const out = await session.run({ input: toTensor(img) } as Record<string, ort.Tensor>);
    const reg = out.regressors?.data as Float32Array;
    const cls = out.classificators?.data as Float32Array;
    if (!reg || !cls) return [];
    return decodeFaces(reg, cls, anchors);
  })().catch(() => {
    cache.delete(img);
    return [] as DetectedFace[];
  });
  cache.set(img, p);
  return p;
}

/** 释放会话（切换照片集/卸载时调用） */
export async function disposeFaceSession(): Promise<void> {
  const p = sessionP;
  sessionP = null;
  if (!p) return;
  try {
    const s = await p;
    await s.release();
  } catch {
    /* 已经释放 */
  }
}
