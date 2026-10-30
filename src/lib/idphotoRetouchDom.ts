// 渲染进程适配层：把「抠图后的 PNG Blob」走一遍三档匀肤（smoothing / shine / underEye），
// 仍以 Blob 形态交给 composePhoto，因此不改动 matting.ts 的合成链路。
//
// 分工：
//   - 纯计算在 idphotoRetouch.ts（无 DOM，Node 可测）；
//   - 本文件只负责 Blob ↔ ImageData 的搬运、人脸几何解析（BlazeFace 6 点）与失败兜底。
//
// 人脸几何解析（resolveFaceGeometry）刻意做成纯函数：给定归一化人脸框/关键点即可算保护区，
// 便于在 Node 环境用合成数据回归，不必起 canvas。

import {
  eyeRegionsFromKeypoints,
  featureRegionsFromKeypoints,
  retouchPortrait,
  type EyeRegion,
  type FeatureRegion,
  type PortraitRetouchOptions,
  type PortraitRetouchStats,
} from './idphotoRetouch';

/** 与 faceDetect.DetectedFace 结构一致（此处不直接 import，避免 Node 测试拉起 onnxruntime） */
export interface FaceLike {
  score?: number;
  /** 归一化 0..1 人脸框 */
  box: { x: number; y: number; w: number; h: number };
  /** 归一化 0..1 六点：0 右眼 1 左眼 2 鼻尖 3 嘴 4 右耳 5 左耳 */
  kp: { x: number; y: number }[];
}

export interface FaceGeometry {
  /** 是否用到了真实检测结果（false 表示按图宽比例估算） */
  detected: boolean;
  /** 人脸宽度（像素） */
  faceWidth: number;
  /** 特征保护区（眼/眉/嘴/鼻），无关键点时为 undefined */
  protect?: FeatureRegion[];
  /** 眼下区域，无关键点时为 undefined */
  eyeRegions?: EyeRegion[];
}

/**
 * 由人脸检测结果解析出匀肤需要的几何参数。
 * - 传 face：脸宽取框宽（像素），保护区/眼下用 6 点近似；
 * - 不传 face：脸宽按图宽 30% 估算（与 idphotoRetouch 内部缺省一致），不做特征保护。
 */
export function resolveFaceGeometry(
  face: FaceLike | null | undefined,
  w: number,
  h: number,
  opts: { faceWidth?: number; protectFeatures?: boolean } = {},
): FaceGeometry {
  const fallback = () => {
    const fw = Math.max(1, opts.faceWidth ?? w * 0.3);
    return { detected: false, faceWidth: fw } as FaceGeometry;
  };
  if (!face || !face.box || !Array.isArray(face.kp) || face.kp.length < 4) return fallback();
  const boxW = face.box.w * w;
  const faceWidth = Math.max(1, opts.faceWidth ?? (boxW > 1 ? boxW : fallback().faceWidth));
  const out: FaceGeometry = { detected: true, faceWidth };
  if (opts.protectFeatures !== false) {
    const p = featureRegionsFromKeypoints(face.kp, w, h, faceWidth);
    if (p.length > 0) out.protect = p;
    const e = eyeRegionsFromKeypoints(face.kp, w, h, faceWidth);
    if (e.length > 0) out.eyeRegions = e;
  }
  return out;
}

export interface AdvancedRetouchRequest {
  /** 匀肤 0..1 */
  smoothing?: number;
  /** 油光抑制 0..1 */
  shine?: number;
  /** 黑眼圈 0..1 */
  underEye?: number;
  /** 覆盖脸宽（像素） */
  faceWidth?: number;
  /** 特征保护（默认开；没有关键点时自动跳过） */
  protectFeatures?: boolean;
  /** 皮肤掩码源（默认内置 YCbCr；可传 selfie-multiclass） */
  /** 油光色调锚点，默认 local */
  toneAnchor?: 'local' | 'global';
  /** 只平滑亮度（保色度） */
  lumaOnly?: boolean;
  /** 单块像素上限，默认 4M */
  tilePixels?: number;
  /** 关闭人脸检测（无资源/离线环境用；脸宽回退为图宽 30%） */
  detectFace?: boolean;
}

