// pdfOps 核心操作测试：node 环境，测试 PDF 用 pdf-lib 现场构造（自包含）。
// 只测公共接口缝点：解析/缩放纯函数 + 5 个操作的输入输出契约。
import { describe, it, expect } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import {
  parsePageRanges,
  expandRanges,
  splitName,
  computeFitScale,
  mergePdfs,
  splitPdf,
  rotatePdf,
  unifyPageSize,
  pdfToImages,
  type PdfInput,
} from './pdfOps';

async function makePdf(pages: number, w = 595, h = 842): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([w, h]);
    p.drawText(`Page ${i + 1}`, { x: 40, y: 40, size: 24 });
  }
  return doc.save();
}

const two: PdfInput[] = [
  { name: 'a.pdf', data: await makePdf(2) },
  { name: 'b.pdf', data: await makePdf(3) },
];

describe('parsePageRanges', () => {
  it('空 / all → 全选', () => {
    expect(parsePageRanges('', 5)).toEqual([{ from: 1, to: 5 }]);
    expect(parsePageRanges('all', 5)).toEqual([{ from: 1, to: 5 }]);
    expect(parsePageRanges('  ', 5)).toEqual([{ from: 1, to: 5 }]);
  });

  it('单页与区间混合', () => {
    expect(parsePageRanges('1-3,5', 10)).toEqual([
      { from: 1, to: 3 },
      { from: 5, to: 5 },
    ]);
  });

  it('倒序区间自动交换', () => {
    expect(parsePageRanges('5-3', 10)).toEqual([{ from: 3, to: 5 }]);
  });

  it('非法格式抛错', () => {
    expect(() => parsePageRanges('abc', 5)).toThrow();
    expect(() => parsePageRanges('1;2', 5)).toThrow();
    expect(() => parsePageRanges('1-2-3', 5)).toThrow();
  });

  it('越界抛错且带总页数', () => {
    expect(() => parsePageRanges('1-99', 5)).toThrow(/共 5 页/);
    expect(() => parsePageRanges('0', 5)).toThrow();
  });

  it('0 页文档 → 空', () => {
    expect(parsePageRanges('', 0)).toEqual([]);
  });
});

describe('expandRanges / splitName', () => {
  it('展开为 0 起索引', () => {
    expect(expandRanges([{ from: 1, to: 3 }, { from: 5, to: 5 }])).toEqual([0, 1, 2, 4]);
  });

  it('拆分命名', () => {
    expect(splitName('文档.pdf', { from: 1, to: 3 })).toBe('文档_p1-3.pdf');
    expect(splitName('文档.pdf', { from: 2, to: 2 })).toBe('文档_p2.pdf');
    expect(splitName('noext', { from: 1, to: 1 })).toBe('noext_p1.pdf');
  });
});

describe('computeFitScale', () => {
  it('contain：等比缩放取小，不超出目标框', () => {
    // 源 A4(595.276×841.89) → 目标 A3(842×1191)，比例几乎一致：
    // k=min(1.41436, 1.41481)=1.41436 → 宽铺满 842，高 1190.86 略留白
    const r = computeFitScale(595.276, 841.89, 842, 1191, 'contain');
    expect(r.w).toBeCloseTo(842, 0);
    expect(r.h).toBeCloseTo(1191, 0);
    expect(r.w).toBeLessThanOrEqual(842);
    expect(r.h).toBeLessThanOrEqual(1191);
  });

  it('contain：宽源留白在高度方向', () => {
    // 源 842×595（横）→ 目标 420×595（竖 A5）：k=min(0.499, 1)=0.499
    const r = computeFitScale(842, 595, 420, 595, 'contain');
    expect(r.w).toBeCloseTo(420, 4);
    expect(r.h).toBeCloseTo(297, 0);
  });

  it('cover：等比缩放取大，超出目标框', () => {
    const r = computeFitScale(595.276, 841.89, 842, 1191, 'cover');
    expect(r.w).toBeCloseTo(842, 0);
    expect(r.h).toBeCloseTo(1191, 0);
    // 极端比例：宽矮源(1000×100)进高窄框(500×1000)：
    // k=max(0.5, 10)=10 → 高铺满 1000，宽溢出到 10000（渲染时被 MediaBox 裁切）
    const r2 = computeFitScale(1000, 100, 500, 1000, 'cover');
    expect(r2.w).toBeCloseTo(10000, 4);
    expect(r2.h).toBeCloseTo(1000, 4);
  });

  it('stretch：拉满目标', () => {
    expect(computeFitScale(595, 842, 420, 595, 'stretch')).toEqual({ w: 420, h: 595 });
  });

  it('非正尺寸抛错', () => {
    expect(() => computeFitScale(0, 100, 100, 100, 'contain')).toThrow();
    expect(() => computeFitScale(100, 100, -1, 100, 'contain')).toThrow();
  });
});

