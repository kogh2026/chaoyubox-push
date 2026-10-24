/** 画布布局渲染接缝测试（node 环境 + ctx/canvas 桩，无需 jsdom）
 *  覆盖：cellRects / assignSources 纯函数、renderPreview / fitCover /
 *  buildSheetImages 的绘制行为（坐标、次数、参数与 cellRects 一致）。 */
import { describe, expect, it } from 'vitest';
import {
  buildSheetImages,
  cellRects,
  assignSources,
  fitCover,
  renderPreview,
  type CanvasLike,
  type Ctx2DLike,
} from './cardLayout';

/* ---------- 桩：2d context / canvas ---------- */

function makeCtxStub() {
  const calls = {
    fillRect: [] as number[][],
    strokeRect: [] as number[][],
    drawImage: [] as unknown[][],
    lineDash: [] as number[][],
  };
  const ctx: Ctx2DLike = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    setLineDash: (s) => calls.lineDash.push(s),
    fillRect: (...a) => calls.fillRect.push(a),
    strokeRect: (...a) => calls.strokeRect.push(a),
    drawImage: (...a) => calls.drawImage.push(a),
  };
  return { ctx, calls };
}

function makeCanvasStub() {
  const { ctx, calls } = makeCtxStub();
  const canvas: CanvasLike = { width: 0, height: 0, getContext: (id) => (id === '2d' ? ctx : null) };
  return { canvas, ctx, calls };
}

/** 假源图：只提供 fitCover 需要的 naturalWidth/Height */
function makeImg(natW: number, natH: number): HTMLImageElement {
  return { naturalWidth: natW, naturalHeight: natH } as unknown as HTMLImageElement;
}

/* ---------- cellRects：格子坐标（纯函数） ---------- */

describe('cellRects', () => {
  it('2×2 网格：行主序，首格在 margin 处，gap 逐格累积', () => {
    const rects = cellRects({ cols: 2, rows: 2, itemW: 10, itemH: 20, margin: 5, gap: 2, scale: 1 });
    expect(rects).toEqual([
      { x: 5, y: 5, w: 10, h: 20 },
      { x: 17, y: 5, w: 10, h: 20 }, // x = 5 + 1*(10+2)
      { x: 5, y: 27, w: 10, h: 20 }, // y = 5 + 1*(20+2)
      { x: 17, y: 27, w: 10, h: 20 },
    ]);
  });

  it('scale 换算：坐标与尺寸同乘', () => {
    const rects = cellRects({ cols: 2, rows: 1, itemW: 10, itemH: 20, margin: 5, gap: 2, scale: 3 });
    expect(rects).toEqual([
      { x: 15, y: 15, w: 30, h: 60 },
      { x: 51, y: 15, w: 30, h: 60 }, // x = 15 + 1*(30+6)
    ]);
  });

  it('单行单列：只有 margin 起点一个格子', () => {
    const rects = cellRects({ cols: 1, rows: 1, itemW: 25, itemH: 35, margin: 8, gap: 4, scale: 1 });
    expect(rects).toEqual([{ x: 8, y: 8, w: 25, h: 35 }]);
  });

  it('非法行列（0 / 负数 / 小数向下取整）', () => {
    expect(cellRects({ cols: 0, rows: 2, itemW: 10, itemH: 10, margin: 0, gap: 0, scale: 1 })).toEqual([]);
    expect(cellRects({ cols: 2, rows: -1, itemW: 10, itemH: 10, margin: 0, gap: 0, scale: 1 })).toEqual([]);
    expect(cellRects({ cols: 2.7, rows: 1, itemW: 10, itemH: 10, margin: 0, gap: 0, scale: 1 })).toHaveLength(2);
  });

  it('gap=0 时格子紧贴', () => {
    const rects = cellRects({ cols: 3, rows: 1, itemW: 10, itemH: 10, margin: 0, gap: 0, scale: 1 });
    expect(rects.map((r) => r.x)).toEqual([0, 10, 20]);
  });
});

/* ---------- assignSources：多图模式源图分配（纯函数） ---------- */

