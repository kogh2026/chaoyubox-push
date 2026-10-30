// selfie-multiclass 人物定位模块 —— MediaPipe 官方开源模型接入层
// 模型：selfie_multiclass_256x256.tflite（Apache-2.0，Google MediaPipe 官方发布）
//   类别（confidence 通道）：0=background 1=hair 2=body-skin 3=face-skin 4=clothes 5=others
// 用途：合成「人物」掩码 → 定位人物真实底部，供证件照「放大填满」判断「下方不足」。
// 注意：tasks-vision 运行时需要浏览器 WASM 环境（Electron 渲染进程）；纯函数部分
// （combinePersonMask / personLowerBody / resizeMask）无环境依赖，可在 Node/Worker/测试中直接使用。

/** selfie_multiclass 的 6 个类别索引（官方顺序，勿改） */
export const MULTICLASS_CATEGORIES = {
  background: 0,
  hair: 1,
  bodySkin: 2,
  faceSkin: 3,
  clothes: 4,
  others: 5,
} as const;

/**
 * 双线性重采样掩码（当推理输出尺寸 ≠ 原图尺寸时使用）。
 * 边缘 clamp 采样，输出长度 = dstW*dstH。
 */
export function resizeMask(
  mask: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Float32Array {
  if (srcW === dstW && srcH === dstH) return mask;
  if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) {
    throw new Error(`resizeMask 尺寸非法：src=${srcW}x${srcH} dst=${dstW}x${dstH}`);
  }
  const out = new Float32Array(dstW * dstH);
  const sx = srcW / dstW;
  const sy = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), srcH - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, srcH - 1);
    const ty = fy - y0;
    for (let x = 0; x < dstW; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), srcW - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const tx = fx - x0;
      const v00 = mask[y0 * srcW + x0];
      const v01 = mask[y0 * srcW + x1];
      const v10 = mask[y1 * srcW + x0];
      const v11 = mask[y1 * srcW + x1];
      const top = v00 + (v01 - v00) * tx;
      const bot = v10 + (v11 - v10) * tx;
      out[y * dstW + x] = top + (bot - top) * ty;
    }
  }
  return out;
}

/** tasks-vision MPMask 的最小结构面（便于测试注入桩） */
export interface MaskLike {
  readonly width: number;
  readonly height: number;
  getAsFloat32Array(): Float32Array;
}

/** tasks-vision ImageSegmenter.segment() 返回结果的最小结构面 */
export interface SegmentResultLike {
  readonly confidenceMasks: readonly MaskLike[];
  close(): void;
}

/** tasks-vision ImageSegmenter 的最小结构面（同步 segment） */
export interface SegmenterLike {
  segment(image: unknown, config?: unknown): SegmentResultLike;
  close?(): void;
}

function defaultMakeCanvas(rgba: Uint8ClampedArray, w: number, h: number): unknown {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error(
      '当前环境无 OffscreenCanvas：请在 Electron 渲染进程中运行，或注入 makeCanvas 自定义工厂。',
    );
  }
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  const img = ctx.createImageData(w, h);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** FilesetResolver/ImageSegmenter 的运行时面（避免在纯函数环境强依赖 tasks-vision 类型） */
export interface VisionRuntimeLike {
  ImageSegmenter: {
    createFromOptions(
      asset: unknown,
      options: Record<string, unknown>,
    ): Promise<SegmenterLike>;
  };
}

export interface SegmenterCreateOpts {
  /** tflite 字节（推荐：提前读入 resources/seg-model/selfie_multiclass_256x256.tflite） */
  modelAssetBuffer: Uint8Array;
  /** 预先 FilesetResolver.forVisionTasks(wasmBasePath) 得到的运行时 */
  vision: VisionRuntimeLike;
  /** 委托：'CPU'（默认，与爱印一致）/ 'GPU' */
  delegate?: 'CPU' | 'GPU';
}

/**
 * 创建 multiclass ImageSegmenter（IMAGE 模式 + confidenceMasks）。
 * 须在浏览器/渲染进程调用；wasm 由 FilesetResolver 加载。
 */
export async function createMulticlassSegmenter(
  opts: SegmenterCreateOpts,
): Promise<SegmenterLike> {
  return opts.vision.ImageSegmenter.createFromOptions(opts.vision, {
    baseOptions: {
      modelAssetBuffer: opts.modelAssetBuffer,
      delegate: opts.delegate ?? 'CPU',
    },
    runningMode: 'IMAGE',
    outputConfidenceMasks: true,
  }) as unknown as Promise<SegmenterLike>;
}