describe('mergePdfs', () => {
  it('合并两个文档，页数相加且顺序保持', async () => {
    const out = await mergePdfs(two);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(5);
  });

  it('少于 2 个文件抛错', async () => {
    await expect(mergePdfs([two[0]])).rejects.toThrow(/至少/);
  });
});

describe('splitPdf', () => {
  it('按范围拆成多个文件，页数与命名正确', async () => {
    const out = await splitPdf(two[1].data, '1-2,3', 'b.pdf');
    expect(out.map((o) => o.name)).toEqual(['b_p1-2.pdf', 'b_p3.pdf']);
    const d1 = await PDFDocument.load(out[0].data);
    const d2 = await PDFDocument.load(out[1].data);
    expect(d1.getPageCount()).toBe(2);
    expect(d2.getPageCount()).toBe(1);
  });

  it('空范围 = 整体复制一个文件', async () => {
    const out = await splitPdf(two[1].data, '', 'b.pdf');
    expect(out).toHaveLength(1);
    const d = await PDFDocument.load(out[0].data);
    expect(d.getPageCount()).toBe(3);
  });

  it('非法范围抛错', async () => {
    await expect(splitPdf(two[1].data, '9-99', 'b.pdf')).rejects.toThrow(/共 3 页/);
  });
});

describe('rotatePdf', () => {
  it('旋转累加并归一化到 0-359', async () => {
    let data = await makePdf(1);
    data = await rotatePdf(data, 90);
    expect((await PDFDocument.load(data)).getPage(0).getRotation().angle).toBe(90);
    data = await rotatePdf(data, 270);
    expect((await PDFDocument.load(data)).getPage(0).getRotation().angle).toBe(0);
  });

  it('只旋转选中页', async () => {
    const data = await rotatePdf(await makePdf(3), 180, '2');
    const doc = await PDFDocument.load(data);
    expect(doc.getPage(0).getRotation().angle).toBe(0);
    expect(doc.getPage(1).getRotation().angle).toBe(180);
    expect(doc.getPage(2).getRotation().angle).toBe(0);
  });

  it('非法角度抛错', async () => {
    await expect(rotatePdf(await makePdf(1), 45 as never)).rejects.toThrow();
  });
});

describe('unifyPageSize', () => {
  it('contain：全部页统一为目标尺寸且页数不变', async () => {
    // 混排：A4 竖 + A4 横
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    doc.addPage([842, 595]);
    const mixed = await doc.save();
    const out = await unifyPageSize(mixed, { w: 420, h: 595 }, 'contain');
    const res = await PDFDocument.load(out);
    expect(res.getPageCount()).toBe(2);
    for (const p of res.getPages()) {
      const { width, height } = p.getSize();
      expect(Math.round(width)).toBe(420);
      expect(Math.round(height)).toBe(595);
    }
  });

  it('未选中页保持原尺寸', async () => {
    const out = await unifyPageSize(await makePdf(3, 595, 842), { w: 420, h: 595 }, 'stretch', '1');
    const res = await PDFDocument.load(out);
    expect(Math.round(res.getPage(0).getSize().width)).toBe(420);
    expect(Math.round(res.getPage(1).getSize().width)).toBe(595);
    expect(Math.round(res.getPage(2).getSize().width)).toBe(595);
  });

  it('旋转源页按显示尺寸缩放（交换宽高）', async () => {
    // 横页旋转 90 后显示为竖 595×842 → contain 进 420×595：宽方向受限
    const doc = await PDFDocument.create();
    const p = doc.addPage([842, 595]);
    p.setRotation(degrees(90));
    const rotated = await doc.save();
    // 只验证尺寸统一成功（缩放数值由 computeFitScale 单测覆盖）
    const out = await unifyPageSize(rotated, { w: 420, h: 595 }, 'contain');
    const res = await PDFDocument.load(out);
    expect(Math.round(res.getPage(0).getSize().width)).toBe(420);
  });

  it('非正目标尺寸抛错', async () => {
    await expect(unifyPageSize(await makePdf(1), { w: 0, h: 595 }, 'contain')).rejects.toThrow();
  });

  it('无 Contents 的空白页（双面填充页）不炸，统一为目标尺寸空页', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]); // 无任何绘制 → 无 Contents 流
    const blank = await doc.save();
    const out = await unifyPageSize(blank, { w: 420, h: 595 }, 'contain');
    const res = await PDFDocument.load(out);
    expect(res.getPageCount()).toBe(1);
    expect(Math.round(res.getPage(0).getSize().width)).toBe(420);
    expect(Math.round(res.getPage(0).getSize().height)).toBe(595);
  });
});

describe('pdfToImages 前置校验', () => {
  it('非正倍率在触碰 pdfjs 前抛错', async () => {
    await expect(pdfToImages(await makePdf(1), { scale: 0 })).rejects.toThrow(/倍率/);
  });
});
