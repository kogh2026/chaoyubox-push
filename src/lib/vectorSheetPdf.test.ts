/** 矢量拼版导出测试（node 环境 + 文档桩，无浏览器依赖）
 *  覆盖：cellFingerprint 去重键、planVectorPages 去重计数、
 *  toPdfRect y 轴翻转、exportVectorSheetPdf 的页/图/格绘制与去重复用。 */
import { describe, expect, it } from 'vitest';
import {
  cellFingerprint,
  exportVectorSheetPdf,
  planVectorPages,
  toPdfRect,
  type VectorCell,
  type VectorDocLike,
  type VectorPageLike,
} from './vectorSheetPdf';

const MM = 72 / 25.4;

function cell(src: string, rotation = 0): VectorCell {
  return {
    img: { src, currentSrc: '', naturalWidth: 100, naturalHeight: 100 } as unknown as HTMLImageElement,
    rotation,
  };
}

/** 文档桩：记录 addPage / embedJpg / drawImage / drawLine / drawText 调用 */
function stubDoc(withFont = true) {
  const calls = {
    addPage: [] as [number, number][],
    embedJpg: [] as Uint8Array[],
    embedCjkFont: 0,
    drawImage: [] as { img: unknown; o: unknown }[],
    drawLine: [] as unknown[],
    drawText: [] as { t: string; o: unknown }[],
    save: 0,
  };
  const page: VectorPageLike = {
    drawImage: (img, o) => void calls.drawImage.push({ img, o }),
    drawLine: (o) => void calls.drawLine.push(o),
    drawText: (t, o) => void calls.drawText.push({ t, o }),
  };
  const doc: VectorDocLike = {
    addPage: (size) => {
      calls.addPage.push(size);
      return page;
    },
    embedJpg: async (bytes) => {
      calls.embedJpg.push(bytes);
      return { id: calls.embedJpg.length };
    },
    embedCjkFont: async () => {
      calls.embedCjkFont++;
      return withFont ? { font: true } : null;
    },
    save: async () => {
      calls.save++;
      return new Uint8Array([1, 2, 3]);
    },
  };
  return { doc, calls };
}

const placements = [
  { x: 10, y: 10, w: 50, h: 70 },
  { x: 65, y: 10, w: 50, h: 70 },
];

const style = {
  colorMode: 'enhance' as const,
  sat: 100,
  sharpen: 0,
  cropMarks: true,
  wm: { on: true, text: '超誉工作台' },
};

/* ===== cellFingerprint ===== */

describe('cellFingerprint', () => {
  it('同源图 + 同旋转 + 同尺寸 + 同风格 → 同一指纹（可去重）', () => {
    const a = cellFingerprint(cell('blob:x'), 100, 140, 'f');
    const b = cellFingerprint(cell('blob:x'), 100, 140, 'f');
    expect(a).toBe(b);
  });

  it('旋转或尺寸或风格不同 → 指纹不同（不会错误复用）', () => {
    const base = cellFingerprint(cell('blob:x'), 100, 140, 'f');
    expect(cellFingerprint(cell('blob:x', 90), 100, 140, 'f')).not.toBe(base);
    expect(cellFingerprint(cell('blob:x'), 200, 140, 'f')).not.toBe(base);
    expect(cellFingerprint(cell('blob:x'), 100, 140, 'g')).not.toBe(base);
  });

  it('不同源图 → 指纹不同', () => {
    expect(cellFingerprint(cell('blob:a'), 100, 140, 'f')).not.toBe(
      cellFingerprint(cell('blob:b'), 100, 140, 'f'),
    );
  });
});

/* ===== planVectorPages ===== */

describe('planVectorPages', () => {
  it('所有格同源同风格 → uniqueImages = 1，totalCells = 格数', () => {
    const c = cell('blob:x');
    const plan = planVectorPages([[c, c], [c, c]], placements, 300, style);
    expect(plan.totalCells).toBe(4);
    expect(plan.uniqueImages).toBe(1);
  });

  it('混合旋转 → uniqueImages 按组合计数', () => {
    const a = cell('blob:x', 0);
    const b = cell('blob:x', 90);
    const plan = planVectorPages([[a, b], [a, b]], placements, 300, style);
    expect(plan.totalCells).toBe(4);
    expect(plan.uniqueImages).toBe(2);
  });

  it('格子多于 placement：只产出有矩形的格', () => {
    const c = cell('blob:x');
    const plan = planVectorPages([[c, c, c]], placements, 300, style);
    expect(plan.totalCells).toBe(2);
  });

  it('空页数组 → 空计划', () => {
    const plan = planVectorPages([], placements, 300, style);
    expect(plan.totalCells).toBe(0);
    expect(plan.uniqueImages).toBe(0);
  });
});

