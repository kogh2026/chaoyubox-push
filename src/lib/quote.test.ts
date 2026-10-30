import { describe, expect, it } from 'vitest';
import { quote, quoteDetail, quoteDetailTotal, sheetCount, formatCents, type FileRow, type Preset } from './quote';

/* ===== 缝点：报价引擎 quote()/sheetCount()/formatCents() =====
   预期值全部按 A4 默认价格表（黑白0.5/点彩0.7/彩色1.0 元每面，双面=单面×0.8）
   手工演算，不复制实现逻辑。 */

/** 由 defaultPrices 的 A4 行经 presetFromPriceRow 转出的 Preset（bw50/dot70/color100 分，双面系数0.8） */
const A4: Preset = {
  id: 0,
  name: 'A4',
  paper: 'A4',
  bwCents: 50,
  dotCents:70,
  colorCents: 100,
  duplexFactor: 0.8,
  ladderTiers: [],
  markupPercent: 0,
};

function row(patch: Partial<FileRow>): FileRow {
  return {
    name: 'test.pdf',
    pages: 3,
    paper: 'A4',
    perPage: [
      { page: 1, mode: 'bw', colorRatio: 0 },
      { page: 2, mode: 'bw', colorRatio: 0 },
      { page: 3, mode: 'color', colorRatio: 0.5 },
    ],
    thumbs: [],
    copies: 1,
    duplex: false,
    ...patch,
  };
}

describe('quote', () => {
  it('单面：2 页黑白 + 1 页彩色 = 0.5+0.5+1.0 = ¥2.00', () => {
    const q = quote([row({})], A4);
    expect(q.totalCents).toBe(200);
    expect(formatCents(q.totalCents)).toBe('¥2.00');
    expect(q.totalPages).toBe(3); // 计价面数（×份数）
    expect(q.lines[0]).toMatchObject({ bwPages: 2, colorPages: 1, dotPages: 0, faces: 3, copies: 1 });
  });

  it('双面：每面按 0.8 系数 → 0.4+0.4+0.8 = ¥1.60', () => {
    const q = quote([row({ duplex: true })], A4);
    expect(q.totalCents).toBe(160);
  });

  it('不打印的页不计面数、不计价', () => {
    const q = quote(
      [
        row({
          perPage: [
            { page: 1, mode: 'bw', colorRatio: 0 },
            { page: 2, mode: 'none', colorRatio: 0 },
            { page: 3, mode: 'color', colorRatio: 0.5 },
          ],
        }),
      ],
      A4,
    );
    expect(q.totalPages).toBe(2);
    expect(q.totalCents).toBe(150); // 0.5 + 1.0
    expect(q.lines[0].faces).toBe(2);
  });

  it('份数翻倍则金额与面数翻倍', () => {
    const q = quote([row({ copies: 3 })], A4);
    expect(q.totalCents).toBe(600);
    expect(q.totalPages).toBe(9);
    expect(q.lines[0].copies).toBe(3);
  });

  it('整篇覆盖颜色：3 页全按彩色 1.0 → ¥3.00', () => {
    const q = quote([row({ modeOverride: 'color' })], A4);
    expect(q.totalCents).toBe(300);
    expect(q.lines[0].colorPages).toBe(3);
  });

  it('阶梯价：满 5 面后每面封顶 0.3 元（单档）', () => {
    const ladder: Preset = { ...A4, ladderTiers: [{ minFaces: 5, unitCents: 30 }] };
    // 6 面全黑白：无阶梯 6×0.5=3.0；有阶梯 min(0.5,0.3)×6=1.8
    const many = row({
      pages: 6,
      perPage: Array.from({ length: 6 }, (_, i) => ({ page: i + 1, mode: 'bw' as const, colorRatio: 0 })),
    });
    expect(quote([many], ladder).totalCents).toBe(180);
    expect(quote([many], A4).totalCents).toBe(300); // 无阶梯对照
  });

  it('多档阶梯价：越印越便宜，取命中档位中 minFaces 最大的一档', () => {
    // A4：满100面每面封顶0.4、满500面封顶0.3
    const ladder: Preset = {
      ...A4,
      ladderTiers: [
        { minFaces: 100, unitCents: 40 },
        { minFaces: 500, unitCents: 30 },
      ],
    };
    const mk = (n: number) =>
      row({
        pages: n,
        perPage: Array.from({ length: n }, (_, i) => ({ page: i + 1, mode: 'bw' as const, colorRatio: 0 })),
      });
    // 200 面：命中 100 档 → 0.4；200×0.4=80.00
    expect(quote([mk(200)], ladder).totalCents).toBe(8000);
    // 600 面：命中 500 档 → 0.3；600×0.3=180.00
    expect(quote([mk(600)], ladder).totalCents).toBe(18000);
    // 50 面：未达任何档 → 基础 0.5；50×0.5=25.00
    expect(quote([mk(50)], ladder).totalCents).toBe(2500);
  });

  it('阶梯价未达门槛不启用', () => {
    const ladder: Preset = { ...A4, ladderTiers: [{ minFaces: 10, unitCents: 30 }] };
    expect(quote([row({})], ladder).totalCents).toBe(200);
  });

  it('阶梯价对彩色同样封顶（基础1.0 → 命中档0.3）', () => {
    const ladder: Preset = { ...A4, ladderTiers: [{ minFaces: 5, unitCents: 30 }] };
    const many = row({
      pages: 6,
      perPage: Array.from({ length: 6 }, (_, i) => ({ page: i + 1, mode: 'color' as const, colorRatio: 0.5 })),
    });
    // 6×min(1.0,0.3)=1.8
    expect(quote([many], ladder).totalCents).toBe(180);
  });

  it('全局加价百分比：基础单价 ×(1+markup%)（先阶梯/双面后加价）', () => {
    // 单面：黑白0.5×2 + 彩色1.0，基础合计 2.0 → 加价 10% → 2.2
    const marked: Preset = { ...A4, markupPercent: 10 };
    expect(quote([row({})], marked).totalCents).toBe(220);
    // 双面：基础0.5→×0.8=0.4，彩色1.0→×0.8=0.8；合计 (0.4×2+0.8)=1.6 → 加价10% → 1.76
    expect(quote([row({ duplex: true })], marked).totalCents).toBe(176);
  });

  it('多文件按各自 preset 分别计价', () => {
    const a4 = row({ name: 'a.pdf' });
    const a3 = row({ name: 'b.pdf', paper: 'A3' });
    const presetOf = (r: FileRow) => (r.paper === 'A3' ? { ...A4, paper: 'A3', bwCents: 100, colorCents: 200 } : A4);
    const q = quote([a4, a3], presetOf);
    expect(q.lines[0].lineCents).toBe(200); // a.pdf A4
    expect(q.lines[1].lineCents).toBe(400); // b.pdf A3：1.0+1.0+2.0
    expect(q.totalCents).toBe(600);
  });
});

