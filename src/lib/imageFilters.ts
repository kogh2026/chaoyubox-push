// 通用图像滤波内核：O(1) 滑窗盒滤、引导滤波（guided filter）、双线性重采样、掩码中位数。
// 与 idphotoSkinRetouch 共用；纯函数、零 DOM 依赖，Worker / Node / 渲染进程通用。
//
// 设计要点（对照爱印 classic 匀肤的算法规范）：
//   - 盒滤用滑动窗口 + 边界按实际窗口元素数归一（不做零填充），避免边缘变暗；
//   - 引导滤波以亮度为引导，逐通道求 a/b 后再盒滤，等价于 He et al. 的快速引导滤波（O(N)）；
//   - 重采样统一采用「像素中心对齐」映射，保证放大/缩小无半像素偏移。

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Hermite smoothstep：x ≤ a → 0，x ≥ b → 1，中间三次平滑过渡（与原管线同式） */
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
}

/**
 * 盒式模糊（可分离两趟，滑动窗口 O(1)/像素）。
 * 边界按窗口内实际元素数归一，等价于对称截断的均值滤波。
 */
export function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(0, Math.floor(radius));
  if (w <= 0 || h <= 0) return new Float32Array(0);
  if (r === 0) return src.slice();
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);

  // 水平趟
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    let cnt = 0;
    const initEnd = Math.min(r, w - 1);
    for (let x = 0; x <= initEnd; x++) {
      sum += src[row + x];
      cnt++;
    }
    for (let x = 0; x < w; x++) {
      tmp[row + x] = cnt > 0 ? sum / cnt : 0;
      const inn = x + r + 1;
      const outIdx = x - r;
      if (inn < w) {
        sum += src[row + inn];
        cnt++;
      }
      if (outIdx >= 0) {
        sum -= src[row + outIdx];
        cnt--;
      }
    }
  }

  // 垂直趟
  for (let x = 0; x < w; x++) {
    let sum = 0;
    let cnt = 0;
    const initEnd = Math.min(r, h - 1);
    for (let y = 0; y <= initEnd; y++) {
      sum += tmp[y * w + x];
      cnt++;
    }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = cnt > 0 ? sum / cnt : 0;
      const inn = y + r + 1;
      const outIdx = y - r;
      if (inn < h) {
        sum += tmp[inn * w + x];
        cnt++;
      }
      if (outIdx >= 0) {
        sum -= tmp[outIdx * w + x];
        cnt--;
      }
    }
  }
  return out;
}

export interface GuidedFilter {
  /** 对单通道求引导滤波结果（guide 为预置引导通道） */
  apply(p: Float32Array): Float32Array;
  readonly radius: number;
  readonly eps: number;
}

/**
 * 创建引导滤波上下文：方差项只算一次，逐通道复用（3 通道场景省 2/3 的均值计算）。
 * 公式：a = (mean(I·p) − mean(I)·mean(p)) / (var(I) + eps)，b = mean(p) − a·mean(I)，
 *       q = boxMean(a)·I + boxMean(b)。
 */
export function createGuidedFilter(
  guide: Float32Array,
  w: number,
  h: number,
  radius: number,
  eps: number,
): GuidedFilter {
  const r = Math.max(1, Math.round(radius));
  const e = Math.max(1e-6, eps);
  const n = w * h;
  const meanI = boxBlur(guide, w, h, r);
  const sq = new Float32Array(n);
  for (let i = 0; i < n; i++) sq[i] = guide[i] * guide[i];
  const meanII = boxBlur(sq, w, h, r);
  // var = max(0, E[I²] − E[I]²)：数值误差可能产生极小负值，截断避免 NaN 敏感
  const invVar = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = meanII[i] - meanI[i] * meanI[i];
    invVar[i] = 1 / (Math.max(0, v) + e);
  }

  return {
    radius: r,
    eps: e,
    apply(p: Float32Array): Float32Array {
      const meanP = boxBlur(p, w, h, r);
      const ip = new Float32Array(n);
      for (let i = 0; i < n; i++) ip[i] = guide[i] * p[i];
      const meanIP = boxBlur(ip, w, h, r);
      const a = new Float32Array(n);
      const b = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const ai = (meanIP[i] - meanI[i] * meanP[i]) * invVar[i];
        a[i] = ai;
        b[i] = meanP[i] - ai * meanI[i];
      }
      const meanA = boxBlur(a, w, h, r);
      const meanB = boxBlur(b, w, h, r);
      const q = new Float32Array(n);
      for (let i = 0; i < n; i++) q[i] = meanA[i] * guide[i] + meanB[i];
      return q;
    },
  };
}

/** 单通道双线性重采样（像素中心对齐，边界钳制） */
export function resizeChannelBilinear(
  src: Float32Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Float32Array {
  if (sw === dw && sh === dh) return src.slice();
  const out = new Float32Array(dw * dh);
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return out;
  const sx = sw / dw;
  const sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = clamp((y + 0.5) * sy - 0.5, 0, sh - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = clamp((x + 0.5) * sx - 0.5, 0, sw - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;
      const p00 = src[y0 * sw + x0];
      const p10 = src[y0 * sw + x1];
      const p01 = src[y1 * sw + x0];
      const p11 = src[y1 * sw + x1];
      const top = p00 + (p10 - p00) * wx;
      const bot = p01 + (p11 - p01) * wx;
      out[y * dw + x] = top + (bot - top) * wy;
    }
  }
  return out;
}

/**
 * 掩码加权中位数（只在 weight > threshold 的样本上取中位数，按 256 档直方图求）。
 * 用作色调基准（原管线以掩码内亮度中位数作为 anchor），比均值抗高光/阴影干扰。
 */
export function maskedMedian(
  values: Float32Array,
  weight: Float32Array,
  threshold = 0.5,
): number {
  const hist = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    if (weight[i] <= threshold) continue;
    const bin = Math.round(clamp01(values[i]) * 255);
    hist[bin]++;
    total++;
  }
  if (total === 0) return 0;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc * 2 >= total) return i / 255;
  }
  return 1;
}
