// 可选 ML 增强检测（T3「条件允许」部分）
// 仅在用户显式开启「AI 增强识别」且经典 CV 检测置信度不足时调用。
// 复用已内置的依赖 @imgly/background-removal 生成前景蒙版，再求蒙版外接矩形作为卡面候选。
// 默认关闭，不影响默认链路与构建体积（动态 import，仅在开启时加载模型）。

import { FULL_QUAD, type DetectResult, type Quad } from './cardDetect';

/**
 * 从 alpha 通道求前景外接矩形 -> 归一化 Quad。
 * 纯函数，便于单测（传入合成蒙版）。
 * @param alpha 长度 w*h 的 alpha 数组（0..255），>th 视为前景
 * @returns 合理则返回 quad+置信度；否则 null
 */
export function maskToQuad(alpha: ArrayLike<number>, w: number, h: number, th = 40): DetectResult | null {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > th) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const total = w * h;
  if (count < total * 0.1 || count > total * 0.985) return null; // 太小或几乎全幅都不像一张卡
  if (maxX - minX < w * 0.2 || maxY - minY < h * 0.2) return null;

  const quad: Quad = {
    p0: { x: minX / w, y: minY / h }, // 左上
    p1: { x: maxX / w, y: minY / h }, // 右上
    p2: { x: maxX / w, y: maxY / h }, // 右下
    p3: { x: minX / w, y: maxY / h }, // 左下
  };
  // 置信度：前景占比适中（约 0.3~0.85）时最高，过满/过空都降权
  const cov = count / total;
  const conf = Math.max(0.62, Math.min(0.92, 1 - Math.abs(cov - 0.55) * 0.6));
  return { quad, confidence: conf };
}

/**
 * ML 增强检测：用 @imgly 抠图得到带透明通道的结果，再 maskToQuad 求卡面。
 * 动态 import 以隔离模型加载；任何失败都回退到 FULL_QUAD（交由手动兜底）。
 */
export async function detectCardQuadWithML(img: HTMLImageElement): Promise<DetectResult> {
  try {
    const mod = await import('@imgly/background-removal');
    const removeBackground = (
      mod as { removeBackground: (s: unknown, c?: unknown) => Promise<Blob> }
    ).removeBackground;
    // 与证件照换底共用预装模型（桌面端离线可用）
    const { mattingPublicPath } = await import('./matting');
    const blob = await removeBackground(img.src, { publicPath: mattingPublicPath() });
    const bmp = await createImageBitmap(blob);
    const cv = document.createElement('canvas');
    cv.width = bmp.width;
    cv.height = bmp.height;
    const ctx = cv.getContext('2d');
    if (!ctx) return { quad: FULL_QUAD, confidence: 0.4 };
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const alpha = new Uint8ClampedArray(cv.width * cv.height);
    for (let i = 0, p = 0; i < alpha.length; i++, p += 4) alpha[i] = d[p + 3];
    const r = maskToQuad(alpha, cv.width, cv.height);
    return r ?? { quad: FULL_QUAD, confidence: 0.4 };
  } catch {
    return { quad: FULL_QUAD, confidence: 0.4 };
  }
}