describe('sheetCount', () => {
  const fiveBw = row({
    pages: 5,
    perPage: Array.from({ length: 5 }, (_, i) => ({ page: i + 1, mode: 'bw' as const, colorRatio: 0 })),
  });

  it('单面 5 面 = 5 张纸', () => {
    expect(sheetCount([fiveBw])).toEqual({ A4: 5 });
  });

  it('双面 5 面 = 3 张纸（ceil(5/2)）', () => {
    expect(sheetCount([row({ ...fiveBw, duplex: true })])).toEqual({ A4: 3 });
  });

  it('双面偶数面不浪费：4 面 = 2 张', () => {
    const four = row({
      pages: 4,
      perPage: Array.from({ length: 4 }, (_, i) => ({ page: i + 1, mode: 'bw' as const, colorRatio: 0 })),
      duplex: true,
    });
    expect(sheetCount([four])).toEqual({ A4: 2 });
  });

  it('排除的页不占纸', () => {
    const withNone = row({
      pages: 5,
      perPage: [
        { page: 1, mode: 'bw', colorRatio: 0 },
        { page: 2, mode: 'none', colorRatio: 0 },
        { page: 3, mode: 'bw', colorRatio: 0 },
        { page: 4, mode: 'bw', colorRatio: 0 },
        { page: 5, mode: 'bw', colorRatio: 0 },
      ],
      duplex: true,
    });
    expect(sheetCount([withNone])).toEqual({ A4: 2 }); // 4 面 ÷ 2
  });

  it('份数计入用纸', () => {
    expect(sheetCount([row({ ...fiveBw, copies: 2 })])).toEqual({ A4: 10 });
  });

  it('双面奇数面 × 多份：每一份从新的一张纸开始（3面×2份 = 4张，不是3张）', () => {
    const three = row({
      pages: 3,
      perPage: Array.from({ length: 3 }, (_, i) => ({ page: i + 1, mode: 'bw' as const, colorRatio: 0 })),
      duplex: true,
      copies: 2,
    });
    expect(sheetCount([three])).toEqual({ A4: 4 });
  });

  it('不同纸张分别归并', () => {
    expect(sheetCount([fiveBw, row({ ...fiveBw, paper: 'A3' })])).toEqual({ A4: 5, A3: 5 });
  });
});

describe('formatCents', () => {
  it('分转元保留两位', () => {
    expect(formatCents(200)).toBe('¥2.00');
    expect(formatCents(1)).toBe('¥0.01');
    expect(formatCents(0)).toBe('¥0.00');
    expect(formatCents(12345)).toBe('¥123.45');
  });
});

