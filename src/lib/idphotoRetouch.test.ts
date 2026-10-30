import { describe, expect, it } from 'vitest';
import {
  applyRetouchBlendMap,
  applyUnderEyeMap,
  buildFeatureProtectMask,
  buildUnderEyeMap,
  eyeRegionsFromKeypoints,
  featureRegionsFromKeypoints,
  reduceShine,
  resolveSmoothParams,
  retouchPortrait,
  smoothSkinGuided,
  type BlendMapLike,
} from './idphotoRetouch';
import { boxBlur, maskedMedian, resizeChannelBilinear, smoothstep } from './imageFilters';

// ---------------------------------------------------------------- 工具

const W = 64;
const H = 64;

function flat(w: number, h: number, r: number, g: number, b: number, a = 255): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = r;
    d[i * 4 + 1] = g;
    d[i * 4 + 2] = b;
    d[i * 4 + 3] = a;
  }
  return d;
}

/** 确定性伪随机噪声（避免依赖 Math.random 导致偶发失败） */
function noiseImage(w: number, h: number, base: number, amp: number, seed = 12345): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(255, base + (rnd() * 2 - 1) * amp));
    d[i * 4] = v;
    d[i * 4 + 1] = v;
    d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  return d;
}

function lumaAt(d: Uint8ClampedArray, w: number, x: number, y: number): number {
  const p = (y * w + x) * 4;
  return (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) / 255;
}

function stdOf(d: Uint8ClampedArray, w: number, h: number): number {
  const vals: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) vals.push(lumaAt(d, w, x, y));
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
}

function maxAbsDelta(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

const allOnes = (n: number) => new Float32Array(n).fill(1);
const allZeros = (n: number) => new Float32Array(n);

// ---------------------------------------------------------------- 滤波内核

describe('imageFilters', () => {
  it('boxBlur：常量图恒等（边界按实际窗口归一，不出现边缘变暗）', () => {
    const src = new Float32Array(8 * 8).fill(0.7);
    const out = boxBlur(src, 8, 8, 3);
    expect(out.every((v) => Math.abs(v - 0.7) < 1e-6)).toBe(true);
  });

  it('boxBlur：单点脉冲经两趟 3×3 后中心 = 1/9', () => {
    const src = new Float32Array(3 * 3);
    src[4] = 1;
    const out = boxBlur(src, 3, 3, 1);
    expect(out[4]).toBeCloseTo(1 / 9, 6);
  });

  it('boxBlur：radius=0 返回拷贝', () => {
    const src = new Float32Array([1, 2, 3, 4]);
    const out = boxBlur(src, 2, 2, 0);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
    expect(out).not.toBe(src);
  });

  it('smoothstep：端点/中点/越界', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 0)).toBe(0);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 12);
    expect(smoothstep(0, 1, 2)).toBe(1);
  });

  it('resizeChannelBilinear：1×2 → 1×4 像素中心对齐', () => {
    const out = resizeChannelBilinear(new Float32Array([0, 1]), 2, 1, 4, 1);
    expect(Array.from(out).map((v) => Number(v.toFixed(6)))).toEqual([0, 0.25, 0.75, 1]);
  });

  it('maskedMedian：只统计权重 > 阈值 的样本', () => {
    const v = new Float32Array([0.1, 0.2, 0.3, 0.9]);
    const w = new Float32Array([1, 1, 1, 0]);
    expect(maskedMedian(v, w)).toBeCloseTo(0.2, 3);
  });
});

// ---------------------------------------------------------------- 参数映射

describe('resolveSmoothParams（规格映射）', () => {
  it('强度 0：eps=0.015², mix=0.3, 半径按脸宽上限截断到 24', () => {
    const p = resolveSmoothParams(0, 1000);
    expect(p.radius).toBe(24);
    expect(p.eps).toBeCloseTo(0.015 ** 2, 12);
    expect(p.mix).toBeCloseTo(0.3, 12);
  });

  it('强度 1：eps=0.115², mix=0.9', () => {
    const p = resolveSmoothParams(1, 1000);
    expect(p.eps).toBeCloseTo(0.115 ** 2, 12);
    expect(p.mix).toBeCloseTo(0.9, 12);
  });

  it('脸宽很小时半径钳到下限 2；强度越界被夹紧', () => {
    const p = resolveSmoothParams(5, 40);
    expect(p.radius).toBe(2);
    expect(p.mix).toBeCloseTo(0.9, 12);
    expect(resolveSmoothParams(-3, 40).mix).toBeCloseTo(0.3, 12);
  });
});

