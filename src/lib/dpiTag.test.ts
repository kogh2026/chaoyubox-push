import { describe, expect, it } from 'vitest';
import { withJpegDpi } from './dpiTag';

/** 造一个最小 JPEG 头：SOI + APP0(JFIF, units/dx/dy 可指定) + 两字节垃圾尾巴 */
function fakeJpeg(units = 0, dx = 1, dy = 1): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, // APP0, 段长 16
    0x4a, 0x46, 0x49, 0x46, 0x00, // 'JFIF\0'
    0x01, 0x01, // 版本 1.01
    units, dx >> 8, dx & 0xff, dy >> 8, dy & 0xff, // units / Xdensity / Ydensity
    0x00, 0x00, // 缩略图宽高
    0xff, 0xdb, 0x00, 0x03, 0x00, // 后续段（模拟 DQT）
  ]);
}

describe('withJpegDpi', () => {
  it('把 units 置 1 并写入 300 DPI，不改变长度与其余字节', () => {
    const src = fakeJpeg(0, 1, 1);
    const out = withJpegDpi(src, 300);
    expect(out.length).toBe(src.length);
    expect(out[13]).toBe(1);
    expect((out[14] << 8) | out[15]).toBe(300);
    expect((out[16] << 8) | out[17]).toBe(300);
    // 头部以外逐字节相同
    expect([...out.slice(0, 13)]).toEqual([...src.slice(0, 13)]);
    expect([...out.slice(18)]).toEqual([...src.slice(18)]);
  });

  it('不修改调用方的原始数组', () => {
    const src = fakeJpeg();
    const before = [...src];
    withJpegDpi(src, 300);
    expect([...src]).toEqual(before);
  });

  it('已是目标 DPI 时结果稳定（可重复调用）', () => {
    const once = withJpegDpi(fakeJpeg(), 300);
    const twice = withJpegDpi(once, 300);
    expect([...twice]).toEqual([...once]);
  });

  it('非 JPEG（PNG 头）原样返回', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(withJpegDpi(png, 300)).toBe(png);
  });

  it('JPEG 但首段不是 JFIF APP0 时原样返回（不插入新段）', () => {
    const exif = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(withJpegDpi(exif, 300)).toBe(exif);
  });

  it('长度不足 / 非法 dpi 时原样返回', () => {
    const short = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    expect(withJpegDpi(short, 300)).toBe(short);
    const src = fakeJpeg();
    expect(withJpegDpi(src, 0)).toBe(src);
    expect(withJpegDpi(src, Number.NaN)).toBe(src);
    expect(withJpegDpi(src, 70000)).toBe(src);
  });

  it('支持上限 65535 与自定义 dpi（72）', () => {
    const hi = withJpegDpi(fakeJpeg(), 65535);
    expect((hi[14] << 8) | hi[15]).toBe(65535);
    const lo = withJpegDpi(fakeJpeg(), 72);
    expect((lo[16] << 8) | lo[17]).toBe(72);
  });
});