describe('assignSources', () => {
  it('取模循环填充', () => {
    expect(assignSources(5, 2)).toEqual([0, 1, 0, 1, 0]);
  });

  it('单源全 0', () => {
    expect(assignSources(4, 1)).toEqual([0, 0, 0, 0]);
  });

  it('源数 ≥ 格数时顺序取', () => {
    expect(assignSources(3, 5)).toEqual([0, 1, 2]);
  });

  it('0 源 → 全 null（调用方据此停止）', () => {
    expect(assignSources(3, 0)).toEqual([null, null, null]);
  });

  it('非法/零格数 → 空', () => {
    expect(assignSources(0, 2)).toEqual([]);
    expect(assignSources(-3, 2)).toEqual([]);
  });
});

/* ---------- renderPreview：预览绘制（ctx 桩） ---------- */

describe('renderPreview', () => {
  const paper = { id: 't', name: 't', w: 100, h: 200 };
  const layout = { cols: 2, rows: 2, perSheet: 4 };
  const base = { paper, layout, itemW: 10, itemH: 20, margin: 5, gap: 2, cutLines: true, scale: 2 };

  it('画布尺寸 = 纸张 × scale，先铺白底', () => {
    const { canvas, calls } = makeCanvasStub();
    renderPreview(canvas, { ...base, sheets: [] });
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(400);
    expect(calls.fillRect).toEqual([[0, 0, 200, 400]]);
  });

  it('drawImage 次数与坐标和 cellRects 完全一致', () => {
    const { canvas, calls } = makeCanvasStub();
    const sheets = [{ id: 's0' }, { id: 's1' }, { id: 's2' }, { id: 's3' }] as unknown as CanvasLike[];
    renderPreview(canvas, { ...base, cutLines: false, sheets });
    const rects = cellRects({ cols: 2, rows: 2, itemW: 10, itemH: 20, margin: 5, gap: 2, scale: 2 });
    expect(calls.strokeRect).toEqual([]); // 无裁切线
    expect(calls.drawImage).toHaveLength(4);
    calls.drawImage.forEach((args, i) => {
      expect(args[0]).toBe(sheets[i]);
      expect(args.slice(1)).toEqual([rects[i].x, rects[i].y, rects[i].w, rects[i].h]);
    });
    // 行主序：第二格 x 前进一个 (cell+gap)×scale，第三格 y 下一行
    expect(calls.drawImage[1].slice(1)).toEqual([34, 10, 20, 40]); // 10 + 1*(20+4)
    expect(calls.drawImage[2].slice(1)).toEqual([10, 54, 20, 40]); // 10 + 1*(40+4)
  });

  it('cutLines=true：每格先画虚线框（strokeRect 同坐标）', () => {
    const { canvas, calls } = makeCanvasStub();
    renderPreview(canvas, { ...base, cutLines: true, sheets: [] });
    expect(calls.strokeRect).toHaveLength(4);
    expect(calls.strokeRect[0]).toEqual([10, 10, 20, 40]);
    expect(calls.lineDash).toContainEqual([4, 3]); // 设置过虚线
  });

  it('sheets 少于格子数时，只画有的', () => {
    const { canvas, calls } = makeCanvasStub();
    const sheets = [{ id: 'a' }, { id: 'b' }] as unknown as CanvasLike[];
    renderPreview(canvas, { ...base, cutLines: false, sheets });
    expect(calls.drawImage).toHaveLength(2);
  });

  it('layout 0 格（cols=0）：只铺底不画格', () => {
    const { canvas, calls } = makeCanvasStub();
    renderPreview(canvas, {
      ...base,
      layout: { cols: 0, rows: 0, perSheet: 0 },
      sheets: [],
    });
    expect(calls.drawImage).toEqual([]);
    expect(calls.strokeRect).toEqual([]);
  });
});

/* ---------- fitCover：cover 裁切绘制（canvas 桩 + 工厂注入） ---------- */