/* ===== toPdfRect ===== */

describe('toPdfRect', () => {
  it('mm 矩形（左上原点）→ pt 矩形（原点左下，y 翻转）', () => {
    const r = toPdfRect({ x: 10, y: 20, w: 50, h: 70 }, 297);
    expect(r.x).toBeCloseTo(10 * MM, 5);
    expect(r.width).toBeCloseTo(50 * MM, 5);
    expect(r.height).toBeCloseTo(70 * MM, 5);
    expect(r.y).toBeCloseTo((297 - 20 - 70) * MM, 5);
  });
});

/* ===== exportVectorSheetPdf（文档桩） ===== */

describe('exportVectorSheetPdf', () => {
  const opts = (pages: VectorCell[][], withFont = true) => ({
    paper: { w: 210, h: 297 },
    placements,
    pages,
    style,
    dpi: 300,
    encodeCell: async (c: VectorCell) => new Uint8Array([c.rotation]),
    createDoc: (async () => stubDoc(withFont).doc) as never,
  });

  it('两页：addPage 2 次；每格 drawImage；save 一次', async () => {
    const { doc, calls } = stubDoc();
    const out = await exportVectorSheetPdf({
      ...opts([[cell('a'), cell('b')], [cell('c'), cell('d')]]),
      createDoc: (async () => doc) as never,
    });
    expect(calls.addPage).toHaveLength(2);
    expect(calls.drawImage).toHaveLength(4);
    expect(calls.save).toBe(1);
    expect(out.length).toBeGreaterThan(0);
  });

  it('核心：重复图只 embedJpg 一次（去重生效）', async () => {
    const { doc, calls } = stubDoc();
    const same = cell('blob:same');
    await exportVectorSheetPdf({
      ...opts([[same, same], [same, same]]),
      createDoc: (async () => doc) as never,
    });
    // 4 个格子，但只有 1 张唯一图 → 只嵌入 1 次
    expect(calls.drawImage).toHaveLength(4);
    expect(calls.embedJpg).toHaveLength(1);
  });

  it('不同旋转视为不同图 → 各自嵌入', async () => {
    const { doc, calls } = stubDoc();
    await exportVectorSheetPdf({
      ...opts([[cell('blob:x', 0), cell('blob:x', 90)]]),
      createDoc: (async () => doc) as never,
    });
    expect(calls.embedJpg).toHaveLength(2);
  });

  it('drawImage 用翻转后的 pt 矩形（与 toPdfRect 一致）', async () => {
    const { doc, calls } = stubDoc();
    await exportVectorSheetPdf({
      ...opts([[cell('blob:x')]]),
      createDoc: (async () => doc) as never,
    });
    expect(calls.drawImage[0].o).toEqual(toPdfRect(placements[0], 297));
  });

  it('cropMarks=true：每格 4 角 × 2 条虚线 = 8 条线', async () => {
    const { doc, calls } = stubDoc();
    await exportVectorSheetPdf({
      ...opts([[cell('a'), cell('b')], [cell('c'), cell('d')]]),
      createDoc: (async () => doc) as never,
    });
    // 2 页 × 2 格 × 8 条
    expect(calls.drawLine).toHaveLength(2 * 2 * 8);
  });

  it('cropMarks=false：不画裁切线', async () => {
    const { doc, calls } = stubDoc();
    await exportVectorSheetPdf({
      ...opts([[cell('a'), cell('b')], [cell('c'), cell('d')]]),
      style: { ...style, cropMarks: false },
      createDoc: (async () => doc) as never,
    } as never);
    expect(calls.drawLine).toHaveLength(0);
  });

  it('水印开启且有字体 → drawText；无字体 → 跳过不报错', async () => {
    const withF = stubDoc(true);
    await exportVectorSheetPdf({
      ...opts([[cell('a'), cell('b')]]),
      createDoc: (async () => withF.doc) as never,
    });
    expect(withF.calls.drawText.length).toBeGreaterThan(0);

    const noF = stubDoc(false);
    await exportVectorSheetPdf({
      ...opts([[cell('a'), cell('b')]]),
      createDoc: (async () => noF.doc) as never,
    });
    expect(noF.calls.drawText).toHaveLength(0);
  });

  it('0 页：抛错，不创建文档', async () => {
    await expect(exportVectorSheetPdf(opts([]))).rejects.toThrow();
  });
});
