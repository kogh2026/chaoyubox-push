import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHEET_LAYOUT,
  CAPTION_FONT_MM,
  checkSheets,
  computeGrid,
  autoGrid,
  captionFor,
  detectBlankRows,
  ellipsizeMiddle,
  fillGrid,
  layoutSheets,
  median,
  normalizeGridSpec,
  normalizeLayout,
  paginateFill,
  paginateNormal,
  resolvePaper,
  sizeLabel,
  splitLongParts,
  type SheetResult,
  type SheetSource,
} from './photoSheet';

/** A4 竖版、无页码时的可用区：190 × 277 */
const METRICS = {
  captionMm: 6.8,
  contentWidthMm: 190,
  contentHeightMm: 277,
  gapXMm: 5,
  gapYMm: 5,
};

function src(id: string, ratio = 4 / 3, extra: Partial<SheetSource> = {}): SheetSource {
  const width = 1200;
  return { height: Math.round(width * ratio), id, name: `${id}.jpg`, width, ...extra };
}

describe('纸张与网格', () => {
  it('A4 竖版 210×297，横版 297×210', () => {
    expect(resolvePaper('a4', 'portrait')).toEqual({ heightMm: 297, widthMm: 210 });
    expect(resolvePaper('a4', 'landscape')).toEqual({ heightMm: 210, widthMm: 297 });
    expect(resolvePaper('a3', 'portrait')).toEqual({ heightMm: 420, widthMm: 297 });
  });

  it('2×2 单元格：扣掉边距与间距后均分', () => {
    const g = computeGrid(2, 2, METRICS);
    expect(g.cellWidthMm).toBeCloseTo(92.5, 5); // (190 - 5) / 2
    expect(g.cellHeightMm).toBeCloseTo(136, 5); // (277 - 5) / 2
    expect(g.imageHeightMm).toBeCloseTo(129.2, 5);
  });

  it('间距超过上限时被压回，格子不会被挤成负数', () => {
    const g = computeGrid(2, 2, { ...METRICS, gapXMm: 400 });
    // 上限 = (190 - 2×10) / 1 = 170
    expect(g.maxGapXMm).toBe(170);
    expect(g.gapXMm).toBe(170);
    expect(g.cellWidthMm).toBeCloseTo(10, 5);
    expect(g.cellWidthMm).toBeGreaterThan(0);
  });

  it('每页 6 张正方图 → 选 2×3（单图 82.2mm 比 3×2 的 60mm 大）', () => {
    const g = autoGrid(6, { ...METRICS, aspect: 1 });
    expect([g.cols, g.rows]).toEqual([2, 3]);
    expect(g.imageHeightMm).toBeCloseTo(82.2, 5);
  });

  it('显式行列只接受 1..6 的整数', () => {
    expect(normalizeGridSpec({ cols: 3, rows: 2 })).toEqual({ cols: 3, rows: 2 });
    expect(normalizeGridSpec({ cols: 7, rows: 2 })).toBeNull();
    expect(normalizeGridSpec({ cols: 0, rows: 2 })).toBeNull();
    expect(normalizeGridSpec({ cols: 2.5, rows: 2 })).toBeNull();
    expect(normalizeGridSpec(null)).toBeNull();
  });

  it('中位数不受单张超长图影响', () => {
    expect(median([1, 1.5, 1.4, 30])).toBe(1.45);
    expect(median([])).toBeNull();
  });
});

describe('长图切分', () => {
  it('空白行检测：与行内基准色差异过大的像素够多才算「有内容」', () => {
    const width = 10;
    const height = 3;
    const data = new Uint8ClampedArray(width * height * 4).fill(200);
    // 第 1 行两个像素变为黑：差异像素 2 > 上限 1（宽度 10 × 0.004 向下取 1）
    data[1 * width * 4 + 0] = 0;
    data[1 * width * 4 + 4] = 0;
    const flags = detectBlankRows(data, width, height, 14, 0.004);
    expect(Array.from(flags)).toEqual([1, 0, 1]);
  });

  it('长图在空白间隙处切段，各段首尾相接且总高不变', () => {
    const width = 400;
    const height = 1200;
    // 上下各 100px 是内容（聊天记录的首尾），中间全空白：切点应落在空白带正中
    const flags = new Uint8Array(height).fill(1);
    for (let y = 0; y < 100; y += 1) flags[y] = 0;
    for (let y = 1100; y < height; y += 1) flags[y] = 0;
    const parts = splitLongParts({ blankRows: flags, height, width }, 1.5, true);
    expect(parts).toHaveLength(2);
    expect(parts[0].sy).toBe(0);
    expect(parts[1].sy).toBe(parts[0].sh);
    expect(parts[0].sh + parts[1].sh).toBe(height);
    expect(parts[0].sh).toBe(600); // 目标块高 400×1.5 = 600
  });

  it('开关关掉、或不够长时整张不切', () => {
    const flags = new Uint8Array(400);
    for (let y = 100; y < 140; y += 1) flags[y] = 1;
    const tall = { blankRows: flags, height: 400, width: 400 };
    expect(splitLongParts(tall, 1.5, false)).toEqual([{ sh: 400, sy: 0 }]);
    const short = { blankRows: flags, height: 400, width: 400 };
    expect(splitLongParts(short, 1.2, true)).toEqual([{ sh: 400, sy: 0 }]);
  });
});