// ---------------------------------------------------------------- 引导滤波匀肤

describe('smoothSkinGuided', () => {
  it('strength=0 → 零改动、零像素', () => {
    const d = noiseImage(W, H, 160, 30);
    const before = d.slice();
    const st = smoothSkinGuided(d, W, H, { strength: 0 });
    expect(st.pixels).toBe(0);
    expect(maxAbsDelta(d, before)).toBe(0);
  });

  it('掩码全 0 → 零改动（包围盒为空，不做无用计算）', () => {
    const d = noiseImage(W, H, 160, 30);
    const before = d.slice();
    const st = smoothSkinGuided(d, W, H, { strength: 1, mask: allZeros(W * H) });
    expect(st.pixels).toBe(0);
    expect(st.tiles).toBe(0);
    expect(maxAbsDelta(d, before)).toBe(0);
  });

  it('均匀色块 → 完全不变（引导滤波对常值域是恒等变换）', () => {
    const d = flat(W, H, 180, 140, 120);
    const before = d.slice();
    smoothSkinGuided(d, W, H, { strength: 1, mask: allOnes(W * H) });
    expect(maxAbsDelta(d, before)).toBe(0);
  });

  it('噪声皮肤 → 高频 σ 下降 ≥60%，整体亮度漂移 ≤1/255', () => {
    const d = noiseImage(W, H, 160, 26);
    const beforeStd = stdOf(d, W, H);
    const beforeMean = 160;
    const st = smoothSkinGuided(d, W, H, { strength: 1, mask: allOnes(W * H) });
    const afterStd = stdOf(d, W, H);
    expect(afterStd).toBeLessThan(beforeStd * 0.4);
    expect(st.pixels).toBe(W * H);
    let sum = 0;
    for (let i = 0; i < W * H; i++) sum += d[i * 4];
    expect(Math.abs(sum / (W * H) - beforeMean)).toBeLessThan(1.5);
  });

  it('强阶跃边缘 → 梯度保留 ≥85%（引导滤波保边，不是均值糊掉）', () => {
    const d = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = x < 32 ? 60 : 200;
        const p = (y * W + x) * 4;
        d[p] = v;
        d[p + 1] = v;
        d[p + 2] = v;
        d[p + 3] = 255;
      }
    }
    const before = Math.abs(lumaAt(d, W, 32, 20) - lumaAt(d, W, 31, 20));
    smoothSkinGuided(d, W, H, { strength: 1, mask: allOnes(W * H) });
    const after = Math.abs(lumaAt(d, W, 32, 20) - lumaAt(d, W, 31, 20));
    expect(after).toBeGreaterThan(before * 0.85);
  });

  it('掩码外像素逐位不变（只改皮肤）', () => {
    const d = noiseImage(W, H, 160, 30);
    const before = d.slice();
    const mask = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) mask[y * W + x] = 1;
    smoothSkinGuided(d, W, H, { strength: 1, mask });
    for (let y = 0; y < H; y++) {
      for (let x = W / 2; x < W; x++) {
        const p = (y * W + x) * 4;
        expect(d[p]).toBe(before[p]);
        expect(d[p + 1]).toBe(before[p + 1]);
        expect(d[p + 2]).toBe(before[p + 2]);
      }
    }
  });

  it('重复应用收敛：第二次改动显著小于第一次（不会越抹越糊）', () => {
    const d = noiseImage(W, H, 160, 26);
    const original = d.slice();
    smoothSkinGuided(d, W, H, { strength: 1, mask: allOnes(W * H) });
    const afterFirst = d.slice();
    smoothSkinGuided(d, W, H, { strength: 1, mask: allOnes(W * H) });
    const firstDelta = maxAbsDelta(afterFirst, original);
    const secondDelta = maxAbsDelta(d, afterFirst);
    expect(secondDelta).toBeLessThan(firstDelta * 0.5);
    expect(secondDelta).toBeLessThanOrEqual(12);
  });

  it('分块与整图逐位一致（块间内边距 ≥ 3·radius）', () => {
    const w = 300;
    const h = 280;
    const a = noiseImage(w, h, 150, 30, 999);
    const b = a.slice();
    const sa = smoothSkinGuided(a, w, h, { strength: 1, mask: allOnes(w * h), tilePixels: 65536 });
    const sb = smoothSkinGuided(b, w, h, { strength: 1, mask: allOnes(w * h), tilePixels: 1e9 });
    expect(sa.tiles).toBeGreaterThan(1);
    expect(sb.tiles).toBe(1);
    expect(maxAbsDelta(a, b)).toBe(0);
  });

  it('特征保护区内部几乎不动，区域外照常平滑', () => {
    const d = noiseImage(W, H, 160, 30);
    const before = d.slice();
    smoothSkinGuided(d, W, H, {
      strength: 1,
      mask: allOnes(W * H),
      protect: [{ type: 'eye', cx: 32, cy: 32, rx: 8, ry: 6 }],
    });
    // 中心 3×3 在保护椭圆内 → 基本不改（羽化边缘允许 ≤2 级溢出）
    for (let y = 31; y <= 33; y++) {
      for (let x = 31; x <= 33; x++) {
        const p = (y * W + x) * 4;
        expect(Math.abs(d[p] - before[p])).toBeLessThanOrEqual(2);
      }
    }
    // 左上角远离保护区 → 明显被平滑
    const p0 = (2 * W + 2) * 4;
    expect(Math.abs(d[p0] - before[p0])).toBeGreaterThanOrEqual(1);
  });

  it('强度单调：strength=1 的总改动量大于 strength=0.5', () => {
    const mk = () => noiseImage(W, H, 160, 26);
    const d1 = mk();
    const d2 = mk();
    const b1 = d1.slice();
    const b2 = d2.slice();
    smoothSkinGuided(d1, W, H, { strength: 0.5, mask: allOnes(W * H) });
    smoothSkinGuided(d2, W, H, { strength: 1, mask: allOnes(W * H) });
    const sum = (x: Uint8ClampedArray, y: Uint8ClampedArray) => {
      let s = 0;
      for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]);
      return s;
    };
    expect(sum(d2, b2)).toBeGreaterThan(sum(d1, b1));
  });

  it('lumaOnly：色度（R−G）改变小于逐通道模式', () => {
    const base = new Uint8ClampedArray(W * H * 4);
    let s = 7;
    const rnd = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    for (let i = 0; i < W * H; i++) {
      const n = (rnd() * 2 - 1) * 18;
      base[i * 4] = 190 + n;
      base[i * 4 + 1] = 130 + n;
      base[i * 4 + 2] = 110 + n;
      base[i * 4 + 3] = 255;
    }
    const pc = base.slice();
    const lo = base.slice();
    smoothSkinGuided(pc, W, H, { strength: 1, mask: allOnes(W * H) });
    smoothSkinGuided(lo, W, H, { strength: 1, mask: allOnes(W * H), lumaOnly: true });
    const chromaDrift = (d: Uint8ClampedArray) => {
      let acc = 0;
      for (let i = 0; i < W * H; i++) acc += Math.abs(d[i * 4] - d[i * 4 + 1] - 60);
      return acc / (W * H);
    };
    expect(chromaDrift(lo)).toBeLessThanOrEqual(chromaDrift(pc) + 1e-6);
  });

  it('掩码尺寸不符 → 报错', () => {
    const d = flat(W, H, 180, 140, 120);
    expect(() => smoothSkinGuided(d, W, H, { strength: 1, mask: new Float32Array(3) })).toThrow(
      /掩码尺寸错误/,
    );
  });
});

