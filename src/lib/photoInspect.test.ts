import { describe, expect, it } from 'vitest';
import {
  inspectResolution,
  inspectExposure,
  inspectBackground,
  inspectFraming,
  inspectAll,
  meanLuminance,
  edgeColorStd,
  framingMetrics,
  ISSUE_LABEL,
} from './photoInspect';

describe('inspectResolution', () => {
  it('原图足够大 → 无问题', () => {
    expect(inspectResolution(1200, 1600, 295, 413)).toBeNull();
  });
  it('原图短边不足目标的 80% → 分辨率不足', () => {
    const r = inspectResolution(200, 300, 295, 413);
    expect(r?.code).toBe('resolution');
  });
});

describe('inspectExposure', () => {
  it('过亮', () => {
    expect(inspectExposure(240)?.code).toBe('overexposed');
  });
  it('过暗', () => {
    expect(inspectExposure(20)?.code).toBe('underexposed');
  });
  it('正常', () => {
    expect(inspectExposure(128)).toBeNull();
  });
});

describe('inspectBackground', () => {
  it('纯色边（std≈0）→ 无问题', () => {
    expect(inspectBackground(2)).toBeNull();
  });
  it('杂色边（std>28）→ 背景不纯', () => {
    expect(inspectBackground(40)?.code).toBe('background');
  });
});

describe('inspectFraming', () => {
  it('水平偏移过大 → 构图偏移', () => {
    expect(inspectFraming(0.2, 0.01)?.code).toBe('framing');
  });
  it('上下错位过大 → 角度偏移', () => {
    expect(inspectFraming(0.02, 0.12)?.code).toBe('angle');
  });
  it('居中且对称 → 无问题', () => {
    expect(inspectFraming(0.01, 0.01)).toBeNull();
  });
});

describe('inspectAll 汇总并过滤空项', () => {
  it('合并四项、保持顺序', () => {
    const out = inspectAll({
      natW: 200,
      natH: 300,
      pxW: 295,
      pxH: 413,
      meanL: 240,
      edgeStd: 40,
      xOff: 0.2,
      tiltOff: 0.01,
    });
    expect(out.map((o) => o.code)).toEqual(['resolution', 'overexposed', 'background', 'framing']);
  });
});

// ---------- 指标提取纯函数（用合成像素数据） ----------

function solid(w: number, h: number, lum: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lum;
    d[i + 1] = lum;
    d[i + 2] = lum;
    d[i + 3] = 255;
  }
  return d;
}

describe('meanLuminance', () => {
  it('纯白 = 255', () => {
    expect(meanLuminance(solid(8, 8, 255))).toBeCloseTo(255, 0);
  });
  it('纯黑 = 0', () => {
    expect(meanLuminance(solid(8, 8, 0))).toBeCloseTo(0, 0);
  });
});

describe('edgeColorStd', () => {
  it('纯色边 std≈0', () => {
    expect(edgeColorStd(solid(16, 16, 100), 16, 16)).toBeCloseTo(0, 1);
  });
  it('上边亮、下边暗 → std 明显', () => {
    const d = solid(16, 16, 100);
    for (let x = 0; x < 16; x++) {
      for (let y = 0; y < 2; y++) {
        const i = (y * 16 + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = 240;
      }
      for (let y = 14; y < 16; y++) {
        const i = (y * 16 + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = 10;
      }
    }
    expect(edgeColorStd(d, 16, 16)).toBeGreaterThan(20);
  });
});

describe('framingMetrics', () => {
  it('居中蒙版 → 偏移近 0', () => {
    const w = 20;
    const h = 20;
    const a = new Uint8ClampedArray(w * h);
    for (let y = 4; y < 16; y++) for (let x = 6; x < 14; x++) a[y * w + x] = 255;
    const m = framingMetrics(a, w, h);
    expect(Math.abs(m.xOff)).toBeLessThan(0.1);
    expect(Math.abs(m.tiltOff)).toBeLessThan(0.1);
  });
  it('蒙版偏右 → xOff 明显为正', () => {
    const w = 20;
    const h = 20;
    const a = new Uint8ClampedArray(w * h);
    for (let y = 4; y < 16; y++) for (let x = 13; x < 19; x++) a[y * w + x] = 255;
    expect(framingMetrics(a, w, h).xOff).toBeGreaterThan(0.1);
  });
});

describe('ISSUE_LABEL 覆盖全部 code', () => {
  it('标签齐全', () => {
    for (const c of ['resolution', 'overexposed', 'underexposed', 'background', 'framing', 'angle']) {
      expect(ISSUE_LABEL[c]).toBeTruthy();
    }
  });
});
