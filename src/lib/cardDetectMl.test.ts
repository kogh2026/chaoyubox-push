import { describe, expect, it } from 'vitest';
import { maskToQuad } from './cardDetectMl';

// 构造一张 w×h 的 alpha 蒙版，中心矩形（比例 rx×ry）为前景（255），其余为 0
function makeMask(w: number, h: number, rx: number, ry: number): Uint8ClampedArray {
  const a = new Uint8ClampedArray(w * h);
  const x0 = Math.floor((w - w * rx) / 2);
  const x1 = Math.floor((w + w * rx) / 2);
  const y0 = Math.floor((h - h * ry) / 2);
  const y1 = Math.floor((h + h * ry) / 2);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[y * w + x] = 255;
  return a;
}

describe('cardDetectMl.maskToQuad（纯函数，T3 可选 ML）', () => {
  it('居中矩形蒙版 → 归一化 quad 贴近边界且置信度合理', () => {
    const w = 100;
    const h = 60;
    const a = makeMask(w, h, 0.6, 0.5); // 前景占 ~30%
    const r = maskToQuad(a, w, h);
    expect(r).not.toBeNull();
    // 四角应接近边界 [0.2,0.8]×[0.25,0.75] 附近
    expect(r!.quad.p0.x).toBeCloseTo(0.2, 1);
    expect(r!.quad.p2.x).toBeCloseTo(0.8, 1);
    expect(r!.quad.p0.y).toBeCloseTo(0.25, 1);
    expect(r!.quad.p2.y).toBeCloseTo(0.75, 1);
    expect(r!.confidence).toBeGreaterThanOrEqual(0.62);
    expect(r!.confidence).toBeLessThanOrEqual(0.92);
  });

  it('全透明（无前景）→ null', () => {
    const a = new Uint8ClampedArray(100 * 60); // 全 0
    expect(maskToQuad(a, 100, 60)).toBeNull();
  });

  it('几乎全幅（>98.5%）→ null（不像一张卡）', () => {
    const a = new Uint8ClampedArray(100 * 60).fill(255);
    expect(maskToQuad(a, 100, 60)).toBeNull();
  });

  it('前景过小（<10%）→ null', () => {
    const a = makeMask(100, 60, 0.05, 0.05);
    expect(maskToQuad(a, 100, 60)).toBeNull();
  });
});