// ---------------------------------------------------------------- 油光抑制

describe('reduceShine', () => {
  it('strength=0 → 零改动', () => {
    const d = flat(W, H, 153, 153, 153);
    const before = d.slice();
    expect(reduceShine(d, W, H, { strength: 0 })).toBe(0);
    expect(maxAbsDelta(d, before)).toBe(0);
  });

  it('均匀皮肤 → 无高光可补，零改动', () => {
    const d = flat(W, H, 153, 153, 153);
    const before = d.slice();
    expect(reduceShine(d, W, H, { strength: 1, mask: allOnes(W * H), faceWidth: 40 })).toBe(0);
    expect(maxAbsDelta(d, before)).toBe(0);
  });

  it('局部高光斑 → 斑内亮度显著下降，整体不变暗', () => {
    const d = flat(W, H, 153, 153, 153);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if ((x - 32) ** 2 + (y - 32) ** 2 <= 36) {
          const p = (y * W + x) * 4;
          d[p] = 242;
          d[p + 1] = 242;
          d[p + 2] = 242;
        }
      }
    }
    const beforeCenter = lumaAt(d, W, 32, 32);
    const beforeBg = lumaAt(d, W, 3, 3);
    reduceShine(d, W, H, { strength: 1, mask: allOnes(W * H), faceWidth: 40 });
    expect(lumaAt(d, W, 32, 32)).toBeLessThan(beforeCenter - 0.1);
    expect(Math.abs(lumaAt(d, W, 3, 3) - beforeBg)).toBeLessThan(0.02);
  });
});

