// framingGuides 纯逻辑回归：吸附、居中判定、徽标文案、旋转决策、脸轴几何。

import { describe, expect, it } from 'vitest';
import {
  fallbackFaceInfo,
  CENTERED_MM,
  LEVEL_DEG,
  alongUnit,
  centerLabel,
  centerOffsetMm,
  centeredOffsetX,
  eyeMidBoxX,
  eyeRollDeg,
  faceAxis,
  isCentered,
  isLevel,
  pxToMm,
  snapOffset,
  snapRotation,
  tiltLabel,
} from './framingGuides';

describe('snapOffset（拖动中线吸附，原版 Sh）', () => {
  it('6px 范围内吸附到居中位', () => {
    expect(snapOffset(103, 100, 6, false)).toBe(100);
    expect(snapOffset(106, 100, 6, false)).toBe(100);
    expect(snapOffset(106.5, 100, 6, false)).toBe(106.5);
    expect(snapOffset(94, 100, 6, false)).toBe(100);
  });

  it('按住 Alt 时不吸附', () => {
    expect(snapOffset(101, 100, 6, true)).toBe(101);
    expect(snapOffset(100.2, 100, 6, true)).toBe(100.2);
  });
});

describe('居中几何与判定', () => {
  it('centeredOffsetX：让眼位点落到框中心的图像偏移', () => {
    // 图内眼位 x=310，缩放 1，框宽 600 → off.x = 600/2 - 310 = -10
    expect(centeredOffsetX(310, 1, 600)).toBeCloseTo(-10, 6);
    // 缩放 0.5：off.x = 300 - 155 = 145
    expect(centeredOffsetX(310, 0.5, 600)).toBeCloseTo(145, 6);
  });

  it('eyeMidBoxX 与 centeredOffsetX 互逆：吸附后眼中点恰在框中心', () => {
    const off = centeredOffsetX(310, 0.5, 600);
    expect(eyeMidBoxX(off, 310, 0.5)).toBeCloseTo(300, 6);
  });

  it('centerOffsetMm：300DPI 下 1mm ≈ 11.81px', () => {
    expect(pxToMm(35 * 11.811)).toBeCloseTo(35, 1);
    // 框内眼中点恰在中心 → 0mm
    expect(centerOffsetMm(150, 300, 295)).toBeCloseTo(0, 9);
    // 偏右半个框宽 → pxW/2 对应的 mm
    const mm = centerOffsetMm(300, 300, 295);
    expect(mm).toBeCloseTo(pxToMm(147.5), 6);
    expect(mm).toBeGreaterThan(0);
  });

  it('居中阈值 0.05mm：小于即居中，否则带方向', () => {
    expect(isCentered(0.049)).toBe(true);
    expect(isCentered(-0.049)).toBe(true);
    expect(isCentered(0.051)).toBe(false);
    expect(centerLabel(0)).toBe('居中');
    expect(centerLabel(0.03)).toBe('居中');
    expect(centerLabel(1.24)).toBe('1.2 mm 偏右');
    expect(centerLabel(-2.06)).toBe('2.1 mm 偏左');
    expect(CENTERED_MM).toBe(0.05);
  });
});

describe('旋转吸附与文案', () => {
  it('距水平 0.6° 内吸附回水平角（不一定是 0°，照片本身可能歪）', () => {
    expect(snapRotation(2.3, 2.75, false, false)).toBe(2.75);
    expect(snapRotation(2.0, 2.75, false, false)).toBe(2.0);
    expect(LEVEL_DEG).toBe(0.6);
  });

  it('按住 Alt 时不吸附水平（保留 0.1° 精度）', () => {
    expect(snapRotation(2.31, 2.0, true, false)).toBe(2.3);
    expect(snapRotation(-0.21, 0, true, false)).toBe(-0.2);
  });

  it('按住 Shift 时按 15° 吸附', () => {
    expect(snapRotation(17, 0, false, true)).toBe(15);
    expect(snapRotation(-22, 0, false, true)).toBe(-15);
  });

  it('普通角度保留 0.1° 精度', () => {
    expect(snapRotation(3.14159, 9, false, false)).toBe(3.1);
  });

  it('文案：水平阈值 0.05°，正值右低', () => {
    expect(isLevel(0.04)).toBe(true);
    expect(tiltLabel(0)).toBe('水平');
    expect(tiltLabel(1.24)).toBe('1.2° 右低');
    expect(tiltLabel(-0.51)).toBe('0.5° 左低');
  });
});

describe('脸轴与眼轴线几何', () => {
  it('faceAxis：头顶/下巴按脸宽比例近似，且 clamp 进框内', () => {
    // 眼位 (100, 200)（框内），脸宽 100 → 头顶 130，下巴 295
    const a = faceAxis({ x: 100, y: 200 }, 100, 1, 0, 0, 800);
    expect(a.x).toBe(100);
    expect(a.topY).toBeCloseTo(130, 6);
    expect(a.bottomY).toBeCloseTo(295, 6);
    // 眼位贴近框顶：头顶被 clamp 到 0
    const b = faceAxis({ x: 100, y: 20 }, 100, 1, 0, 0, 800);
    expect(b.topY).toBe(0);
    // 眼位贴近框底：下巴 clamp 到框高
    const c = faceAxis({ x: 100, y: 780 }, 100, 1, 0, 0, 800);
    expect(c.bottomY).toBe(800);
  });

  it('alongUnit：沿单位向量取半长', () => {
    const s = alongUnit(100, 100, 1, 0, 36);
    expect(s).toEqual({ x1: 64, y1: 100, x2: 136, y2: 100 });
  });

  it('eyeRollDeg：右眼低为正（右低）', () => {
    // 右眼 (100,110)、左眼 (200,100)：右眼低 10px → 正角
    expect(eyeRollDeg({ x: 100, y: 110 }, { x: 200, y: 100 })).toBeGreaterThan(0);
    expect(eyeRollDeg({ x: 100, y: 100 }, { x: 200, y: 110 })).toBeLessThan(0);
    expect(eyeRollDeg({ x: 100, y: 100 }, { x: 200, y: 100 })).toBeCloseTo(0, 9);
  });
});

describe('无脸回退', () => {
  it('fallbackFaceInfo：眼位=图像中心、脸宽=图宽 40%、倾角 0', () => {
    const f = fallbackFaceInfo(800, 600);
    expect(f.eyeMid).toEqual({ x: 400, y: 300 });
    expect(f.faceWidth).toBeCloseTo(320, 6);
    expect(f.rollDeg).toBe(0);
    // 由此派生的几何居中 = contain 基准偏移（与无脸 A 键行为一致）
    const scale = 0.5;
    const drawW = 800 * scale;
    expect(centeredOffsetX(f.eyeMid.x, scale, 300)).toBeCloseTo((300 - drawW) / 2, 6);
  });
});