/** 官方模型与 wasm 的 CDN 回退源（浏览器预览环境；桌面端全部走 appres:// 预装） */
export const SEG_MODEL_VERSION = '1.2.0';
export const CDN_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';
export const CDN_WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${SEG_MODEL_VERSION}/wasm`;

export interface VisionPaths {
  /** FilesetResolver.forVisionTasks 的 wasm 目录 */
  wasmBase: string;
  /** tflite 模型 URL */
  modelUrl: string;
}

/**
 * 解析 wasm / 模型地址：桌面端走 appres:// 预装（完全离线），
 * 浏览器回退 CDN。appResBase 形如 'appres://res/'。
 */
export function resolveVisionPaths(appResBase?: string | null): VisionPaths {
  if (typeof appResBase === 'string' && appResBase) {
    return {
      wasmBase: `${appResBase}mediapipe-vision/wasm`,
      modelUrl: `${appResBase}seg-model/selfie_multiclass_256x256.tflite`,
    };
  }
  return { wasmBase: CDN_WASM_BASE, modelUrl: CDN_MODEL_URL };
}

/**
 * 渲染进程加载入口：懒加载 @mediapipe/tasks-vision + wasm + 模型，创建 segmenter。
 * 桌面端完全离线；浏览器预览环境首次走 CDN。
 */
export async function loadMulticlassSkinSegmenter(): Promise<SegmenterLike> {
  const visionMod = await import('@mediapipe/tasks-vision');
  const appResBase =
    typeof window !== 'undefined'
      ? (window as unknown as { electronAPI?: { appResBase?: string } }).electronAPI
          ?.appResBase
      : undefined;
  const paths = resolveVisionPaths(appResBase);
  const vision = await visionMod.FilesetResolver.forVisionTasks(paths.wasmBase);
  const res = await fetch(paths.modelUrl);
  if (!res.ok) throw new Error(`selfie-multiclass 模型加载失败：HTTP ${res.status}（${paths.modelUrl}）`);
  const modelAssetBuffer = new Uint8Array(await res.arrayBuffer());
  return createMulticlassSegmenter({
    modelAssetBuffer,
    vision: vision as unknown as VisionRuntimeLike,
  });
}

/* ===== 下半身 / 人物整体定位（证件照「放大填满」精准判断用） =====
   类别（MULTICLASS_CATEGORIES）：0=background 1=hair 2=bodySkin 3=faceSkin 4=clothes 5=others
   「人物」= bodySkin(2) + clothes(4) + faceSkin(3) 的并集（排除头发/背景/others），
   其底部 = 人物真实下半身终点，用于替代「整图底部区域近似」判断「下方不足」。 */

export interface CombinePersonOpts {
  /** 身体皮肤通道（默认 2） */
  bodySkinIndex?: number;
  /** 衣物通道（默认 4） */
  clothesIndex?: number;
  /** 面部皮肤通道（默认 3；传 -1 关闭） */
  faceSkinIndex?: number;
}

/**
 * 合并 multiclass 置信掩码为单一「人物」掩码：person = clamp01(bodySkin + clothes + faceSkin)。
 * 纯函数：通道数、长度自校验，可在 Node/Worker/测试中直接使用。
 */
export function combinePersonMask(
  masks: readonly Float32Array[],
  n: number,
  opts: CombinePersonOpts = {},
): Float32Array {
  const bi = opts.bodySkinIndex ?? MULTICLASS_CATEGORIES.bodySkin;
  const ci = opts.clothesIndex ?? MULTICLASS_CATEGORIES.clothes;
  const fi = opts.faceSkinIndex ?? MULTICLASS_CATEGORIES.faceSkin;
  if (masks.length === 0) throw new Error('confidenceMasks 为空，无法提取人物通道。');
  for (let c = 0; c < masks.length; c++) {
    if (masks[c].length !== n) {
      throw new Error(`置信掩码通道 ${c} 长度 ${masks[c].length} 与像素数 ${n} 不符。`);
    }
  }
  const person = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    if (bi >= 0 && bi < masks.length) v += masks[bi][i];
    if (ci >= 0 && ci < masks.length && ci !== bi) v += masks[ci][i];
    if (fi >= 0 && fi < masks.length && fi !== bi && fi !== ci) v += masks[fi][i];
    person[i] = v >= 1 ? 1 : v <= 0 ? 0 : v;
  }
  return person;
}

export interface PersonLowerBody {
  /** 人物真实底部归一化 Y（0..1）；未检出人物时为 1（无信息，调用方应回退旧近似） */
  bottomFrac: number;
  /** 人物顶部（发顶/头顶）归一化 Y（0..1）；未检出为 0 */
  topFrac: number;
  /** 人物是否抵达图像底部（下半身充足 / 被裁切到图底）：bottomFrac 落在最末行附近 */
  reachedBottom: boolean;
  /** 是否检出任何人物像素 */
  found: boolean;
}

/**
 * 由「人物」掩码（0..1）定位上下边界（纯函数，无环境依赖）。
 * 逐行取该行最大置信，自顶向下找到首个有人物像素的行即为顶部、并持续刷新到底部。
 *
 * 已知边界（真机 8 张实测）：**浅色衣物 + 同色浅背景**时，模型会把衣物一并延伸到背景里，
 * 底部判为「已达图底」。此时返回 reachedBottom=true，调用方按「下方充足」不放大——
 * 这是有意的保守策略：宁可不放大，也不在无依据时裁掉人物。
 *
 * @param mask   combinePersonMask 产出的单通道掩码
 * @param w/h    掩码宽高
 * @param threshold 行判定阈值（默认 0.4）
 */
export function personLowerBody(
  mask: Float32Array,
  w: number,
  h: number,
  threshold = 0.4,
): PersonLowerBody {
  if (w <= 0 || h <= 0 || mask.length !== w * h) {
    return { bottomFrac: 1, topFrac: 0, reachedBottom: false, found: false };
  }
  let bottomRow = -1;
  let topRow = -1;
  let found = false;
  for (let y = 0; y < h; y++) {
    let rowMax = 0;
    const base = y * w;
    for (let x = 0; x < w; x++) {
      const v = mask[base + x];
      if (v > rowMax) rowMax = v;
    }
    if (!found && rowMax > threshold) {
      topRow = y;
      found = true;
    }
    if (rowMax > threshold) bottomRow = y; // 自顶向下持续刷新，最终停在最后一行有人的行
  }
  if (!found) return { bottomFrac: 1, topFrac: 0, reachedBottom: false, found: false };
  const bottomFrac = (bottomRow + 0.5) / h;
  const topFrac = (topRow + 0.5) / h;
  const reachedBottom = bottomRow >= h - 3 || bottomFrac > 1 - 0.02;
  return { bottomFrac, topFrac, reachedBottom, found: true };
}

/** 下半身分割 segmenter 单例（桌面/渲染进程内复用，仅加载一次模型与 wasm） */
let lowerBodySeg: SegmenterLike | null = null;
let lowerBodySegLoading: Promise<SegmenterLike> | null = null;

/** 取得（懒加载并缓存）下半身分割 segmenter；失败抛错由调用方回退旧近似 */
export function getLowerBodySegmenter(): Promise<SegmenterLike> {
  if (lowerBodySeg) return Promise.resolve(lowerBodySeg);
  if (!lowerBodySegLoading) {
    lowerBodySegLoading = loadMulticlassSkinSegmenter().then((s) => {
      lowerBodySeg = s;
      return s;
    });
  }
  return lowerBodySegLoading;
}

/**
 * 对一张 RGBA 图跑下半身分割，返回人物上下边界（含是否抵达图底）。
 * 桌面端经 appres:// 完全离线；浏览器回退 CDN。segmenter 可注入（测试/复用）。
 */
export async function segmentPersonLowerBody(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  segmenter?: SegmenterLike,
): Promise<PersonLowerBody> {
  const seg = segmenter ?? (await getLowerBodySegmenter());
  const makeCanvas = defaultMakeCanvas;
  const canvas = makeCanvas(rgba, w, h) as unknown;
  const result = seg.segment(canvas);
  try {
    const raw = result.confidenceMasks.map((m) => m.getAsFloat32Array());
    const mw = result.confidenceMasks[0].width;
    const mh = result.confidenceMasks[0].height;
    const person =
      mw !== w || mh !== h
        ? resizeMask(combinePersonMask(raw, mw * mh), mw, mh, w, h)
        : combinePersonMask(raw, w * h);
    return personLowerBody(person, w, h);
  } finally {
    result.close();
  }
}
