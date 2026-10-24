import { describe, expect, it } from 'vitest';
import { classify, classifyPaper, colorRatioOf, redRatioOf } from './pdfAnalyze';

/* ===== 缝点：页面颜色判定 classify() 与纸张尺寸识别 classifyPaper() =====
   彩色/红章占比函数吃 ImageData 结构（{data, width, height}），
   用合成数据喂，预期值手工推算。 */

/** 合成 ImageData：每像素同一颜色 */
function solid(w: number, h: number, r: number, g: number, b: number) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h } as unknown as ImageData;
}

describe('classify', () => {
  it('占比 0 → 黑白', () => {
    expect(classify(0)).toBe('bw');
  });

  it('占比 0.1%（低于 0.5% 阈值）→ 黑白', () => {
    expect(classify(0.001)).toBe('bw');
  });

  it('占比 1%（0.5%~2% 之间）→ 点彩', () => {
    expect(classify(0.01)).toBe('dot');
  });

  it('占比 5%（≥2%）→ 彩色', () => {
    expect(classify(0.05)).toBe('color');
  });
});

describe('classifyPaper', () => {
  it('A4 竖版 595.28×841.89pt', () => {
    expect(classifyPaper(595.28, 841.89)).toBe('A4');
  });

  it('A4 横版（旋转 90°）同样识别', () => {
    expect(classifyPaper(841.89, 595.28)).toBe('A4');
  });

  it('A3 1190.55×841.89pt', () => {
    expect(classifyPaper(1190.55, 841.89)).toBe('A3');
  });

  it('A5 419.53×595.28pt', () => {
    expect(classifyPaper(419.53, 595.28)).toBe('A5');
  });

  it('Letter 612×792pt', () => {
    expect(classifyPaper(612, 792)).toBe('Letter');
  });

  it('B5 498.9×708.7pt', () => {
    expect(classifyPaper(498.9, 708.7)).toBe('B5');
  });

  it('A0 2383.9×3370.4pt', () => {
    expect(classifyPaper(2383.9, 3370.4)).toBe('A0');
  });

  it('非常规尺寸返回空串', () => {
    expect(classifyPaper(600, 900)).toBe('');
    expect(classifyPaper(100, 100)).toBe('');
  });

  it('略超公差（>3%）不误判', () => {
    // A4 短边放大 5%：625×884 → 超出 3% 容差
    expect(classifyPaper(625, 884)).toBe('');
  });
});

describe('colorRatioOf', () => {
  it('纯灰图（R=G=B）→ 0', () => {
    expect(colorRatioOf(solid(50, 50, 128, 128, 128))).toBe(0);
  });

  it('纯黑白图 → 0', () => {
    expect(colorRatioOf(solid(50, 50, 0, 0, 0))).toBe(0);
    expect(colorRatioOf(solid(50, 50, 255, 255, 255))).toBe(0);
  });

  it('饱和红图（255,0,0）→ 1', () => {
    expect(colorRatioOf(solid(50, 50, 255, 0, 0))).toBe(1);
  });

  it('低饱和差（R-G=30，低于 40 判据）→ 0', () => {
    expect(colorRatioOf(solid(50, 50, 100, 75, 75))).toBe(0);
  });

  it('暗彩色（max≤30）不计', () => {
    expect(colorRatioOf(solid(50, 50, 10, 0, 0))).toBe(0);
  });

  it('一半灰一半红 → 约 0.5', () => {
    const w = 50;
    const h = 50;
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const colored = i % 2 === 0; // 棋盘格：一半彩色一半灰
      data[i * 4] = colored ? 255 : 128;
      data[i * 4 + 1] = colored ? 0 : 128;
      data[i * 4 + 2] = colored ? 0 : 128;
      data[i * 4 + 3] = 255;
    }
    const ratio = colorRatioOf({ data, width: w, height: h } as unknown as ImageData);
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.55);
  });
});

describe('redRatioOf', () => {
  it('纯红图 → 1', () => {
    expect(redRatioOf(solid(50, 50, 255, 0, 0))).toBe(1);
  });

  it('纯蓝/纯绿/灰 → 0', () => {
    expect(redRatioOf(solid(50, 50, 0, 0, 255))).toBe(0);
    expect(redRatioOf(solid(50, 50, 0, 255, 0))).toBe(0);
    expect(redRatioOf(solid(50, 50, 128, 128, 128))).toBe(0);
  });

  it('暗红（R=100 不满足 R>110）→ 0', () => {
    expect(redRatioOf(solid(50, 50, 100, 0, 0))).toBe(0);
  });

  it('粉红（R-G=40 不满足 >45）→ 0', () => {
    expect(redRatioOf(solid(50, 50, 200, 160, 160))).toBe(0);
  });
});
