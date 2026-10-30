/** PDF 格子页导出测试（node 环境 + jsPDF 桩，无浏览器依赖）
 *  覆盖：writeGridPages 共享实现、exportSheetPdf / exportGridPdf /
 *  exportPagesPdf 的页面结构、裁切线坐标、图像参数与 JPEG→PNG 回退。 */
import { describe, expect, it } from 'vitest';
import {
  cellRects,
  type CanvasLike,
} from './cardLayout';
import {
  exportGridPdf,
  type GridPdfOpts,
} from './gridExport';
import {
  exportPagesPdf,
  exportSheetPdf,
  writeGridPages,
  type PdfDocLike,
} from './sheetPdf';

/* ---------- 桩：jsPDF ---------- */

function makeDocStub(failJpeg = false) {
  const calls = {
    addPage: [] as unknown[][],
    rect: [] as number[][],
    addImage: [] as unknown[][],
    setDrawColor: [] as number[][],
    setLineWidth: [] as number[][],
    save: [] as unknown[][],
  };
  const doc: PdfDocLike = {
    addPage: (...a) => calls.addPage.push(a),
    rect: (...a) => calls.rect.push(a),
    addImage: (...a) => {
      if (failJpeg && a[1] === 'JPEG') throw new Error('jpeg unsupported');
      calls.addImage.push(a);
    },
    setDrawColor: (...a) => calls.setDrawColor.push(a),
    setLineWidth: (...a) => calls.setLineWidth.push(a),
    save: (...a) => calls.save.push(a),
  };
  return { doc, calls };
}

function stubCanvas(id: string): CanvasLike {
  return { id } as unknown as CanvasLike;
}

/* ---------- writeGridPages：格子页写入（共享实现） ---------- */

