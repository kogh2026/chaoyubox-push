/** MaxRects 装箱（D9）测试：不重叠、不越界、混排与溢出判定。 */
import { describe, expect, it } from 'vitest';
import { packMaxRects, packMixedCards, type PlacedItem } from './maxRects';
import { LAYOUT_ALGOS, resolveCardGrid } from './layoutStrategies';
import type { LayoutCfg } from './idCardLayout';

function overlaps(a: PlacedItem, b: PlacedItem): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function assertNoOverlap(list: PlacedItem[]): void {
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) expect(overlaps(list[i], list[j])).toBe(false);
}

const cfg: LayoutCfg = { perPage: 4, gap: 4, shrink: true, pos: 'center', offX: 0, offY: 0 };

describe('packMaxRects', () => {
  it('4 张同尺寸卡：全部放入且互不重叠、不越界', () => {
    const items = Array.from({ length: 4 }, (_, i) => ({ id: String(i), w: 50, h: 70 }));
    const res = packMixedCards(items, 210, 297, 4, 6);
    expect(res.count).toBe(4);
    assertNoOverlap(res.placements);
    for (const p of res.placements) {
      expect(p.x).toBeGreaterThanOrEqual(6); // 安全边距
      expect(p.x + p.w).toBeLessThanOrEqual(210 - 6 + 0.001);
      expect(p.y + p.h).toBeLessThanOrEqual(297 - 6 + 0.001);
    }
  });

  it('多尺寸混排：不同规格都能放且不重叠', () => {
    const items = [
      { id: 'a', w: 50, h: 70 },
      { id: 'b', w: 50, h: 70 },
      { id: 'c', w: 100, h: 40 },
      { id: 'd', w: 100, h: 40 },
    ];
    const res = packMaxRects(items, { binW: 210, binH: 297, gap: 4, pad: 6 });
    expect(res.count).toBe(4);
    assertNoOverlap(res.placements);
  });

  it('放不下时不硬塞：溢出部分被忽略', () => {
    const items = Array.from({ length: 4 }, (_, i) => ({ id: String(i), w: 60, h: 60 }));
    const res = packMaxRects(items, { binW: 100, binH: 100, gap: 0 });
    expect(res.count).toBeLessThan(4);
    expect(res.count).toBeGreaterThanOrEqual(1);
    assertNoOverlap(res.placements);
  });

  it('pad 只会把整体内缩，不改变相对布局', () => {
    const items = [{ w: 40, h: 40 }];
    const noPad = packMaxRects(items, { binW: 100, binH: 100, gap: 0, pad: 0 });
    const withPad = packMaxRects(items, { binW: 100, binH: 100, gap: 0, pad: 10 });
    expect(noPad.placements[0].x).toBe(0);
    expect(withPad.placements[0].x).toBe(10);
    expect(withPad.placements[0].y).toBe(10);
  });

  it('空输入 → 空结果', () => {
    const res = packMaxRects([], { binW: 100, binH: 100 });
    expect(res.count).toBe(0);
    expect(res.placements).toEqual([]);
  });
});

describe('layoutStrategies: maxrects', () => {
  it('LAYOUT_ALGOS 暴露「混排装箱」', () => {
    expect(LAYOUT_ALGOS.map((a) => a.id)).toContain('maxrects');
  });

  it('resolveCardGrid(maxrects) 返回可用网格（张数>0，缩放∈(0,1]）', () => {
    const g = resolveCardGrid('maxrects', 210, 297, 54, 86, cfg);
    expect(g.perPage).toBeGreaterThan(0);
    expect(g.scale).toBeGreaterThan(0);
    expect(g.scale).toBeLessThanOrEqual(1);
    expect(g.blockW).toBeLessThanOrEqual(210);
    expect(g.blockH).toBeLessThanOrEqual(297);
  });
});
