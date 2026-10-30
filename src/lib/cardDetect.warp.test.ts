/** 透视重采样纯函数（B4 抽取）测试：不依赖 canvas，可在 Node 直接跑。 */
import { describe, expect, it } from 'vitest';
import { warpPixels, type Pt } from './cardDetect';

const FULL = (w: number, h: number): Pt[] => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
];

function solid(w: number, h: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = 255;
    d[i * 4 + 1] = 0;
    d[i * 4 + 2] = 0;
    d[i * 4 + 3] = 255;
  }
  return d;
}

describe('warpPixels', () => {
  it('输出缓冲区长度 = outW*outH*4', () => {
    const out = warpPixels(solid(8, 8), 8, 8, FULL(8, 8), 4, 6);
    expect(out.length).toBe(4 * 6 * 4);
  });

  it('恒等映射：内部像素原样保留（含 RGBA 四通道）', () => {
    const sw = 4;
    const sh = 4;
    const d = solid(sw, sh);
    // 把 (1,1) 改成绿色，用于验证「搬移的是对应像素」而非统一填色
    const p = (1 * sw + 1) * 4;
    d[p] = 0;
    d[p + 1] = 255;
    d[p + 2] = 0;
    const out = warpPixels(d, sw, sh, FULL(sw, sh), 4, 4);
    const oi = (1 * 4 + 1) * 4;
    expect([out[oi], out[oi + 1], out[oi + 2], out[oi + 3]]).toEqual([0, 255, 0, 255]);
  });

  it('均匀色源：内部像素仍是原色', () => {
    const out = warpPixels(solid(8, 8), 8, 8, FULL(8, 8), 4, 4);
    const ci = (2 * 4 + 2) * 4;
    expect(out[ci]).toBe(255);
    expect(out[ci + 1]).toBe(0);
    expect(out[ci + 3]).toBe(255);
  });
});