describe('writeGridPages', () => {
  const paper = { id: 'a4', name: 'A4', w: 210, h: 297 };
  const layout = { cols: 2, rows: 2, perSheet: 4 };

  it('cutLines=true：rect 坐标 = scale 1 的 cellRects（mm）', () => {
    const { doc, calls } = makeDocStub();
    writeGridPages(doc, {
      paper,
      layout,
      itemW: 50,
      itemH: 70,
      margin: 10,
      gap: 5,
      cutLines: true,
      pages: [[stubCanvas('a'), stubCanvas('b'), stubCanvas('c'), stubCanvas('d')]],
    });
    const rects = cellRects({ cols: 2, rows: 2, itemW: 50, itemH: 70, margin: 10, gap: 5, scale: 1 });
    expect(calls.rect).toHaveLength(4);
    calls.rect.forEach((args, i) => {
      expect(args).toEqual([rects[i].x, rects[i].y, rects[i].w, rects[i].h]);
    });
    expect(calls.rect[1]).toEqual([65, 10, 50, 70]); // 10 + 1*(50+5)
    expect(calls.rect[2]).toEqual([10, 85, 50, 70]); // 10 + 1*(70+5)
    expect(calls.setDrawColor).toEqual([[190], [190], [190], [190]]);
    expect(calls.setLineWidth).toEqual([[0.1], [0.1], [0.1], [0.1]]);
  });

  it('cutLines=false：不画裁切线', () => {
    const { doc, calls } = makeDocStub();
    writeGridPages(doc, {
      paper, layout, itemW: 50, itemH: 70, margin: 10, gap: 5, cutLines: false,
      pages: [[stubCanvas('a')]],
    });
    expect(calls.rect).toEqual([]);
    expect(calls.setDrawColor).toEqual([]);
  });

  it('addImage：JPEG + FAST，参数 = 格子矩形', () => {
    const { doc, calls } = makeDocStub();
    const cells = [stubCanvas('a'), stubCanvas('b'), stubCanvas('c'), stubCanvas('d')];
    writeGridPages(doc, {
      paper, layout, itemW: 50, itemH: 70, margin: 10, gap: 5, cutLines: false, pages: [cells],
    });
    expect(calls.addImage).toHaveLength(4);
    expect(calls.addImage[0]).toEqual([cells[0], 'JPEG', 10, 10, 50, 70, undefined, 'FAST']);
    expect(calls.addImage[3]).toEqual([cells[3], 'JPEG', 65, 85, 50, 70, undefined, 'FAST']);
  });

  it('JPEG 失败 → 抛出而非静默回退 PNG（A16：体积不再失控）', () => {
    const { doc, calls } = makeDocStub(true);
    let threw = false;
    try {
      writeGridPages(doc, {
        paper, layout: { cols: 1, rows: 1, perSheet: 1 }, itemW: 50, itemH: 70,
        margin: 10, gap: 5, cutLines: false, pages: [[stubCanvas('a')]],
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // 关键：不得出现 PNG 写入（否则体积炸弹回来了）
    expect(calls.addImage.some((a) => a[1] === 'PNG')).toBe(false);
  });

  it('cells 少于格子：只写有的', () => {
    const { doc, calls } = makeDocStub();
    writeGridPages(doc, {
      paper, layout, itemW: 50, itemH: 70, margin: 10, gap: 5, cutLines: true,
      pages: [[stubCanvas('a'), stubCanvas('b')]],
    });
    expect(calls.rect).toHaveLength(4); // 裁切线仍按格子画
    expect(calls.addImage).toHaveLength(2);
  });

  it('多页：从第二页起 addPage，竖纸 orient p / 横纸 l', () => {
    const { doc, calls } = makeDocStub();
    writeGridPages(doc, {
      paper, layout: { cols: 1, rows: 1, perSheet: 1 }, itemW: 50, itemH: 70,
      margin: 0, gap: 0, cutLines: false,
      pages: [[stubCanvas('a')], [stubCanvas('b')]],
    });
    expect(calls.addPage).toEqual([[[210, 297], 'p']]);

    const land = makeDocStub();
    writeGridPages(land.doc, {
      paper: { id: 'a4l', name: 'A4 横', w: 297, h: 210 },
      layout: { cols: 1, rows: 1, perSheet: 1 }, itemW: 50, itemH: 70,
      margin: 0, gap: 0, cutLines: false,
      pages: [[stubCanvas('a')], [stubCanvas('b')], [stubCanvas('c')]],
    });
    expect(land.calls.addPage).toEqual([[[297, 210], 'l'], [[297, 210], 'l']]);
  });
});

/* ---------- exportSheetPdf：单页导出 ---------- */

describe('exportSheetPdf', () => {
  const paper = { id: 'a4', name: 'A4', w: 210, h: 297 };
  const base = {
    paper, layout: { cols: 2, rows: 2, perSheet: 4 },
    itemW: 50, itemH: 70, margin: 10, gap: 5, cutLines: true,
    sheets: [stubCanvas('a'), stubCanvas('b'), stubCanvas('c'), stubCanvas('d')],
  };

  it('doc 工厂按纸张尺寸创建；默认文件名 证卡拼版.pdf', () => {
    const { doc, calls } = makeDocStub();
    const made: [number, number][] = [];
    exportSheetPdf(base, (w, h) => {
      made.push([w, h]);
      return doc;
    });
    expect(made).toEqual([[210, 297]]);
    expect(calls.save).toEqual([['证卡拼版.pdf']]);
    expect(calls.addImage).toHaveLength(4);
  });

  it('自定义 fileName 透传', () => {
    const { doc, calls } = makeDocStub();
    exportSheetPdf({ ...base, fileName: '证件照_A4_1寸.pdf' }, () => doc);
    expect(calls.save).toEqual([['证件照_A4_1寸.pdf']]);
  });

  // 方案 C：桌面端要拿字节交给主进程原子写盘，此时绝不能再调 save 触发一次下载
  it('doc 提供 output → 返回字节且不调 save；无 output → 返回 null 并下载', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const { doc, calls } = makeDocStub();
    const withOutput: PdfDocLike = {
      ...doc,
      output: ((t: string) => (t === 'arraybuffer' ? payload.buffer : null)) as PdfDocLike['output'],
    };
    expect(exportSheetPdf(base, () => withOutput)).toBeInstanceOf(Uint8Array);
    expect(calls.save).toEqual([]);

    const plain = makeDocStub();
    expect(exportSheetPdf(base, () => plain.doc)).toBeNull();
    expect(plain.calls.save).toEqual([['证卡拼版.pdf']]);
  });
});

/* ---------- exportGridPdf：多页网格导出 ---------- */

describe('exportGridPdf', () => {
  const opts: GridPdfOpts = {
    paper: { id: 'a4', name: 'A4', w: 210, h: 297 },
    layout: { cols: 2, rows: 1, perSheet: 2 },
    itemW: 50, itemH: 70, margin: 10, gap: 5, cutLines: true,
    pages: [[stubCanvas('a'), stubCanvas('b')], [stubCanvas('c'), stubCanvas('d')]],
  };

  it('默认文件名 拼版.pdf；addPage 一次；addImage 总数 = 页×格', () => {
    const { doc, calls } = makeDocStub();
    const made: [number, number][] = [];
    exportGridPdf(opts, (w, h) => {
      made.push([w, h]);
      return doc;
    });
    expect(made).toEqual([[210, 297]]);
    expect(calls.addPage).toHaveLength(1);
    expect(calls.addImage).toHaveLength(4);
    expect(calls.rect).toHaveLength(4); // 每页 2 格 × 2 页
    expect(calls.save).toEqual([['拼版.pdf']]);
  });

  // 方案 C：有 output 时返回字节交给主进程写盘，且不重复触发下载
  it('doc 提供 output → 返回字节且不调 save；无 output → 返回 null 并下载', () => {
    const payload = new Uint8Array([9, 9, 9]);
    const { doc, calls } = makeDocStub();
    const withOutput: PdfDocLike = {
      ...doc,
      output: ((t: string) => (t === 'arraybuffer' ? payload.buffer : null)) as PdfDocLike['output'],
    };
    const out = exportGridPdf(opts, () => withOutput);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out as Uint8Array)).toEqual([9, 9, 9]);
    expect(calls.save).toEqual([]);

    const plain = makeDocStub();
    expect(exportGridPdf(opts, () => plain.doc)).toBeNull();
    expect(plain.calls.save).toEqual([['拼版.pdf']]);
  });
});