// ---------------------------------------------------------------- 眼下校正

describe('眼下校正', () => {
  it('无区域 → null', () => {
    const d = flat(W, H, 200, 200, 200);
    expect(buildUnderEyeMap(d, W, H, [])).toBeNull();
  });

  it('眼下暗斑 → 图内为正向偏差（>128），远处保持中性', () => {
    const d = flat(W, H, 200, 200, 200);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (((x - 24) / 8) ** 2 + ((y - 30) / 5) ** 2 <= 1) {
          const p = (y * W + x) * 4;
          d[p] = 120;
          d[p + 1] = 120;
          d[p + 2] = 120;
        }
      }
    }
    const map = buildUnderEyeMap(d, W, H, [{ cx: 24, cy: 30, rx: 8, ry: 5 }]);
    expect(map).not.toBeNull();
    const m = map as Float32Array;
    expect(m[30 * W + 24]).toBeGreaterThan(128);
    expect(m[2 * W + 60]).toBe(128);
  });

  it('应用公式精确：offset = (map−128)·0.4·alpha·strength', () => {
    const d = flat(W, H, 100, 100, 100);
    const map = new Float32Array(W * H).fill(179);
    const n = applyUnderEyeMap(d, W, H, map, 1);
    expect(n).toBe(W * H);
    expect(d[0]).toBe(120); // 100 + 51*0.4 = 120.4 → round 120
    expect(d[1]).toBe(120);
  });

  it('中性图（128）→ 零改动', () => {
    const d = flat(W, H, 100, 100, 100);
    const before = d.slice();
    expect(applyUnderEyeMap(d, W, H, new Float32Array(W * H).fill(128), 1)).toBe(0);
    expect(maxAbsDelta(d, before)).toBe(0);
  });

  it('尺寸不符 → 报错', () => {
    const d = flat(W, H, 100, 100, 100);
    expect(() => applyUnderEyeMap(d, W, H, new Float32Array(10), 1)).toThrow(/尺寸不一致/);
  });
});

// ---------------------------------------------------------------- 特征保护

