import { describe, expect, it } from 'vitest';
import {
  defaultPrices,
  defaultSettings,
  detectFromName,
  priceRowOf,
  presetFromPriceRow,
  reclassify,
  duplexUnitOf,
} from './appSettings';

/* ===== 缝点：文件名自动识别 detectFromName()、点彩重归类 reclassify()、
   价格表→Preset 适配 priceRowOf()/presetFromPriceRow()/duplexUnitOf() ===== */

describe('detectFromName', () => {
  it('识别全角括号份数「(5份)」', () => {
    expect(detectFromName('报告(5份).pdf')).toEqual({ copies: 5 });
  });

  it('识别半角/方头括号份数', () => {
    expect(detectFromName('报告[3份].pdf').copies).toBe(3);
    expect(detectFromName('报告【2份】.pdf').copies).toBe(2);
  });

  it('无括号时识别「N份」', () => {
    expect(detectFromName('合同 4 份.pdf').copies).toBe(4);
  });

  it('识别 x3 / X3 / ×3 乘号份数', () => {
    expect(detectFromName('证件照x3.pdf').copies).toBe(3);
    expect(detectFromName('证件照X3.pdf').copies).toBe(3);
    expect(detectFromName('证件照×3.pdf').copies).toBe(3);
  });

  it('同时识别份数+双面+彩色', () => {
    expect(detectFromName('宣传单(5份)彩色双面.pdf')).toEqual({
      copies: 5,
      duplex: true,
      forceMode: 'color',
    });
  });

  it('「单面」显式覆盖', () => {
    expect(detectFromName('资料单面.pdf').duplex).toBe(false);
  });

  it('「黑白」强制黑白', () => {
    expect(detectFromName('试卷黑白.pdf').forceMode).toBe('bw');
  });

  it('无标记文件名返回空对象', () => {
    expect(detectFromName('普通文件.pdf')).toEqual({});
  });
});

describe('reclassify', () => {
  it('占比 0 → 黑白', () => {
    expect(reclassify(0, 5)).toBe('bw');
  });

  it('占比 0.04%（<0.05% 硬线）→ 黑白', () => {
    expect(reclassify(0.0004, 5)).toBe('bw');
  });

  it('占比 0.1%（阈值 5% 以下）→ 点彩', () => {
    expect(reclassify(0.001, 5)).toBe('dot');
  });

  it('占比 4.9%（阈值 5% 以下）→ 点彩', () => {
    expect(reclassify(0.049, 5)).toBe('dot');
  });

  it('占比 5%（达到阈值）→ 彩色', () => {
    expect(reclassify(0.05, 5)).toBe('color');
  });

  it('阈值改为 1% 时 0.8% 仍点彩、1.2% 即彩色', () => {
    expect(reclassify(0.008, 1)).toBe('dot');
    expect(reclassify(0.012, 1)).toBe('color');
  });
});

describe('priceRowOf', () => {
  const s = defaultSettings();

  it('按纸张名取行', () => {
    expect(priceRowOf(s, 'A3').bw1).toBe(1);
  });

  it('价格表没有的纸张回退到第一行（A4）', () => {
    expect(priceRowOf(s, 'A6').paper).toBe('A4');
  });
});

describe('presetFromPriceRow', () => {
  it('A4 行 → bw50/dot70/color100 分，双面系数 0.8', () => {
    const p = presetFromPriceRow(defaultPrices()[0]);
    expect(p.bwCents).toBe(50);
    expect(p.dotCents).toBe(70);
    expect(p.colorCents).toBe(100);
    expect(p.duplexFactor).toBe(0.8); // 0.4/0.5
    expect(p.ladderThreshold).toBe(0);
    expect(p.ladderCents).toBe(0);
  });

  it('A2 行双面价=单面价 → 系数 1', () => {
    const a2 = defaultPrices().find((r) => r.paper === 'A2')!;
    expect(presetFromPriceRow(a2).duplexFactor).toBe(1);
  });

  it('阶梯价透传（min→threshold，unit→cents）', () => {
    const p = presetFromPriceRow({
      paper: 'A4',
      bw1: 0.5,
      bw2: 0.4,
      dot1: 0.7,
      dot2: 0.6,
      color1: 1,
      color2: 0.8,
      ladder: { min: 100, unit: 0.3 },
    });
    expect(p.ladderThreshold).toBe(100);
    expect(p.ladderCents).toBe(30);
  });
});

describe('duplexUnitOf', () => {
  const a4 = defaultPrices()[0];

  it('黑白双面每面 0.4', () => {
    expect(duplexUnitOf(a4, 'bw')).toBe(0.4);
  });

  it('点彩双面每面 0.6', () => {
    expect(duplexUnitOf(a4, 'dot')).toBe(0.6);
  });

  it('彩色双面每面 0.8', () => {
    expect(duplexUnitOf(a4, 'color')).toBe(0.8);
  });
});
