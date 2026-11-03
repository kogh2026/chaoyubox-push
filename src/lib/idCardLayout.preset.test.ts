/** 版面预设（V3）：显式行列排布 + resolveCardGrid 预设优先 + 落位锚定 */
import { describe, expect, it } from 'vitest';
import {
  IC_PAPERS,
  LAYOUT_PRESETS,
  computeCardGrid,
  pagePlacements,
  presetForCount,
  type LayoutCfg,
} from './idCardLayout';
import { resolveCardGrid, type LayoutAlgo } from './layoutStrategies';

const A4 = IC_PAPERS.a4; // 210×297
const CW = 85.6; // 身份证宽
const CH = 54; // 身份证高
const GAP = 4;

function cfg(over: Partial<LayoutCfg> = {}): LayoutCfg {
  return { perPage: 2, gap: GAP, shrink: true, pos: 'center', offX: 0, offY: 0, ...over };
}

describe('presetForCount', () => {
  it('2/3/5/6/11 张有对应预设', () => {
    expect(presetForCount(2)).toEqual({ cols: 1, rows: 2 });
    expect(presetForCount(3)).toEqual({ cols: 1, rows: 3 });
    expect(presetForCount(5)).toEqual({ cols: 2, rows: 3 });
    expect(presetForCount(6)).toEqual({ cols: 2, rows: 3 });
    expect(presetForCount(11)).toEqual({ cols: 3, rows: 4 });
  });

  it('1 张 / 4 张 / auto 没有预设（走自动网格）', () => {
    expect(presetForCount(1)).toBeNull();
    expect(presetForCount(4)).toBeNull();
    expect(presetForCount('auto')).toBeNull();
  });

  it('预设清单自洽：张数不重复、都放得下（行×列 ≥ 张数）', () => {
    const counts = LAYOUT_PRESETS.map((p) => p.count);
    expect(new Set(counts).size).toBe(counts.length);
    for (const p of LAYOUT_PRESETS) expect(p.cols * p.rows).toBeGreaterThanOrEqual(p.count);
  });
});

describe('computeCardGrid · 预设模式', () => {
  it('2 张竖排一列：scale=1、不缩放', () => {
    const g = computeCardGrid(A4.w, A4.h, CW, CH, cfg({ perPage: 2, preset: { cols: 1, rows: 2 } }));
    expect(g.cols).toBe(1);
    expect(g.rows).toBe(2);
    expect(g.perPage).toBe(2);
    expect(g.capacity).toBe(2);
    expect(g.usedRows).toBe(2);
    expect(g.scale).toBeCloseTo(1, 6);
    expect(g.blockW).toBeCloseTo(CW, 6);
    expect(g.blockH).toBeCloseTo(2 * CH + GAP, 6); // 108+4=112
  });

  it('5 张（2 列 × 3 行）：最后一行只占 1 张，usedRows 仍为 3', () => {
    const g = computeCardGrid(A4.w, A4.h, CW, CH, cfg({ perPage: 5, preset: { cols: 2, rows: 3 } }));
    expect(g.cols).toBe(2);
    expect(g.rows).toBe(3);
    expect(g.perPage).toBe(5);
    expect(g.usedRows).toBe(3);
    expect(g.scale).toBeCloseTo(1, 6);
    expect(g.blockW).toBeCloseTo(2 * CW + GAP, 6); // 175.2
    expect(g.blockH).toBeCloseTo(3 * CH + 2 * GAP, 6); // 170
  });

  it('11 张（3 列 × 4 行）：放不下时自动缩小（预设恒自适应）', () => {
    const g = computeCardGrid(A4.w, A4.h, CW, CH, cfg({ perPage: 11, preset: { cols: 3, rows: 4 } }));
    // 可用宽 198；间距先占掉 2×4=8，剩 190 分给 3 张卡 → scale = 190/(3×85.6) = 190/256.8
    const expectScale = 190 / 256.8;
    expect(g.scale).toBeCloseTo(expectScale, 6);
    expect(g.scale).toBeLessThan(1);
    expect(g.perPage).toBe(11);
    expect(g.capacity).toBe(12);
    expect(g.usedRows).toBe(4);
    // 缩放后内容块必须落在可用区内
    expect(g.blockW).toBeLessThanOrEqual(198 + 1e-6);
    expect(g.blockH).toBeLessThanOrEqual(285 + 1e-6);
  });

  it('shrink=false 也不溢出（预设本身即"这一页就要这样排"）', () => {
    const g = computeCardGrid(
      A4.w,
      A4.h,
      CW,
      CH,
      cfg({ perPage: 11, preset: { cols: 3, rows: 4 }, shrink: false }),
    );
    expect(g.scale).toBeLessThan(1);
    expect(g.blockW).toBeLessThanOrEqual(198 + 1e-6);
  });

  it('perPage=auto + 预设 → 填满预设格数', () => {
    const g = computeCardGrid(A4.w, A4.h, CW, CH, cfg({ perPage: 'auto', preset: { cols: 2, rows: 3 } }));
    expect(g.perPage).toBe(6);
    expect(g.capacity).toBe(6);
  });

  it('张数超过预设格数时被夹到格数（不越界）', () => {
    const g = computeCardGrid(A4.w, A4.h, CW, CH, cfg({ perPage: 99, preset: { cols: 1, rows: 2 } }));
    expect(g.perPage).toBe(2);
    expect(g.usedRows).toBe(2);
  });

  it('极端参数不返回 0/负尺寸（20mm 纸也能算出正数）', () => {
    const g = computeCardGrid(20, 20, CW, CH, cfg({ perPage: 6, preset: { cols: 2, rows: 3 } }));
    expect(g.scale).toBeGreaterThan(0);
    expect(g.cardW).toBeGreaterThan(0);
    expect(g.cardH).toBeGreaterThan(0);
  });
});