describe('buildFeatureProtectMask', () => {
  it('空区域 → 全 1（不做任何排除）', () => {
    const m = buildFeatureProtectMask(W, H, [], 40);
    expect(m.every((v) => v === 1)).toBe(true);
  });

  it('椭圆内部被保护（0），远处为 1，边界存在羽化带', () => {
    const m = buildFeatureProtectMask(W, H, [{ type: 'eye', cx: 32, cy: 32, rx: 10, ry: 8 }], 40);
    expect(m[32 * W + 32]).toBeLessThan(0.1);
    expect(m[0]).toBe(1);
    // 羽化半径 = round(40*0.012) = 1（≥1），因此紧邻边界外侧应处于 0..1 之间
    const band: number[] = [];
    for (let x = 40; x < 46; x++) band.push(m[32 * W + x]);
    expect(band.some((v) => v > 0.05 && v < 0.95)).toBe(true);
  });

  it('多边形区域按点内判定被保护', () => {
    const tri = [
      { x: 10, y: 10 },
      { x: 50, y: 10 },
      { x: 30, y: 50 },
    ];
    const m = buildFeatureProtectMask(W, H, [{ type: 'other', points: tri, strokePx: 2 }], 40);
    expect(m[20 * W + 30]).toBeLessThan(0.1); // 三角形内部
    expect(m[60 * W + 5]).toBe(1); // 远处
  });
});