export interface AdvancedRetouchResult {
  blob: Blob;
  width: number;
  height: number;
  stats: PortraitRetouchStats;
  face: FaceGeometry;
  /** 实际耗时（毫秒），含解码与编码 */
  elapsedMs: number;
}

/** 统计摘要（UI 上解释"到底改了什么"，避免只看到一个开关） */
export function summarizeRetouch(r: {
  stats: PortraitRetouchStats;
  face: FaceGeometry;
  elapsedMs?: number;
}): string {
  const s = r.stats;
  const bits = [
    `平滑 ${s.smoothedPixels} px(r=${s.smooth.radius})`,
    `油光 ${s.shinePixels} px`,
    `眼下 ${s.underEyePixels} px`,
  ];
  if (s.blendPixels > 0) bits.push(`模型 ${s.blendPixels} px`);
  bits.push(`脸宽 ${Math.round(r.face.faceWidth)} px${r.face.detected ? '' : '(估算)'}`);
  if (typeof r.elapsedMs === 'number') bits.push(`${Math.round(r.elapsedMs)} ms`);
  return bits.join(' · ');
}

/** 三档是否全为 0（等于什么都没要求做） */
export function isRetouchIdle(req: AdvancedRetouchRequest): boolean {
  return !(req.smoothing || req.shine || req.underEye);
}

function loadCanvasImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('匀肤输入的图像无法解码'));
    };
    img.src = url;
  });
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('匀肤结果编码失败'))), 'image/png');
  });
}

/**
 * 对抠图结果（带 alpha 的 PNG）做三档匀肤，原地返回新的 PNG Blob。
 * 三档全 0 时直接把输入原样返回（零开销，不重新编码）。
 * 人脸检测失败不抛错：退化为「按图宽估算脸宽 + 无特征保护」，效果降级但不中断出片。
 */
export async function retouchPhotoBlob(
  matte: Blob,
  req: AdvancedRetouchRequest = {},
): Promise<AdvancedRetouchResult> {
  const t0 = now();
  if (isRetouchIdle(req)) {
    return {
      blob: matte,
      width: 0,
      height: 0,
      stats: {
        engine: 'classic',
        smoothedPixels: 0,
        shinePixels: 0,
        underEyePixels: 0,
        blendPixels: 0,
        smooth: { radius: 0, eps: 0, mix: 0, pixels: 0, tiles: 0 },
      },
      face: { detected: false, faceWidth: 0 },
      elapsedMs: 0,
    };
  }

  const img = await loadCanvasImage(matte);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  let face: FaceLike | null = null;
  if (req.detectFace !== false) {
    try {
      const mod = await import('./faceDetect');
      if (mod.faceDetectAvailable()) {
        const found = await mod.detectFaces(img);
        face = (found && found.length > 0 ? found[0] : null) as FaceLike | null;
      }
    } catch {
      face = null; // 模型缺失/推理失败：降级，不影响出片
    }
  }
  const geo = resolveFaceGeometry(face, w, h, {
    faceWidth: req.faceWidth,
    protectFeatures: req.protectFeatures,
  });

  const imageData = ctx.getImageData(0, 0, w, h);
  const opts: PortraitRetouchOptions = {
    smoothing: req.smoothing ?? 0,
    shine: req.shine ?? 0,
    underEye: req.underEye ?? 0,
    faceWidth: geo.faceWidth,
    protect: geo.protect,
    eyeRegions: geo.eyeRegions,
    toneAnchor: req.toneAnchor,
    lumaOnly: req.lumaOnly,
    tilePixels: req.tilePixels,
  };
  const stats = retouchPortrait(imageData.data, w, h, opts);
  ctx.putImageData(imageData, 0, 0);
  const blob = await canvasToPng(canvas);
  return { blob, width: w, height: h, stats, face: geo, elapsedMs: now() - t0 };
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
