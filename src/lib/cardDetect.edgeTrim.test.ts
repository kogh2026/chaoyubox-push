import { describe, it, expect } from 'vitest';
import { insetQuad, EDGE_TRIM_FRAC } from './cardDetect';
import type { Pt } from './cvGeometry';

const quad: Pt[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 60 },
  { x: 0, y: 60 },
];

describe('insetQuad（裁边内缩，消除小黑边）', () => {
  it('质心保持不变', () => {
    const out = insetQuad(quad, 0.1);
    const ic = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
    const iy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
    const oc = (out[0].x + out[1].x + out[2].x + out[3].x) / 4;
    const oy = (out[0].y + out[1].y + out[2].y + out[3].y) / 4;
    expect(oc).toBeCloseTo(ic, 6);
    expect(oy).toBeCloseTo(iy, 6);
  });

  it('四角朝质心收进 frac（按距质心比例收敛）', () => {
    const out = insetQuad(quad, 0.1);
    // 角点 (100,0) 距质心 (50,30)：x 分量 50 → 收进 10% → 50 + 50*0.9 = 95
    expect(out[1].x).toBeCloseTo(95, 6);
    expect(out[1].y).toBeCloseTo(3, 6);
  });

  it('frac<=0 原样返回（不改引用内容）', () => {
    expect(insetQuad(quad, 0)).toBe(quad);
  });

  it('EDGE_TRIM_FRAC 在合理范围（足以去小黑边又不损卡面）', () => {
    expect(EDGE_TRIM_FRAC).toBeGreaterThan(0);
    expect(EDGE_TRIM_FRAC).toBeLessThan(0.05);
  });
});
