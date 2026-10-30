// idphotoMatting 管线规格测试 —— 逐项对照逆向规格验证
import { describe, expect, it } from 'vitest';
import {
  MATTING_MODELS,
  SIZE_DIVISIBILITY,
  THREAD_CAP,
  applyAlphaToRGBA,
  computeThreadCount,
  decodeModelOutput,
  halfBitsToFloat,
  isValidModelInputSize,
  rgbaToModelInput,
  runMattingInference,
  type SessionLike,
} from './idphotoMatting';

describe('isValidModelInputSize（32 倍数约束）', () => {
  it('512×512 合法；32 的任意倍数合法（动态分辨率）', () => {
    expect(isValidModelInputSize(512, 512)).toBe(true);
    expect(isValidModelInputSize(512, 640)).toBe(true);
    expect(isValidModelInputSize(32, 32)).toBe(true);
  });
  it('非 32 倍数 / 小于 32 / 非整数 / 非有限 → 非法', () => {
    expect(isValidModelInputSize(513, 512)).toBe(false);
    expect(isValidModelInputSize(512, 300)).toBe(false);
    expect(isValidModelInputSize(0, 0)).toBe(false);
    expect(isValidModelInputSize(16, 32)).toBe(false);
    expect(isValidModelInputSize(512.5, 512)).toBe(false);
    expect(isValidModelInputSize(NaN, 512)).toBe(false);
    expect(isValidModelInputSize(Infinity, 512)).toBe(false);
  });
  it('规格常量：SIZE_DIVISIBILITY=32', () => {
    expect(SIZE_DIVISIBILITY).toBe(32);
  });
});

describe('computeThreadCount（线程策略）', () => {
  it('无 SharedArrayBuffer → 恒为 1', () => {
    expect(computeThreadCount(16, false)).toBe(1);
    expect(computeThreadCount(2, false)).toBe(1);
  });
  it('min(4, cores-1)，至少 1', () => {
    expect(computeThreadCount(2, true)).toBe(1);
    expect(computeThreadCount(4, true)).toBe(3);
    expect(computeThreadCount(8, true)).toBe(4);
    expect(computeThreadCount(32, true)).toBe(THREAD_CAP);
    expect(computeThreadCount(1, true)).toBe(1);
    expect(computeThreadCount(NaN, true)).toBe(1);
  });
});

describe('rgbaToModelInput（NCHW + 归一化）', () => {
  const rgba = new Uint8ClampedArray([
    0, 128, 255, 255,   // 像素 0
    255, 255, 255, 255, // 像素 1
    127, 128, 129, 255, // 像素 2
  ]);
  it('half 归一化：(v/255-0.5)/0.5，NCHW 平面排布（float32 中间舍入，容差 1e-8）', () => {
    const t = rgbaToModelInput(rgba, 3, 1, 'half');
    const half = (v: number) => (v / 255 - 0.5) / 0.5;
    // R 平面
    expect(t[0]).toBeCloseTo(half(0), 8);
    expect(t[1]).toBeCloseTo(half(255), 8);
    expect(t[2]).toBeCloseTo(half(127), 8);
    // G 平面（偏移 px=3）
    expect(t[3]).toBeCloseTo(half(128), 8);
    expect(t[4]).toBeCloseTo(half(255), 8);
    expect(t[5]).toBeCloseTo(half(128), 8);
    // B 平面（偏移 2px=6）
    expect(t[6]).toBeCloseTo(half(255), 8);
    expect(t[7]).toBeCloseTo(half(255), 8);
    expect(t[8]).toBeCloseTo(half(129), 8);
  });
  it('imagenet 归一化：逐通道 mean/std（先 /255 再归一）', () => {
    const t = rgbaToModelInput(rgba, 3, 1, 'imagenet');
    expect(t[0]).toBeCloseTo((0 / 255 - 0.485) / 0.229, 6);        // R 像素0 = 0
    expect(t[3 + 1]).toBeCloseTo((255 / 255 - 0.456) / 0.224, 6);  // G 像素1 = 255
    expect(t[6 + 2]).toBeCloseTo((129 / 255 - 0.406) / 0.225, 6);  // B 像素2 = 129
  });
  it('RGBA 长度不符 → 报错（含期望值提示）', () => {
    expect(() => rgbaToModelInput(new Uint8ClampedArray(3), 2, 1, 'half')).toThrow(/收到 3 个 RGBA/);
  });
});

describe('halfBitsToFloat（IEEE 754 半精度解码）', () => {
  it('标准位型', () => {
    expect(halfBitsToFloat(0x0000)).toBe(0);
    expect(halfBitsToFloat(0x8000)).toBe(-0); // -0
    expect(halfBitsToFloat(0x3c00)).toBe(1);
    expect(halfBitsToFloat(0xbc00)).toBe(-1);
    expect(halfBitsToFloat(0x4000)).toBe(2);
    expect(halfBitsToFloat(0x3800)).toBeCloseTo(0.5, 12);
    // 规格化数：exp=13, frac=低10位=0x155 → 2^(13-15)*(1+341/1024)
    expect(halfBitsToFloat(0x3555)).toBeCloseTo(2 ** (13 - 15) * (1 + 0x155 / 1024), 15);
    // 非规格化数：exp=0 → 2^-14 * frac/1024
    expect(halfBitsToFloat(0x0155)).toBeCloseTo(2 ** -14 * (0x155 / 1024), 15);
    expect(Number.isNaN(halfBitsToFloat(0x7e00))).toBe(true); // NaN
    expect(halfBitsToFloat(0x7c00)).toBe(Infinity);
    expect(halfBitsToFloat(0xfc00)).toBe(-Infinity);
  });
});