describe('quoteDetail（报价分项明细）', () => {
  it('按 纸张+颜色+单双面 聚合：2黑白+1彩色 → 两行，小计=面数×单价', () => {
    const rows = [row({})]; // 2 bw + 1 color 单面 A4
    const detail = quoteDetail(rows, A4);
    expect(detail).toHaveLength(2);
    expect(detail[0]).toMatchObject({ label: 'A4 黑白单面', faces: 2, unitCents: 50, subtotalCents: 100 });
    expect(detail[1]).toMatchObject({ label: 'A4 彩色单面', faces: 1, unitCents: 100, subtotalCents: 100 });
    // 一致性兜底：分项小计之和 === quote 总价（单张/批量同引擎）
    expect(quoteDetailTotal(detail)).toBe(quote(rows, A4).totalCents);
  });

  it('双面按双面价单独成组，单价 = 单面×0.8', () => {
    const detail = quoteDetail([row({ duplex: true })], A4);
    expect(detail).toHaveLength(2);
    expect(detail[0]).toMatchObject({ label: 'A4 黑白双面', unitCents: 40 }); // 50×0.8
    expect(detail[1]).toMatchObject({ label: 'A4 彩色双面', unitCents: 80 }); // 100×0.8
  });

  it('份数计入面数：2黑白+1彩色 ×3份 → 黑白6面、彩色3面', () => {
    const detail = quoteDetail([row({ copies: 3 })], A4);
    expect(detail[0]).toMatchObject({ label: 'A4 黑白单面', faces: 6, subtotalCents: 300 });
    expect(detail[1]).toMatchObject({ label: 'A4 彩色单面', faces: 3, subtotalCents: 300 });
  });

  it('「不打印」页不计入明细', () => {
    const rows = [
      row({
        perPage: [
          { page: 1, mode: 'bw', colorRatio: 0 },
          { page: 2, mode: 'none', colorRatio: 0 },
        ],
      }),
    ];
    const detail = quoteDetail(rows, A4);
    expect(detail).toHaveLength(1);
    expect(detail[0].faces).toBe(1);
  });

  it('同纸张同颜色但单价不同（阶梯价达标与否）不并组', () => {
    const ladder: Preset = { ...A4, ladderTiers: [{ minFaces: 5, unitCents: 30 }] };
    const sixBw = row({
      name: 'a.pdf',
      pages: 6,
      perPage: Array.from({ length: 6 }, (_, i) => ({ page: i + 1, mode: 'bw' as const, colorRatio: 0 })),
    });
    const presetOf = (r: FileRow) => (r.name === 'a.pdf' ? ladder : A4);
    const detail = quoteDetail([sixBw, row({ ...sixBw, name: 'b.pdf' })], presetOf);
    // a.pdf 达标 → 单价 0.30；b.pdf 未达标 → 0.50；两行各自 小计=面数×单价
    const units = detail.map((d) => d.unitCents).sort((x, y) => x - y);
    expect(units).toEqual([30, 50]);
    expect(detail.every((d) => d.subtotalCents === d.faces * d.unitCents)).toBe(true);
    expect(quoteDetailTotal(detail)).toBe(quote([sixBw, row({ ...sixBw, name: 'b.pdf' })], presetOf).totalCents);
  });

  it('多文件多模式：分项之和恒等于 quote 总价（批量与逐张计价一致性）', () => {
    const rows = [row({ name: 'a.pdf' }), row({ name: 'b.pdf', duplex: true, copies: 2 }), row({ name: 'c.pdf', paper: 'A3' })];
    const presetOf = (r: FileRow) => (r.paper === 'A3' ? { ...A4, paper: 'A3', bwCents: 100, colorCents: 200 } : A4);
    const detail = quoteDetail(rows, presetOf);
    expect(detail.every((d) => d.subtotalCents === d.faces * d.unitCents)).toBe(true);
    expect(quoteDetailTotal(detail)).toBe(quote(rows, presetOf).totalCents);
    // 排序稳定：同纸张内 黑白→点彩→彩色，单面在前
    const labels = detail.map((d) => d.label);
    expect(labels.indexOf('A4 黑白单面')).toBeLessThan(labels.indexOf('A4 彩色单面'));
    expect(labels.indexOf('A4 黑白单面')).toBeLessThan(labels.indexOf('A4 黑白双面'));
  });

  it('整篇覆盖颜色后按覆盖后模式聚合', () => {
    const detail = quoteDetail([row({ modeOverride: 'color' })], A4);
    expect(detail).toHaveLength(1);
    expect(detail[0]).toMatchObject({ label: 'A4 彩色单面', faces: 3, unitCents: 100, subtotalCents: 300 });
  });
});
