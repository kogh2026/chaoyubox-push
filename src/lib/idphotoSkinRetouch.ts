// 证件照「皮肤掩码」模块 —— 匀肤管线的掩码源
// 架构同形（详见 aiyin-idphoto-architecture.md）：皮肤掩码(0..1) → 平滑层 → blend 合成。
// 本模块只保留「掩码源」职责：平滑/blend 的实现在 idphotoRetouch（引导滤波 + 特征保护），
// 掩码接口统一为 (rgba,w,h) => Float32Array(0..1)，便于替换更强的掩码源。

export interface SkinMaskProvider {
  (rgba: Uint8ClampedArray, w: number, h: number): Float32Array;
}

/** 内置肤色掩码：YCbCr 肤色域 + 亮度下限，输出 0/1 掩码（作为无 ML 掩码时的兜底） */
export const ycbcrSkinMask: SkinMaskProvider = (rgba, w, h) => {
  const n = w * h;
  const mask = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    const Y = 0.299 * r + 0.587 * g + 0.114 * b;
    const Cb = -0.169 * r - 0.331 * g + 0.5 * b + 128;
    const Cr = 0.5 * r - 0.419 * g - 0.081 * b + 128;
    const isSkin = Cb >= 77 && Cb <= 127 && Cr >= 133 && Cr <= 173 && Y > 60 && a > 0;
    mask[i] = isSkin ? 1 : 0;
  }
  return mask;
};