describe('fitCover', () => {
  it('宽原图裁左右：drawImage 8 参 = coverSrcRect 结果', () => {
    const { canvas, calls } = makeCanvasStub();
    const made: number[] = [];
    const out = fitCover(makeImg(800, 400), 100, 100, () => {
      made.push(1);
      return canvas;
    });
    expect(made).toHaveLength(1); // 工厂只调一次
    expect(out).toBe(canvas);
    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(100);
    expect(calls.fillRect).toEqual([[0, 0, 100, 100]]); // 白底
    // sr=2 > tr=1 → sw = 400*1 = 400, sx = (800-400)/2 = 200, sy=0, sh=400
    expect(calls.drawImage).toHaveLength(1);
    expect(calls.drawImage[0]).toEqual([expect.anything(), 200, 0, 400, 400, 0, 0, 100, 100]);
  });

  it('高原图裁上下', () => {
    const { canvas, calls } = makeCanvasStub();
    fitCover(makeImg(400, 800), 100, 100, () => canvas);
    // sr=0.5 < tr=1 → sh = 400/1 = 400, sy = (800-400)/2 = 200
    expect(calls.drawImage[0]).toEqual([expect.anything(), 0, 200, 400, 400, 0, 0, 100, 100]);
  });

  it('像素尺寸下限 1：0 / 非法 → clamp 到 1', () => {
    const { canvas } = makeCanvasStub();
    fitCover(makeImg(100, 100), 0, -5, () => canvas);
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);
  });

  it('非法自然尺寸 → drawImage 空源矩形（sw/sh=0）', () => {
    const { canvas, calls } = makeCanvasStub();
    fitCover(makeImg(0, 0), 50, 50, () => canvas);
    expect(calls.drawImage[0]).toEqual([expect.anything(), 0, 0, 0, 0, 0, 0, 50, 50]);
  });
});

/* ---------- buildSheetImages：每格画布生成（工厂注入） ---------- */

describe('buildSheetImages', () => {
  const layout = { cols: 2, rows: 2, perSheet: 4 };

  it('single 模式：同一画布复用 perSheet 次，工厂只调 1 次', () => {
    const stubs = Array.from({ length: 4 }, () => makeCanvasStub());
    let k = 0;
    const out = buildSheetImages(
      { sources: [makeImg(100, 100)], layout, itemW: 25.4, itemH: 25.4, mode: 'single', dpi: 300 },
      () => stubs[k++].canvas,
    );
    expect(out).toHaveLength(4);
    expect(new Set(out).size).toBe(1); // 全是同一个引用
    expect(k).toBe(1); // 工厂只调一次
  });

  it('single 模式 0 源 → 空数组（不建画布）', () => {
    const out = buildSheetImages(
      { sources: [], layout, itemW: 25.4, itemH: 25.4, mode: 'single' },
      () => {
        throw new Error('不应创建画布');
      },
    );
    expect(out).toEqual([]);
  });

  it('multi 模式：按 assignSources 顺序分配源图（3 源 5 格）', () => {
    const imgs = [makeImg(10, 10), makeImg(20, 20), makeImg(30, 30)];
    const stubs = Array.from({ length: 5 }, () => makeCanvasStub());
    let k = 0;
    const out = buildSheetImages(
      { sources: imgs, layout: { cols: 3, rows: 2, perSheet: 5 }, itemW: 25.4, itemH: 35, mode: 'multi' },
      () => stubs[k++].canvas,
    );
    expect(out).toHaveLength(5);
    // 索引序列 [0,1,2,0,1] → 每格 drawImage 第一参为对应源图
    stubs.forEach((s, i) => {
      expect(s.calls.drawImage[0][0]).toBe(imgs[i % 3]);
    });
    // DPI 换算：25.4mm/25.4*300 = 300px；35mm → round(35/25.4*300)（fitCover 内 round）
    expect(stubs[0].canvas.width).toBe(300);
    expect(stubs[0].canvas.height).toBe(Math.round((35 / 25.4) * 300));
  });

  it('multi 模式 0 源 → 空（assignSources 全 null，首格即停）', () => {
    const out = buildSheetImages(
      { sources: [], layout, itemW: 10, itemH: 10, mode: 'multi' },
      () => {
        throw new Error('不应创建画布');
      },
    );
    expect(out).toEqual([]);
  });

  it('multi 模式源数组有空洞：遇到 undefined 停止', () => {
    const imgs = [makeImg(10, 10), undefined as unknown as HTMLImageElement, makeImg(30, 30)];
    const stubs = Array.from({ length: 3 }, () => makeCanvasStub());
    let k = 0;
    const out = buildSheetImages(
      { sources: imgs, layout: { cols: 3, rows: 1, perSheet: 3 }, itemW: 10, itemH: 10, mode: 'multi' },
      () => stubs[k++].canvas,
    );
    expect(out).toHaveLength(1); // 第 2 格 src 空洞 → break
  });
});
