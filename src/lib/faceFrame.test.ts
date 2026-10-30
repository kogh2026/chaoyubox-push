import { describe, it, expect } from 'vitest';
import { autoPlacement, faceRollDeg, faceYawRatio, headFromFace } from './faceFrame';
import { decodeFaces } from './faceDetect';
import type { DetectedFace } from './faceDetect';

const face = (box: DetectedFace['box'], kp: DetectedFace['kp']): DetectedFace => ({
  score: 0.95,
  box,
  kp,
});

describe('头部几何 headFromFace', () => {
  it('有关键点时：发顶在眼线上方、下巴在嘴下方，高度合理', () => {
    const f = face(
      { x: 0.3, y: 0.25, w: 0.4, h: 0.4 },
      [
        { x: 0.42, y: 0.35 }, // 右眼
        { x: 0.58, y: 0.35 }, // 左眼
        { x: 0.5, y: 0.42 }, // 鼻
        { x: 0.5, y: 0.47 }, // 嘴
        { x: 0.28, y: 0.38 },
        { x: 0.72, y: 0.38 },
      ],
    );
    const h = headFromFace(f);
    expect(h.top).toBeLessThan(0.35); // 发顶高于眼线
    expect(h.top + h.height).toBeGreaterThan(0.47); // 下巴低于嘴
    expect(h.height).toBeGreaterThan(0.2);
    expect(h.cx).toBeCloseTo(0.5, 2);
  });

  it('关键点缺失时退回人脸框推算', () => {
    const h = headFromFace(face({ x: 0.3, y: 0.3, w: 0.4, h: 0.4 }, []));
    expect(h.top).toBeCloseTo(0.3 - 0.048, 3);
    expect(h.height).toBeCloseTo(0.448, 3);
  });
});

describe('自动构图 autoPlacement', () => {
  it('按规格把头顶放到 9%、头高放到 60%（不被 clamp 时）', () => {
    const imgW = 1000;
    const imgH = 1000;
    const targetW = 300;
    const targetH = 420;
    const head = { cx: 0.5, top: 0.2, height: 0.35 };
    const p = autoPlacement(head, imgW, imgH, targetW, targetH);

    // 复算 composePhoto 的落点
    const cover = Math.max(targetW / imgW, targetH / imgH);
    const scale = cover * p.zoom;
    const dw = imgW * scale;
    const dh = imgH * scale;
    const ox = (targetW - dw) / 2 + p.dx;
    const oy = (targetH - dh) / 2 + p.dy;
    const headTopPx = head.top * imgH * scale + oy;
    const headPx = head.height * imgH * scale;
    const cxPx = head.cx * imgW * scale + ox;

    expect(headTopPx).toBeCloseTo(0.09 * targetH, 0);
    expect(headPx).toBeCloseTo(0.6 * targetH, 0);
    expect(cxPx).toBeCloseTo(targetW / 2, 0);
  });

  it('zoom 不小于 1（cover 基准），不会露白', () => {
    // 头部已经很大 → 想缩小，但必须锁在 1
    const p = autoPlacement({ cx: 0.5, top: 0.05, height: 0.9 }, 1000, 1000, 300, 420);
    expect(p.zoom).toBe(1);
  });

  it('窄长原图也能铺满（位移被限制在可见范围内）', () => {
    const p = autoPlacement({ cx: 0.9, top: 0.1, height: 0.5 }, 600, 1600, 300, 420);
    expect(p.zoom).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(p.dx) && Number.isFinite(p.dy)).toBe(true);
  });
});

describe('角度指标', () => {
  it('正脸：眼线水平、鼻子居中', () => {
    const f = face(
      { x: 0.3, y: 0.3, w: 0.4, h: 0.4 },
      [
        { x: 0.4, y: 0.4 },
        { x: 0.6, y: 0.4 },
        { x: 0.5, y: 0.45 },
        { x: 0.5, y: 0.5 },
        { x: 0.3, y: 0.42 },
        { x: 0.7, y: 0.42 },
      ],
    );
    expect(Math.abs(faceRollDeg(f))).toBeLessThan(0.001);
    expect(Math.abs(faceYawRatio(f))).toBeLessThan(0.001);
  });

  it('头向右歪 10° 能被识别为倾斜', () => {
    const f = face(
      { x: 0.3, y: 0.3, w: 0.4, h: 0.4 },
      [
        { x: 0.4, y: 0.4 },
        { x: 0.6, y: 0.4353 },
        { x: 0.5, y: 0.45 },
        { x: 0.5, y: 0.5 },
        { x: 0.3, y: 0.42 },
        { x: 0.7, y: 0.42 },
      ],
    );
    expect(faceRollDeg(f)).toBeGreaterThan(9);
    expect(faceRollDeg(f)).toBeLessThan(11);
  });

  it('偏头：鼻子偏离双眼中点', () => {
    const f = face(
      { x: 0.3, y: 0.3, w: 0.4, h: 0.4 },
      [
        { x: 0.4, y: 0.4 },
        { x: 0.6, y: 0.4 },
        { x: 0.58, y: 0.45 },
        { x: 0.5, y: 0.5 },
        { x: 0.3, y: 0.42 },
        { x: 0.7, y: 0.42 },
      ],
    );
    expect(faceYawRatio(f)).toBeCloseTo(0.8, 2);
  });
});

describe('解码 decodeFaces（网络输出 → 人脸）', () => {
  const anchors = Array.from({ length: 896 }, () => [0.5, 0.5, 1, 1]);

  it('低于阈值不输出', () => {
    const reg = new Float32Array(896 * 16);
    const cls = new Float32Array(896);
    cls[0] = -5; // sigmoid ≈ 0.0067
    expect(decodeFaces(reg, cls, anchors).length).toBe(0);
  });

  it('高置信锚点解码出框与关键点，同位置重复框被 NMS 合并', () => {
    const reg = new Float32Array(896 * 16);
    const cls = new Float32Array(896);
    cls[0] = 3;
    cls[1] = 2.9; // 与第 0 个几乎重合
    // 第 0 个：中心偏移 0、宽高 16/128
    reg[2] = 16;
    reg[3] = 16;
    const faces = decodeFaces(reg, cls, anchors);
    expect(faces.length).toBe(1);
    expect(faces[0].box.w).toBeCloseTo(16 / 128, 3);
    expect(faces[0].kp.length).toBe(6);
  });
});
