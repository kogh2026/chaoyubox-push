/**
 * 给 JPEG 补写物理分辨率（DPI）。
 *
 * 背景：画布导出的 JPEG 固定写 JFIF `units=0`（仅表示宽高比）、Xdensity/Ydensity=1，
 * 也就是「300 像素宽就是 300 像素」，不携带每英寸多少像素。界面一直标着「300DPI」，
 * 客户把图拖进 Word / PS 时按 96DPI 展开就是一张巨图 —— 对外口径不一致。
 *
 * 只改 JFIF APP0 里的 4 个字节（units + 两个 density），**不增删任何字节**，
 * 因此不可能影响像素数据；输入不是「SOI + JFIF APP0」结构时原样返回，绝不插入新段。
 * 覆盖率说明：本函数只处理 JPEG，PNG 的 pHYs 需要重算 CRC，留给确实需要时再做。
 */
export function withJpegDpi(bytes: Uint8Array, dpi: number = 300): Uint8Array {
  const n = Math.round(dpi);
  if (!Number.isFinite(n) || n <= 0 || n > 0xffff) return bytes;
  if (bytes.length < 18 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  // APP0 必须紧贴 SOI，且段头是 'JFIF\0'（偏移：2-3 段标记，4-5 段长，6-10 标识，11-12 版本）
  if (bytes[2] !== 0xff || bytes[3] !== 0xe0) return bytes;
  if (String.fromCharCode(bytes[6], bytes[7], bytes[8], bytes[9]) !== 'JFIF') return bytes;

  const out = bytes.slice(); // 复制一份，不改调用方的 buffer
  out[13] = 1; // units = 1 → 密度单位是「点/英寸」
  out[14] = n >> 8;
  out[15] = n & 0xff;
  out[16] = n >> 8;
  out[17] = n & 0xff;
  return out;
}
