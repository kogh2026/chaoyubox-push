import { describe, expect, it } from 'vitest';
import { quote, sheetCount, formatCents, type FileRow, type Preset } from './quote';

/* ===== 缝点：报价引擎 quote()/sheetCount()/formatCents() =====
   预期值全部按 A4 默认价格表（黑白0.5/点彩0.7/彩色1.0 元每面，双面=单面×0.8）
   手工演算，不复制实现逻辑。 */

/** 由 defaultPrices 的 A4 行经 presetFromPriceRow 转出的 Preset（bw50/dot70/color100 分，双面系数0.8） */
const A4: Preset = {
  id: 0,
  name: 'A4',
  paper: 'A4',
  bwCents: 50,
  dotCents: 70,
  colorCents: 100,
  duplexFactor: 0.8,
  ladderThreshold: 0,
  ladderCents: 0,
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

  it('阶梯价：满 5 面后每面封顶 0.3 元', () => {
    const ladder: Preset = { ...A4, ladderThreshold: 5, ladderCents: 30 };
    // 6 面全黑白：无阶梯 6×0.5=3.0；有阶梯 min(0.5,0.3)×6=1.8
    const many = row({
      pages: 6,
      perPage: Array.from({ length: 6 }, (_, i) => ({ page: i + 1, mode: 'bw' as const, colorRatio: 0 })),
    });
    expect(quote([many], ladder).totalCents).toBe(180);
    expect(quote([many], A4).totalCents).toBe(300); // 无阶梯对照
  });

  it('阶梯价未达门槛不启用', () => {
    const ladder: Preset = { ...A4, ladderThreshold: 10, ladderCents: 30 };
    expect(quote([row({})], ladder).totalCents).toBe(200);
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
