// idphotoSkinRetouch 测试 —— 内置兜底皮肤掩码
import { describe, expect, it } from 'vitest';
import { ycbcrSkinMask } from './idphotoSkinRetouch';

describe('ycbcrSkinMask（内置兜底掩码）', () => {
  it('典型肤色像素 → 1；纯白/纯黑/透明 → 0', () => {
    const rgba = new Uint8ClampedArray([
      224, 172, 150, 255, // 肤色
      255, 255, 255, 255, // 白
      20, 20, 20, 255,    // 暗（Y≤60）
      100, 150, 200, 0,   // 透明
    ]);
    const m = ycbcrSkinMask(rgba, 4, 1);
    expect(m[0]).toBe(1);
    expect(m[1]).toBe(0);
    expect(m[2]).toBe(0);
    expect(m[3]).toBe(0);
  });
});