describe('常规分页', () => {
  it('统一单元格按中位比例算，图在框内水平居中', () => {
    const sources = [src('a'), src('b'), src('c')];
    const r = paginateNormal(sources, normalizeLayout({}), 0);
    expect(r.pages).toHaveLength(1);
    expect([r.grid.cols, r.grid.rows]).toEqual([2, 3]);
    const p = r.pages[0];
    expect(p.parts).toHaveLength(3);
    // 单元格宽 92.5，图宽 82.2/1.3333 = 61.65 → 左右各留 15.4mm
    expect(p.parts[0].widthMm).toBeCloseTo(61.65, 1);
    expect(p.parts[0].x).toBeCloseTo(10 + (92.5 - 61.65) / 2, 1);
    expect(p.parts[1].x).toBeCloseTo(10 + 92.5 + 5 + (92.5 - 61.65) / 2, 1);
    expect(p.parts[0].caption).toBe('图 1');
    expect(p.parts[2].caption).toBe('图 3');
  });

  it('内容整体垂直居中，可切到居上 / 居下', () => {
    const center = paginateNormal([src('a')], normalizeLayout({}), 0).pages[0];
    const top = paginateNormal([src('a')], normalizeLayout({ align: 'top' }), 0).pages[0];
    const bottom = paginateNormal([src('a')], normalizeLayout({ align: 'bottom' }), 0).pages[0];
    expect(top.parts[0].y).toBeCloseTo(10, 5);
    expect(center.parts[0].y).toBeGreaterThan(top.parts[0].y);
    expect(bottom.parts[0].y).toBeGreaterThan(center.parts[0].y);
  });

  it('显式行列优先于「每页个数」', () => {
    const r = paginateNormal(
      [src('a'), src('b'), src('c'), src('d')],
      normalizeLayout({ grid: { cols: 1, rows: 2 } }),
      0,
    );
    expect([r.grid.cols, r.grid.rows]).toEqual([1, 2]);
    expect(r.pages).toHaveLength(2);
  });

  it('图片超出一页时按行列切页，图号连续', () => {
    const sources = Array.from({ length: 8 }, (_, i) => src(`p${i}`));
    const r = paginateNormal(sources, normalizeLayout({ perPage: 4 }), 0);
    expect(r.pages).toHaveLength(2);
    expect(r.pages[1].parts[0].figure).toBe(5);
  });
});

describe('排满模式（贴纸 / 热转印）', () => {
  const base = { fillEnabled: true, fill: { ...DEFAULT_SHEET_LAYOUT.fill, count: 4 } };

  it('4 份正方形图 → 2×2，一页装完', () => {
    const layout = normalizeLayout(base);
    const r = paginateFill([src('a', 1, { copies: 4 })], layout, 0);
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0].parts).toHaveLength(4);
    expect([r.grid.cols, r.grid.rows]).toEqual([2, 2]);
    const xs = [...new Set(r.pages[0].parts.map((p) => Math.round(p.x * 100) / 100))].sort((a, b) => a - b);
    expect(xs).toEqual([10, 107.5]);
    expect(r.pages[0].parts[0].widthMm).toBeCloseTo(92.5, 5);
  });

  it('份数超过一页自动换页', () => {
    const r = paginateFill([src('a', 1, { copies: 8 })], normalizeLayout(base), 0);
    expect(r.pages).toHaveLength(2);
    expect(r.pages[1].parts).toHaveLength(4);
  });

  it('裁切线：竖线贯通纸顶到纸底，横线落在每一行的上下边', () => {
    const r = paginateFill([src('a', 1, { copies: 4 })], normalizeLayout(base), 0);
    const cut = r.pages[0].cutLines;
    expect(cut).not.toBeNull();
    expect(cut!.xs.some((l) => l.y1 === 0 && l.y2 === 297)).toBe(true);
    // 2 行 → 4 条横向边界
    expect(cut!.ys).toHaveLength(4);
  });

  it('关掉裁切线就不产生切线', () => {
    const layout = normalizeLayout({ ...base, fill: { ...base.fill, cutLines: false } });
    expect(paginateFill([src('a', 1, { copies: 4 })], layout, 0).pages[0].cutLines).toBeNull();
  });

  it('指定宽度放不下：标记 tooLarge 并缩到一页一个', () => {
    const layout = normalizeLayout({
      ...base,
      fill: { ...base.fill, count: 4, widthMm: 200 },
    });
    const g = fillGrid(1, layout, resolvePaper('a4', 'portrait'));
    expect(g.tooLarge).toBe(true);
    expect([g.cols, g.rows]).toEqual([1, 1]);
    expect(g.widthMm).toBeCloseTo(190, 5);
  });

  it('镜像与尺寸标注', () => {
    const layout = normalizeLayout({
      ...base,
      fill: { ...base.fill, count: 4, mirror: true, sizeLabel: true },
    });
    const r = paginateFill([src('a', 1, { copies: 4 })], layout, 0);
    expect(r.pages[0].parts[0].mirrored).toBe(true);
    expect(r.pages[0].parts[0].caption).toBe('9.3 × 9.3 cm');
  });
});