describe('computeCardGrid · 无预设时保持旧行为（回归）', () => {
  it('perPage=2 仍走单列堆叠，与预设 p2 结果一致', () => {
    const plain = computeCardGrid(A4.w, A4.h, CW, CH, cfg({ perPage: 2 }));
    expect(plain.cols).toBe(1);
    expect(plain.perPage).toBe(2);
    expect(plain.scale).toBeCloseTo(1, 6);
    const preset = computeCardGrid(A4.w, A4.h, CW, CH, cfg({ perPage: 2, preset: { cols: 1, rows: 2 } }));
    expect(plain.blockW).toBeCloseTo(preset.blockW, 6);
    expect(plain.blockH).toBeCloseTo(preset.blockH, 6);
  });

  it('perPage=4 仍是 2 列网格（无预设）', () => {
    const g = computeCardGrid(A4.w, A4.h, CW, CH, cfg({ perPage: 4 }));
    expect(g.cols).toBe(2);
    expect(g.usedRows).toBe(2);
  });
});

describe('resolveCardGrid · 预设优先于任何算法', () => {
  const algos: LayoutAlgo[] = ['grid', 'compact', 'adaptive', 'maxrects'];

  it.each(algos)('%s 算法遇到预设时不改写行列', (algo) => {
    const g = resolveCardGrid(
      algo,
      A4.w,
      A4.h,
      CW,
      CH,
      cfg({ perPage: 11, preset: { cols: 3, rows: 4 } }),
    );
    expect(g.cols).toBe(3);
    expect(g.rows).toBe(4);
    expect(g.perPage).toBe(11);
  });

  it('无预设时各算法仍各自生效（compact 不会退化成 grid 的 1 列）', () => {
    const compact = resolveCardGrid('compact', A4.w, A4.h, CW, CH, cfg({ perPage: 6 }));
    expect(compact.cols).toBeGreaterThan(1);
  });
});

describe('pagePlacements · 预设下的落位与锚定', () => {
  const g = computeCardGrid(A4.w, A4.h, CW, CH, cfg({ perPage: 5, preset: { cols: 2, rows: 3 } }));

  it('5 张按 2 列右行优先排列，第 5 张落在第 3 行左侧', () => {
    const ps = pagePlacements(A4.w, A4.h, g, cfg({ perPage: 5, preset: { cols: 2, rows: 3 } }));
    expect(ps).toHaveLength(5);
    const blockW = 2 * CW + GAP;
    const blockH = 3 * CH + 2 * GAP;
    const x0 = (A4.w - blockW) / 2;
    const y0 = (A4.h - blockH) / 2;
    expect(ps[4].x).toBeCloseTo(x0, 6);
    expect(ps[4].y).toBeCloseTo(y0 + 2 * (CH + GAP), 6);
    // 第 1、2 张同一行
    expect(ps[0].y).toBeCloseTo(ps[1].y, 6);
    expect(ps[1].x).toBeCloseTo(ps[0].x + CW + GAP, 6);
  });

  it('居上时块顶端贴安全边距（6mm）', () => {
    const cfgTop = cfg({ perPage: 5, preset: { cols: 2, rows: 3 }, pos: 'top' });
    const ps = pagePlacements(A4.w, A4.h, g, cfgTop);
    expect(ps[0].y).toBeCloseTo(6, 6);
  });

  it('居下时块底端留安全边距（6mm）', () => {
    const cfgBot = cfg({ perPage: 5, preset: { cols: 2, rows: 3 }, pos: 'bottom' });
    const ps = pagePlacements(A4.w, A4.h, g, cfgBot);
    // 最后一张在第 3 行，其底边应正好落在 297-6=291
    expect(ps[4].y + CH).toBeCloseTo(A4.h - 6, 6);
  });

  it('上下偏移整体平移，不影响张数', () => {
    const a = pagePlacements(A4.w, A4.h, g, cfg({ perPage: 5, preset: { cols: 2, rows: 3 } }));
    const b = pagePlacements(
      A4.w,
      A4.h,
      g,
      cfg({ perPage: 5, preset: { cols: 2, rows: 3 }, offY: 20 }),
    );
    expect(b).toHaveLength(a.length);
    expect(b[0].y - a[0].y).toBeCloseTo(20, 6);
  });
});