/* ---------- exportPagesPdf：整页逐页导出 ---------- */

describe('exportPagesPdf', () => {
  it('0 页：不创建 doc、不 save', () => {
    const { doc, calls } = makeDocStub();
    exportPagesPdf(210, 297, [], 'x.pdf', () => doc);
    expect(calls.save).toEqual([]);
  });

  /* ---------- 方案 C：有 output 时返回字节，且不重复触发下载 ---------- */

  it('doc 提供 output → 返回字节，且不调 save（避免既写盘又下载两份）', () => {
    const { doc, calls } = makeDocStub();
    const payload = new Uint8Array([37, 80, 68, 70]); // %PDF
    const docWithOutput: PdfDocLike = {
      ...doc,
      output: ((t: string) => (t === 'arraybuffer' ? payload.buffer : null)) as PdfDocLike['output'],
    };
    const out = exportPagesPdf(210, 297, [stubCanvas('p0')], 'x.pdf', () => docWithOutput);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out as Uint8Array)).toEqual([37, 80, 68, 70]);
    expect(calls.save).toEqual([]);
  });

  it('doc 无 output（纯桩）→ 返回 null 并走原来的下载行为', () => {
    const { doc, calls } = makeDocStub();
    const out = exportPagesPdf(210, 297, [stubCanvas('p0')], 'x.pdf', () => doc);
    expect(out).toBeNull();
    expect(calls.save).toEqual([['x.pdf']]);
  });

  it('output 抛异常 → 退回下载，不把异常抛给调用方', () => {
    const { doc, calls } = makeDocStub();
    const broken: PdfDocLike = {
      ...doc,
      output: (() => {
        throw new Error('nope');
      }) as PdfDocLike['output'],
    };
    expect(() => exportPagesPdf(210, 297, [stubCanvas('p0')], 'x.pdf', () => broken)).not.toThrow();
    expect(calls.save).toEqual([['x.pdf']]);
  });

  it('N 页：addPage N-1 次、整页 addImage、save 自定义名', () => {
    const { doc, calls } = makeDocStub();
    const pages = [stubCanvas('p0'), stubCanvas('p1')];
    const made: [number, number][] = [];
    exportPagesPdf(210, 297, pages, '证卡拼版_A4_2页.pdf', (w, h) => {
      made.push([w, h]);
      return doc;
    });
    expect(made).toEqual([[210, 297]]);
    expect(calls.addPage).toEqual([[[210, 297], 'p']]);
    expect(calls.addImage).toHaveLength(2);
    expect(calls.addImage[0]).toEqual([pages[0], 'JPEG', 0, 0, 210, 297, undefined, 'FAST']);
    expect(calls.save).toEqual([['证卡拼版_A4_2页.pdf']]);
  });

  it('横页：orient l', () => {
    const { doc, calls } = makeDocStub();
    exportPagesPdf(297, 210, [stubCanvas('p0'), stubCanvas('p1')], 'x.pdf', () => doc);
    expect(calls.addPage).toEqual([[[297, 210], 'l']]);
  });
});