describe('decodeModelOutput（输出解码）', () => {
  it('alpha 直出 + clamp [0,1]', () => {
    const out = decodeModelOutput(
      { data: new Float32Array([-0.5, 0.25, 0.75, 1.5]), dims: [1, 1, 2, 2], type: 'float32' },
      'alpha',
      4,
    );
    expect(Array.from(out)).toEqual([0, 0.25, 0.75, 1]);
  });
  it('logits 过 sigmoid', () => {
    const out = decodeModelOutput(
      { data: new Float32Array([0, 100, -100]), dims: [1, 1, 3, 1], type: 'float32' },
      'logits',
      3,
    );
    expect(out[0]).toBeCloseTo(0.5, 12);
    expect(out[1]).toBeCloseTo(1, 6);
    expect(out[2]).toBeCloseTo(0, 6);
  });
  it('float16 张量先解码（0x3c00=1.0）', () => {
    const out = decodeModelOutput(
      { data: new Uint16Array([0x3c00, 0xbc00, 0x0000]), dims: [1, 1, 3, 1], type: 'float16' },
      'alpha',
      3,
    );
    expect(Array.from(out)).toEqual([1, 0, 0]);
  });
  it('blend 取 3 通道', () => {
    const out = decodeModelOutput(
      { data: new Float32Array([0.1, 0.2, 0.3, 2, -1, 0.5]), dims: [1, 3, 2, 1], type: 'float32' },
      'blend',
      2,
    );
    expect(out.length).toBe(6);
    const expected = [0.1, 0.2, 0.3, 1, 0, 0.5];
    expected.forEach((v, i) => expect(out[i]).toBeCloseTo(v, 6));
  });
  it('元素数不足 → 报错', () => {
    expect(() =>
      decodeModelOutput({ data: new Float32Array(3), dims: [1, 1, 3, 1], type: 'float32' }, 'alpha', 4),
    ).toThrow(/输出尺寸错误/);
  });
});

describe('runMattingInference（端到端顺序 + 阶段计时）', () => {
  const W = 32, H = 32;
  const rgba = new Uint8ClampedArray(W * H * 4).fill(128);
  function stubSession(alphaValue: number, outputType = 'float32'): SessionLike & { feeds: Record<string, { dims: readonly number[]; data: Float32Array }> } {
    const s: SessionLike & { feeds: Record<string, { dims: readonly number[]; data: Float32Array }> } = {
      inputNames: ['input'],
      outputNames: ['output'],
      feeds: {},
      async run(feeds) {
        s.feeds = feeds;
        const d = feeds['input']!.data;
        return {
          output: { data: new Float32Array(d.length / 3).fill(alphaValue), dims: [1, 1, H, W], type: outputType },
        };
      },
    };
    return s;
  }
  it('喂给模型的张量是 [1,3,h,w]、half 归一化；输出被 clamp', async () => {
    const s = stubSession(1.5);
    const r = await runMattingInference(s, rgba, W, H, MATTING_MODELS['matting-v1'], 1);
    const feed = s.feeds['input']!;
    expect(feed.dims).toEqual([1, 3, H, W]);
    expect(feed.data[0]).toBeCloseTo((128 / 255 - 0.5) / 0.5, 8);    expect(r.output.every((v) => v === 1)).toBe(true); // 1.5 clamp → 1
    expect(r.threads).toBe(1);
    expect(typeof r.inferenceMs).toBe('number');
  });
  it('非 32 倍数 → 先于推理抛错', async () => {
    await expect(runMattingInference(stubSession(0), rgba, 33, 32)).rejects.toThrow(/32 的倍数/);
  });
  it('多线程推理失败 → 抛 retrySingleThread 标记错误；单线程失败原样抛', async () => {
    const fail: SessionLike = {
      inputNames: ['input'],
      outputNames: ['output'],
      async run() { throw new Error('boom'); },
    };
    const e1 = await runMattingInference(fail, rgba, W, H, undefined, 4).catch((e) => e);
    expect(e1.retrySingleThread).toBe(true);
    const e2 = await runMattingInference(fail, rgba, W, H, undefined, 1).catch((e) => e);
    expect(e2.retrySingleThread).toBeUndefined();
  });
});

describe('applyAlphaToRGBA', () => {
  it('alpha 写回 A 通道（×255 四舍五入）', () => {
    const rgba = new Uint8ClampedArray(4 * 2);
    applyAlphaToRGBA(rgba, new Float32Array([0, 0.5]));
    expect(rgba[3]).toBe(0);
    expect(rgba[7]).toBe(128); // round(0.5*255)=128（四舍五入到偶数为 128）
  });
});
