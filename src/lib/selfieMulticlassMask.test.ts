// selfie-multiclass 掩码模块测试：纯函数数学 + 真实模型文件 sanity
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MULTICLASS_CATEGORIES,
  combinePersonMask,
  personLowerBody,
  resizeMask,
  resolveVisionPaths,
} from './selfieMulticlassMask';

/** 构造 6 通道假置信掩码：第 c 通道像素 i 取值 spec(c,i) */
function fakeMasks(n: number, spec: (c: number, i: number) => number): Float32Array[] {
  return Array.from({ length: 6 }, (_, c) => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = spec(c, i);
    return a;
  });
}


describe('resizeMask', () => {
  it('同尺寸 → 原引用返回（零拷贝）', () => {
    const m = new Float32Array([1, 2, 3, 4]);
    expect(resizeMask(m, 2, 2, 2, 2)).toBe(m);
  });

  it('2x2 → 4x4 放大：角点值保持，中心为双线性插值', () => {
    // [1,2 / 3,4]
    const out = resizeMask(new Float32Array([1, 2, 3, 4]), 2, 2, 4, 4);
    expect(out.length).toBe(16);
    // 源角 (0,0)=1 与 (3,3)=4
    expect(out[0]).toBeCloseTo(1, 12);
    expect(out[15]).toBeCloseTo(4, 12);
    // 显式插值值：(y1,x2) = 双线性(v00=1,v01=2,v10=3,v11=4; tx=0.75,ty=0.25) = 2.25
    expect(out[6]).toBeCloseTo(2.25, 12);
    // (y2,x1)：tx=0.25, ty=0.75 → 2.75
    expect(out[9]).toBeCloseTo(2.75, 12);
  });

  it('4x4 → 2x2 缩小：均值性', () => {
    const m = new Float32Array(16).fill(0.5);
    const out = resizeMask(m, 4, 4, 2, 2);
    expect(out.every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
  });

  it('非法尺寸报错', () => {
    expect(() => resizeMask(new Float32Array(4), 0, 2, 2, 2)).toThrow(/非法/);
  });
});


describe('resolveVisionPaths（桌面预装 / CDN 回退）', () => {
  it('桌面端：appres:// 预装路径', () => {
    const p = resolveVisionPaths('appres://res/');
    expect(p.wasmBase).toBe('appres://res/mediapipe-vision/wasm');
    expect(p.modelUrl).toBe(
      'appres://res/seg-model/selfie_multiclass_256x256.tflite',
    );
  });

  it('无 appResBase → CDN 回退', () => {
    const p = resolveVisionPaths(undefined);
    expect(p.wasmBase).toContain('cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@');
    expect(p.modelUrl).toContain('storage.googleapis.com/mediapipe-models');
    expect(p.modelUrl.endsWith('.tflite')).toBe(true);
  });

  it('resources 内 wasm 与模型文件已就位（打包 extraResources 源）', () => {
    expect(existsSync(resolve(__dirname, '../../resources/mediapipe-vision/wasm/vision_wasm_internal.wasm'))).toBe(true);
    expect(existsSync(resolve(__dirname, '../../resources/mediapipe-vision/wasm/vision_wasm_module_internal.wasm'))).toBe(true);
  });
});

describe('真实模型文件 sanity（不做推理）', () => {
  const MODEL = resolve(__dirname, '../../resources/seg-model/selfie_multiclass_256x256.tflite');

  it('模型存在、TFLite 格式、体积合理（~15.6MB）', () => {
    expect(existsSync(MODEL)).toBe(true);
    const buf = readFileSync(MODEL);
    expect(buf.length).toBeGreaterThan(15 * 1024 * 1024);
    expect(buf.length).toBeLessThan(20 * 1024 * 1024);
    expect(buf.subarray(4, 8).toString('ascii')).toBe('TFL3');
  });

  it('类别索引表与官方一致', () => {
    expect(MULTICLASS_CATEGORIES).toEqual({
      background: 0,
      hair: 1,
      bodySkin: 2,
      faceSkin: 3,
      clothes: 4,
      others: 5,
    });
  });
});

// ---------- 功能1：人物掩码合成 + 下半身定位（放大填满的判定依据） ----------
describe('combinePersonMask：人物 = 身体皮肤 + 衣物 + 面部皮肤（排除背景/头发/others）', () => {
  it('三个通道并集，且 clamp 到 0..1', () => {
    const n = 4;
    const masks = fakeMasks(n, (c, i) => {
      if (c === MULTICLASS_CATEGORIES.bodySkin) return i === 0 ? 0.9 : 0;
      if (c === MULTICLASS_CATEGORIES.clothes) return i === 1 ? 0.8 : 0;
      if (c === MULTICLASS_CATEGORIES.faceSkin) return i === 2 ? 0.7 : 0;
      if (c === MULTICLASS_CATEGORIES.background) return 0.95; // 背景不得计入人物
      if (c === MULTICLASS_CATEGORIES.hair) return i === 3 ? 0.99 : 0; // 头发不得计入
      return 0;
    });
    const person = combinePersonMask(masks, n);
    // Float32Array 存 0.9 会有 ~1e-8 精度损失，逐项近似比较
    const got = Array.from(person);
    expect(got).toHaveLength(4);
    expect(got[0]).toBeCloseTo(0.9, 5);
    expect(got[1]).toBeCloseTo(0.8, 5);
    expect(got[2]).toBeCloseTo(0.7, 5);
    expect(got[3]).toBe(0);
  });

  it('通道重叠相加后 clamp 为 1', () => {
    const n = 2;
    const masks = fakeMasks(n, (c) => (c === MULTICLASS_CATEGORIES.bodySkin || c === MULTICLASS_CATEGORIES.clothes ? 0.8 : 0));
    expect(Array.from(combinePersonMask(masks, n))).toEqual([1, 1]);
  });

  it('长度不符时报错', () => {
    const masks = fakeMasks(4, () => 0);
    expect(() => combinePersonMask(masks, 9)).toThrow(/长度/);
  });
});

describe('personLowerBody：自底向上找人物真实底部', () => {
  // 40×100 的掩码：人物占 y∈[10,60) 的全部宽度，其余为背景
  const W = 40;
  const H = 100;
  const make = (topRow: number, bottomRow: number) => {
    const m = new Float32Array(W * H);
    for (let y = topRow; y <= bottomRow; y++) for (let x = 0; x < W; x++) m[y * W + x] = 0.9;
    return m;
  };

  it('人物底部 = 最后一个有人物像素的行（归一化）', () => {
    const r = personLowerBody(make(10, 60), W, H);
    expect(r.found).toBe(true);
    expect(r.topFrac).toBeCloseTo(10.5 / 100, 5);
    expect(r.bottomFrac).toBeCloseTo(60.5 / 100, 5);
    expect(r.reachedBottom).toBe(false);
  });

  it('人物裁到图底 → reachedBottom=true', () => {
    const r = personLowerBody(make(10, H - 1), W, H);
    expect(r.reachedBottom).toBe(true);
    expect(r.bottomFrac).toBeGreaterThan(0.98);
  });

  it('全背景 → found=false 且 bottomFrac=1（调用方回退整图近似）', () => {
    const r = personLowerBody(new Float32Array(W * H), W, H);
    expect(r.found).toBe(false);
    expect(r.bottomFrac).toBe(1);
  });

  it('低置信噪点（<阈值）不算人物', () => {
    const m = new Float32Array(W * H);
    for (let i = 0; i < m.length; i++) m[i] = 0.2;
    expect(personLowerBody(m, W, H, 0.4).found).toBe(false);
  });

  it('尺寸非法时安全返回未检出', () => {
    expect(personLowerBody(new Float32Array(10), 3, 3).found).toBe(false);
  });
});
