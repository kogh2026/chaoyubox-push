/**
 * 证件照输出体积约束（V4，对齐爱印「单张文件大小 20~200KB」）。
 *
 * 为什么要这个：图文店上传报名系统时，几乎都写着「照片 20~200KB，300DPI」。
 * 我们导出的是 300DPI、quality 0.95 的 JPEG，常见规格落在 60~150KB 之间 ——
 * 多数能过，但大尺寸规格（大二寸 / 2 寸）会顶到 200KB 以上被退回。
 *
 * 设计取舍（三条，都是刻意的）：
 * 1. **只在超上限时重编码**。没超就原样交出字节 —— 不为凑体积做无意义的二次有损压缩，
 *    也不为了"达到下限"给人往里灌填充数据（那是骗用户）。
 * 2. **二分找"不超上限的最高质量"**，而不是固定几档 quality。同一档 quality 在不同
 *    亮度/细节的照片上体积能差一倍，固定档位不可靠。
 * 3. **搜索是纯函数**（`findQualityForSize` 只依赖注入的 encode 回调），
 *    这样能在 node 环境下用合成编码器单测，不必起浏览器。
 *
 * 本模块的 DOM 部分（createImageBitmap / canvas.toBlob）只在 `fitJpegBlob` 里，
 * 单测不碰它。
 */

export interface JpegSizeTarget {
  /** 单张最小体积（字节）；0 = 不设下限 */
  minBytes: number;
  /** 单张最大体积（字节）；0 = 不设上限 */
  maxBytes: number;
}

/**
 * 档位表。`20~200 KB` 是爱印原版给出的区间；
 * `20~100 KB` 是同一套下压得更狠的一档（某些考试报名只要 100KB 以内）。
 * 默认 `none`：不改变现有导出行为，用户要卡体积时才主动选。
 */
export const PHOTO_SIZE_PRESETS = [
  { id: 'none', name: '不限制', minKB: 0, maxKB: 0 },
  { id: 'band20_200', name: '20~200 KB', minKB: 20, maxKB: 200 },
  { id: 'band20_100', name: '20~100 KB', minKB: 20, maxKB: 100 },
] as const;

export type PhotoSizeId = (typeof PHOTO_SIZE_PRESETS)[number]['id'];

/** 合法 id 清单（落盘校验用，避免第二份真相） */
export const PHOTO_SIZE_IDS: string[] = PHOTO_SIZE_PRESETS.map((p) => p.id);

/** 档位 id → 字节区间；`none` / 未知 id → null（= 不限制） */
export function sizeTargetOf(id: string): JpegSizeTarget | null {
  const p = PHOTO_SIZE_PRESETS.find((x) => x.id === id);
  if (!p || p.maxKB <= 0) return null;
  return { minBytes: p.minKB > 0 ? p.minKB * 1024 : 0, maxBytes: p.maxKB * 1024 };
}

/** 档位显示名（UI 与提示文案共用） */
export function sizeTargetName(id: string): string {
  return PHOTO_SIZE_PRESETS.find((x) => x.id === id)?.name ?? '不限制';
}

export interface QualitySearchResult {
  /** 选中的 JPEG quality（两位小数，向下取整） */
  quality: number;
  /** 该 quality 下的字节数 */
  bytes: number;
  /** false = 最低质量也超上限，已尽力（调用方应据此提示） */
  fits: boolean;
}

/**
 * 二分搜索「不超过 maxBytes 的最高 quality」。
 *
 * @param encode 注入的编码器：给定 quality 返回**字节数**（顺序无关、可 await）
 * @param target 目标区间（只用到 maxBytes）
 * @param opts.lo 最低 quality（默认 0.35，再低画质没法用于证件照）
 * @param opts.hi 最高 quality（默认 0.95，与合成路径一致）
 * @param opts.iters 二分轮数（默认 7 → 精度 ≈ 0.005）
 *
 * 边界语义：
 * - hi 就已经达标 → 直接用 hi（绝大多数情况，只调 1 次 encode）
 * - lo 仍然超标 → 返回 lo 且 `fits:false`（宁可交付"超标但可用"的图，也不交付糊图 / 空文件）
 */
export async function findQualityForSize(
  encode: (quality: number) => Promise<number>,
  target: JpegSizeTarget,
  opts: { lo?: number; hi?: number; iters?: number } = {},
): Promise<QualitySearchResult> {
  const lo0 = opts.lo ?? 0.35;
  const hi0 = opts.hi ?? 0.95;
  const iters = Math.max(1, opts.iters ?? 7);
  const max = Math.max(1, target.maxBytes);

  const hiBytes = await encode(hi0);
  if (hiBytes <= max) return { quality: hi0, bytes: hiBytes, fits: true };

  const loBytes = await encode(lo0);
  if (loBytes > max) return { quality: lo0, bytes: loBytes, fits: false };

  let lo = lo0;
  let hi = hi0;
  let bestQ = lo0;
  let bestB = loBytes;
  for (let i = 0; i < iters; i++) {
    const mid = (lo + hi) / 2;
    const b = await encode(mid);
    if (b <= max) {
      lo = mid;
      bestQ = mid;
      bestB = b;
    } else {
      hi = mid;
    }
    if (hi - lo < 0.01) break;
  }
  // 向下取整到两位小数：最终还会按这个 quality 重编一次，取整方向只能向下，
  // 否则 0.716 → 0.72 可能把体积顶回上限之上。
  return { quality: Math.floor(bestQ * 100) / 100, bytes: bestB, fits: true };
}

export interface FittedJpeg {
  blob: Blob;
  /** 最终 quality；1 = 未重编码（原样交出） */
  quality: number;
  bytes: number;
  /** false = 压到最低质量仍超上限（调用方应提示，但仍然交付） */
  fits: boolean;
  /** 是否做过二次重编码（false = 原样使用传入的 blob） */
  reencoded: boolean;
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('JPEG 编码失败'))),
      'image/jpeg',
      quality,
    );
  });
}

/**
 * 把成品 JPEG 压进目标区间。
 * - `target` 为 null 或未超上限 → 原样返回（**零重编码、零画质损失**）
 * - 超上限 → 解码一次 → 二分 quality 重编码
 *
 * 注意：重编码会丢掉原始 JPEG 里已没用的 EXIF，但调用方随后会用 `withJpegDpi`
 * 重新写回 DPI 标记，所以 300DPI 不会丢。
 */
export async function fitJpegBlob(blob: Blob, target: JpegSizeTarget | null): Promise<FittedJpeg> {
  const asIs: FittedJpeg = { blob, quality: 1, bytes: blob.size, fits: true, reencoded: false };
  if (!target || target.maxBytes <= 0) return asIs;
  if (blob.size <= target.maxBytes) return asIs;

  const bmp = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ...asIs, fits: false };
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0);

    const res = await findQualityForSize(async (q) => (await toJpeg(canvas, q)).size, target);
    const out = await toJpeg(canvas, res.quality);
    return {
      blob: out,
      quality: res.quality,
      bytes: out.size,
      fits: out.size <= target.maxBytes,
      reencoded: true,
    };
  } finally {
    bmp.close?.();
  }
}