describe('分组与页码', () => {
  it('带 section 的图另起一组，各自独立分页', () => {
    const r = layoutSheets(
      [src('a'), src('b', 1, { section: { perPage: 1 } }), src('c')],
      { perPage: 4 },
    );
    expect(r.sections).toHaveLength(2);
    expect(r.sections[0].imageCount).toBe(1);
    expect(r.sections[1].imageCount).toBe(2);
    expect(r.sections[1].firstImage).toBe(1);
  });

  it('页码按合并后的总页数编号', () => {
    const sources = [
      src('a'),
      src('b', 1, { section: { perPage: 1 } }),
      src('c', 1, { section: { perPage: 1 } }),
    ];
    const r = layoutSheets(sources, { pageNumbers: true, perPage: 4 });
    expect(r.pages.length).toBe(3);
    expect(r.pages.map((p) => p.footer)).toEqual([
      '第 1 页 / 共 3 页',
      '第 2 页 / 共 3 页',
      '第 3 页 / 共 3 页',
    ]);
  });

  it('没有图时不出纸（与爱印一致：空排版 0 页，界面走空状态）', () => {
    const r = layoutSheets([], {});
    expect(r.pages).toHaveLength(0);
    expect(r.sections).toHaveLength(1);
  });
});

describe('文字', () => {
  it('中间省略保留首尾', () => {
    const out = ellipsizeMiddle('a-very-long-file-name-for-test.jpg', 20, CAPTION_FONT_MM);
    expect(out).toContain('…');
    expect(out.startsWith('a')).toBe(true);
    expect(out.endsWith('g')).toBe(true);
  });

  it('文件名模式去掉扩展名，分段图补「（1/3）」', () => {
    expect(captionFor({ figure: 1 }, 'filename', '照片.PNG')).toBe('照片');
    expect(captionFor({ figure: 1 }, 'none', '照片.PNG')).toBe('');
    expect(captionFor({ figure: 2, partCount: 3, partIndex: 1 }, 'order', 'x.jpg')).toBe('图 2（1 / 3）');
  });

  it('尺寸标注换算成厘米', () => {
    expect(sizeLabel(92.5, 129.2)).toBe('9.3 × 12.9 cm');
  });
});

describe('打印质检', () => {
  it('PPI 低于 120 报警，高于则安静', () => {
    const result: SheetResult = {
      fillTooLarge: false,
      grid: computeGrid(1, 1, METRICS),
      narrowestScreenshotMm: null,
      sections: [],
      pages: [
        {
          cutLines: null,
          footer: null,
          heightMm: 297,
          parts: [
            {
              caption: '',
              captionX: 30,
              captionY: 0,
              figure: 1,
              heightMm: 100,
              mirrored: false,
              partCount: 1,
              partIndex: 1,
              sh: 800,
              sourceId: 'small',
              sy: 0,
              widthMm: 92.5,
              x: 10,
              y: 10,
            },
          ],
          widthMm: 210,
        },
      ],
    };
    // 300px 印到 92.5mm（3.64 英寸）→ 82 ppi
    const issues = checkSheets(result, [{ height: 300, id: 'small', name: 's.jpg', width: 300 }]);
    expect(issues.map((i) => i.kind)).toContain('blurry');

    const good = checkSheets(result, [{ height: 1200, id: 'small', name: 's.jpg', width: 1200 }]);
    // 1200px / 3.64in = 330 ppi
    expect(good.filter((i) => i.kind === 'blurry')).toHaveLength(0);
  });

  it('距纸边 <5mm 报警', () => {
    const result: SheetResult = {
      fillTooLarge: false,
      grid: computeGrid(1, 1, METRICS),
      narrowestScreenshotMm: null,
      sections: [],
      pages: [
        {
          cutLines: null,
          footer: null,
          heightMm: 297,
          parts: [
            {
              caption: '',
              captionX: 100,
              captionY: 0,
              figure: 1,
              heightMm: 100,
              mirrored: false,
              partCount: 1,
              partIndex: 1,
              sh: 1000,
              sourceId: 'a',
              sy: 0,
              widthMm: 300,
              x: 2,
              y: 10,
            },
          ],
          widthMm: 210,
        },
      ],
    };
    const issues = checkSheets(result, [{ height: 1000, id: 'a', name: 'a.jpg', width: 1000 }]);
    expect(issues.some((i) => i.kind === 'edge')).toBe(true);
  });
});