describe('关键点 → 区域', () => {
  const kp = [
    { x: 0.4, y: 0.4 },
    { x: 0.6, y: 0.4 },
    { x: 0.5, y: 0.5 },
    { x: 0.5, y: 0.6 },
  ];

  it('双眼各生成眼+眉，另加嘴与鼻，共 6 个区域', () => {
    const r = featureRegionsFromKeypoints(kp, W, H, 40);
    expect(r.length).toBe(6);
    expect(r.filter((x) => x.type === 'eye').length).toBe(2);
    expect(r.filter((x) => x.type === 'brow').length).toBe(2);
  });

  it('眼下区域落在眼点下方', () => {
    const e = eyeRegionsFromKeypoints(kp, W, H, 40);
    expect(e.length).toBe(2);
    expect(e[0].cy).toBeGreaterThan(0.4 * H);
    expect(e[0].rx).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- 模型 blend 通路

describe('applyRetouchBlendMap（retouch-v1 输出场）', () => {
  const blend = (
    w: number,
    h: number,
    v: number,
    alpha: number | null,
    scale: 'unit' | 'byte' = 'unit',
  ): BlendMapLike => {
    const ch = alpha === null ? 3 : 4;
    const data = new Float32Array(w * h * ch);
    for (let i = 0; i < w * h; i++) {
      data[i * ch] = v;
      data[i * ch + 1] = v;
      data[i * ch + 2] = v;
      if (ch === 4) data[i * ch + 3] = alpha as number;
    }
    return { data, width: w, height: h, channels: ch as 3 | 4, scale };
  };

  it('全 0.5（中性）→ 恒等变换', () => {
    const d = flat(16, 16, 128, 100, 60);
    const before = d.slice();
    applyRetouchBlendMap(d, 16, 16, blend(4, 4, 0.5, null), 1);
    expect(maxAbsDelta(d, before)).toBe(0);
  });

  it('>0.5 提亮、<0.5 压暗（曲线控制场语义）', () => {
    const up = flat(16, 16, 128, 128, 128);
    const down = flat(16, 16, 128, 128, 128);
    applyRetouchBlendMap(up, 16, 16, blend(4, 4, 0.7, null), 1);
    applyRetouchBlendMap(down, 16, 16, blend(4, 4, 0.3, null), 1);
    expect(up[0]).toBeGreaterThan(130);
    expect(down[0]).toBeLessThan(126);
  });

  it('strength 经 1.25 倍增益后钳到 1（不放大过冲）', () => {
    const a = flat(16, 16, 128, 128, 128);
    const b = flat(16, 16, 128, 128, 128);
    applyRetouchBlendMap(a, 16, 16, blend(4, 4, 0.8, null), 1);
    applyRetouchBlendMap(b, 16, 16, blend(4, 4, 0.8, null), 4);
    expect(maxAbsDelta(a, b)).toBe(0);
  });

  it('alpha=0 的像素不动（逐像素权重）', () => {
    const d = flat(16, 16, 128, 128, 128);
    const before = d.slice();
    const n = applyRetouchBlendMap(d, 16, 16, blend(4, 4, 0.9, 0), 1);
    expect(n).toBe(0);
    expect(maxAbsDelta(d, before)).toBe(0);
  });

  it('模型分辨率 ≠ 图尺寸时自动重采样，常量场仍得常量结果', () => {
    const d = flat(64, 64, 128, 128, 128);
    applyRetouchBlendMap(d, 64, 64, blend(6, 6, 0.7, null), 1);
    const set = new Set<number>();
    for (let i = 0; i < 64 * 64; i++) set.add(d[i * 4]);
    expect(set.size).toBeLessThanOrEqual(2);
  });

  it('scale=byte 与 unit 等价', () => {
    const a = flat(8, 8, 128, 128, 128);
    const b = flat(8, 8, 128, 128, 128);
    applyRetouchBlendMap(a, 8, 8, blend(4, 4, 0.7, null, 'unit'), 1);
    const byteBlend = blend(4, 4, 0.7 * 255, null, 'byte');
    applyRetouchBlendMap(b, 8, 8, byteBlend, 1);
    expect(maxAbsDelta(a, b)).toBeLessThanOrEqual(1);
  });

  it('strength=0 → 零改动', () => {
    const d = flat(8, 8, 128, 128, 128);
    const before = d.slice();
    expect(applyRetouchBlendMap(d, 8, 8, blend(4, 4, 0.9, null), 0)).toBe(0);
    expect(maxAbsDelta(d, before)).toBe(0);
  });
});

// ---------------------------------------------------------------- 总编排

describe('retouchPortrait', () => {
  it('三档全 0 → 零开销、零改动（不分配滤波缓冲）', () => {
    const d = noiseImage(W, H, 160, 20);
    const before = d.slice();
    const st = retouchPortrait(d, W, H, { smoothing: 0, shine: 0, underEye: 0 });
    expect(st.smoothedPixels).toBe(0);
    expect(st.shinePixels).toBe(0);
    expect(st.underEyePixels).toBe(0);
    expect(maxDeltaSafe(d, before)).toBe(0);
  });

  it('三档齐开 → 各自产出像素数，且掩码被复用', () => {
    const d = flat(W, H, 150, 150, 150);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 4;
        if ((x - 32) ** 2 + (y - 20) ** 2 <= 25) {
          d[p] = 245;
          d[p + 1] = 245;
          d[p + 2] = 245;
        }
        if (((x - 20) / 8) ** 2 + ((y - 36) / 4) ** 2 <= 1) {
          d[p] = 110;
          d[p + 1] = 110;
          d[p + 2] = 110;
        }
      }
    }
    const st = retouchPortrait(d, W, H, {
      smoothing: 1,
      shine: 1,
      underEye: 1,
      mask: allOnes(W * H),
      faceWidth: 40,
      eyeRegions: [{ cx: 20, cy: 36, rx: 8, ry: 4 }],
    });
    expect(st.smoothedPixels).toBeGreaterThan(0);
    expect(st.shinePixels).toBeGreaterThan(0);
    expect(st.underEyePixels).toBeGreaterThan(0);
    expect(st.engine).toBe('both');
  });

  it("engine='model' 且无 blendMap → 不走经典匀肤", () => {
    const d = noiseImage(W, H, 160, 30);
    const before = d.slice();
    const st = retouchPortrait(d, W, H, {
      smoothing: 1,
      engine: 'model',
      mask: allOnes(W * H),
    });
    expect(st.smoothedPixels).toBe(0);
    expect(st.smooth.tiles).toBe(0);
    expect(maxDeltaSafe(d, before)).toBe(0);
  });

  it("engine='model' 有 blendMap → 只走模型通路", () => {
    const d = flat(16, 16, 128, 128, 128);
    const blend: BlendMapLike = {
      data: new Float32Array(4 * 4 * 3).fill(0.7),
      width: 4,
      height: 4,
      channels: 3,
      scale: 'unit',
    };
    const st = retouchPortrait(d, 16, 16, { smoothing: 1, engine: 'model', blendMap: blend });
    expect(st.blendPixels).toBe(16 * 16);
    expect(st.smoothedPixels).toBe(0);
    expect(d[0]).toBeGreaterThan(130);
  });
});

function maxDeltaSafe(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}
