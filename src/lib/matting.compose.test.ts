import { describe, expect, it } from 'vitest';
import { composeGeometry, personLayerKey, type Placement } from './matting';
import type { RetouchOpts } from './matting';

// 1 寸 @300DPI：25×35mm → 295×413px
const W = 295;
const H = 413;
// 典型手机原图 3024×4032（12MP，3:4）
const SW = 3024;
const SH = 4032;

const base: RetouchOpts = {
  bg: { id: 'red', name: '红底', hex: '#FF0000' },
  whiten: 0,
  warm: 0,
  brightness: 0,
  edgeThreshold: 30,
  defringe: 0.7,
};

describe('composeGeometry：无取景（contain）', () => {
  const g = composeGeometry(W, H, SW, SH);

  it('按短边缩放，人物完整可见', () => {
    expect(g.scale).toBeCloseTo(W / SW, 6);
    expect(g.dw).toBeCloseTo(295, 6);
    expect(g.dh).toBeCloseTo(393.33, 1);
    expect(g.dh).toBeLessThanOrEqual(H);
  });

  it('水平/垂直都居中（旧实现无条件 clamp 会顶到左上角）', () => {
    expect(g.ox).toBeCloseTo(0, 6);
    expect(g.oy).toBeCloseTo((H - 393.33) / 2, 1);
    expect(g.oy).toBeGreaterThan(5);
  });

  it('人物层画布直接是输出尺寸量级（不是原图 12MP）', () => {
    expect(g.cw).toBe(295);
    expect(g.ch).toBe(393);
    expect(g.cw * g.ch).toBeLessThan(W * H * 1.05);
  });
});

describe('composeGeometry：取景微调（cover + 偏移 + 缩放）', () => {
  const pl: Placement = { dx: 40, dy: -25, zoom: 1.1 };
  const g = composeGeometry(W, H, SW, SH, pl);

  it('铺满画布，不露白', () => {
    expect(g.dw).toBeGreaterThanOrEqual(W);
    expect(g.dh).toBeGreaterThanOrEqual(H);
  });

  it('偏移生效但被钳制在覆盖范围内', () => {
    expect(g.ox).toBeLessThanOrEqual(0);
    expect(g.ox).toBeGreaterThanOrEqual(W - g.dw);
    expect(g.oy).toBeLessThanOrEqual(0);
    expect(g.oy).toBeGreaterThanOrEqual(H - g.dh);
  });

  it('超大偏移被钳制到边界', () => {
    const far = composeGeometry(W, H, SW, SH, { dx: 99999, dy: -99999, zoom: 1.1 });
    expect(far.ox).toBeCloseTo(0, 6);
    expect(far.oy).toBeCloseTo(H - far.dh, 6);
  });

  it('zoom 放大按比例体现', () => {
    const z2 = composeGeometry(W, H, SW, SH, { dx: 0, dy: 0, zoom: 2 });
    expect(z2.dw / g.dw).toBeCloseTo(2 / 1.1, 3);
  });
});

describe('composeGeometry：旋转按外接矩形缩放', () => {
  it('90° 后按外接矩形 cover，画布仍被铺满且不做位移时居中', () => {
    const g = composeGeometry(W, H, SW, SH, { dx: 0, dy: 0, rotation: 90 });
    // 外接矩形 4032×3024 → cover 取较高的一侧比例：dh=H，dw 溢出画布
    expect(g.dh).toBeCloseTo(H, 6);
    expect(g.dw).toBeCloseTo((H / SW) * SH, 6);
    expect(g.dw).toBeGreaterThan(W);
    expect(g.ox).toBeCloseTo((W - g.dw) / 2, 6);
    expect(g.ox).toBeGreaterThanOrEqual(W - g.dw);
    expect(g.rad).toBeCloseTo(Math.PI / 2, 6);
  });

  it('旋转 90° 后人物层画布仍是输出量级（不是原图 12MP）', () => {
    const g = composeGeometry(W, H, SW, SH, { dx: 0, dy: 0, rotation: 90 });
    expect(g.cw * g.ch).toBeLessThan(W * H * 5);
  });
});

describe('personLayerKey：只管像素级参数', () => {
  it('换底色 / 黑白 不改变人物层指纹', () => {
    const red = personLayerKey(base, W, H);
    const blue = personLayerKey(
      { ...base, bg: { id: 'blue', name: '蓝底', hex: '#438EDB' }, mono: true },
      W,
      H,
    );
    expect(blue).toBe(red);
  });

  it('美白 / 阈值 / 去晕边 / 取景 改变指纹', () => {
    expect(personLayerKey({ ...base, whiten: 0.2 }, W, H)).not.toBe(personLayerKey(base, W, H));
    expect(personLayerKey({ ...base, edgeThreshold: 40 }, W, H)).not.toBe(personLayerKey(base, W, H));
    expect(personLayerKey({ ...base, defringe: 0 }, W, H)).not.toBe(personLayerKey(base, W, H));
    expect(personLayerKey(base, W, H, { dx: 3, dy: 0 })).not.toBe(personLayerKey(base, W, H));
    expect(personLayerKey(base, 413, 531)).not.toBe(personLayerKey(base, W, H));
  });

  // 历史缺陷：placements 类型漏了 zoom，取景缩放不参与指纹 → 缓存命中上一档的人物层。
  // 这条断言把「构图层必须完整参与指纹」钉住（拆分 composeOne 时的护栏）。
  it('取景的 zoom / rotation 必须改变指纹', () => {
    expect(personLayerKey(base, W, H, { dx: 0, dy: 0, zoom: 1.2 })).not.toBe(
      personLayerKey(base, W, H, { dx: 0, dy: 0, zoom: 1 }),
    );
    expect(personLayerKey(base, W, H, { dx: 0, dy: 0, rotation: 90 })).not.toBe(
      personLayerKey(base, W, H, { dx: 0, dy: 0, rotation: 0 }),
    );
  });
});
