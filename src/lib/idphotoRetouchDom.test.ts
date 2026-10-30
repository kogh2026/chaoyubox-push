// 渲染进程适配层的纯逻辑回归：人脸几何解析 / 统计摘要 / 空转判定。
// 真正的像素处理在 idphotoRetouch.test.ts 覆盖；这里不依赖 canvas，可在 Node 环境跑。

import { describe, expect, it } from 'vitest';
import {
  isRetouchIdle,
  resolveFaceGeometry,
  summarizeRetouch,
  type FaceLike,
} from './idphotoRetouchDom';
import type { PortraitRetouchStats } from './idphotoRetouch';

const emptyStats: PortraitRetouchStats = {
  engine: 'classic',
  smoothedPixels: 0,
  shinePixels: 0,
  underEyePixels: 0,
  blendPixels: 0,
  smooth: { radius: 0, eps: 0, mix: 0, pixels: 0, tiles: 0 },
};

/** 造一个居中人脸：框宽 40%，六点归一化 */
function faceAt(cx: number, cy: number, boxW = 0.4): FaceLike {
  return {
    score: 0.98,
    box: { x: cx - boxW / 2, y: cy - boxW * 0.65, w: boxW, h: boxW * 1.3 },
    kp: [
      { x: cx - 0.06, y: cy - 0.04 },
      { x: cx + 0.06, y: cy - 0.04 },
      { x: cx, y: cy + 0.02 },
      { x: cx, y: cy + 0.09 },
      { x: cx - 0.19, y: cy },
      { x: cx + 0.19, y: cy },
    ],
  };
}

describe('resolveFaceGeometry', () => {
  it('脸宽取框宽（像素）：800 宽图、框宽 0.4 → 320px', () => {
    const g = resolveFaceGeometry(faceAt(0.5, 0.4), 800, 600);
    expect(g.detected).toBe(true);
    expect(g.faceWidth).toBeCloseTo(320, 5);
  });

  it('有足够关键点时给出 4 个保护区（双眼 + 双眉）与 6 个区域（含嘴/鼻）', () => {
    const g = resolveFaceGeometry(faceAt(0.5, 0.4), 800, 600);
    const types = (g.protect ?? []).map((r) => r.type);
    expect(types.filter((t) => t === 'eye')).toHaveLength(2);
    expect(types.filter((t) => t === 'brow')).toHaveLength(2);
    expect(types).toContain('mouth');
    expect(types).toContain('nose');
    expect(g.eyeRegions).toHaveLength(2);
    // 眼下区域应落在眼睛下方
    const eye = (g.protect ?? []).find((r) => r.type === 'eye')!;
    expect(g.eyeRegions![0].cy).toBeGreaterThan(eye.cy!);
  });

  it('没有检测结果时按图宽 30% 估算，且不给保护区', () => {
    const g = resolveFaceGeometry(null, 1000, 1000);
    expect(g.detected).toBe(false);
    expect(g.faceWidth).toBeCloseTo(300, 5);
    expect(g.protect).toBeUndefined();
    expect(g.eyeRegions).toBeUndefined();
  });

  it('关键点不足 4 个（检测残缺）同样退回估算', () => {
    const bad: FaceLike = { box: { x: 0.3, y: 0.2, w: 0.4, h: 0.5 }, kp: [{ x: 0.4, y: 0.3 }] };
    const g = resolveFaceGeometry(bad, 500, 700);
    expect(g.detected).toBe(false);
    expect(g.faceWidth).toBeCloseTo(150, 5);
  });

  it('外部 faceWidth 优先于检测框宽', () => {
    const g = resolveFaceGeometry(faceAt(0.5, 0.4), 800, 600, { faceWidth: 123 });
    expect(g.faceWidth).toBe(123);
    expect(g.detected).toBe(true);
  });

  it('protectFeatures=false 时保留脸宽但不给保护区（只用掩码匀肤）', () => {
    const g = resolveFaceGeometry(faceAt(0.5, 0.4), 800, 600, { protectFeatures: false });
    expect(g.detected).toBe(true);
    expect(g.faceWidth).toBeCloseTo(320, 5);
    expect(g.protect).toBeUndefined();
    expect(g.eyeRegions).toBeUndefined();
  });

  it('框宽为 0（异常检测输出）不会得到 0 半径', () => {
    const zero: FaceLike = { ...faceAt(0.5, 0.4), box: { x: 0.5, y: 0.3, w: 0, h: 0 } };
    const g = resolveFaceGeometry(zero, 640, 480);
    expect(g.faceWidth).toBeGreaterThan(1);
    expect(g.faceWidth).toBeCloseTo(640 * 0.3, 5);
  });
});

describe('isRetouchIdle', () => {
  it('三档全 0 / 全缺省 → 空转', () => {
    expect(isRetouchIdle({})).toBe(true);
    expect(isRetouchIdle({ smoothing: 0, shine: 0, underEye: 0 })).toBe(true);
  });

  it('任一档 > 0 → 非空转', () => {
    expect(isRetouchIdle({ shine: 0.1 })).toBe(false);
    expect(isRetouchIdle({ underEye: 0.2 })).toBe(false);
    expect(isRetouchIdle({ smoothing: 0.5 })).toBe(false);
  });
});

describe('summarizeRetouch', () => {
  it('给出三档像素数、半径、脸宽与耗时', () => {
    const s = summarizeRetouch({
      stats: { ...emptyStats, smoothedPixels: 1200, shinePixels: 30, underEyePixels: 8, smooth: { radius: 12, eps: 0.01, mix: 0.78, pixels: 1200, tiles: 1 } },
      face: { detected: true, faceWidth: 320 },
      elapsedMs: 88.4,
    });
    expect(s).toContain('平滑 1200 px(r=12)');
    expect(s).toContain('油光 30 px');
    expect(s).toContain('眼下 8 px');
    expect(s).toContain('脸宽 320 px');
    expect(s).toContain('88 ms');
    expect(s).not.toContain('模型');
  });

  it('未检测到人脸时标注"估算"，有模型混合时附带模型像素', () => {
    const s = summarizeRetouch({
      stats: { ...emptyStats, blendPixels: 99 },
      face: { detected: false, faceWidth: 210 },
    });
    expect(s).toContain('脸宽 210 px(估算)');
    expect(s).toContain('模型 99 px');
  });
});
