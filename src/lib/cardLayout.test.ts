import { describe, expect, it } from 'vitest';
import { PAPER_SIZES, PHOTO_PRESETS, computeLayout, coverSrcRect } from './cardLayout';

/* ===== 缝点：computeLayout 核心布局算法 + coverSrcRect cover 裁切数学 =====
   预期值全部手工演算。例：A4(210×297) 排 1 寸(25×35)、边距 5、间隙 2：
   usableW=200, usableH=287；
   cols=floor((200+2)/(25+2))=floor(202/27)=7；
   rows=floor((287+2)/(35+2))=floor(289/37)=7 → 49 张/纸。 */

const A4 = PAPER_SIZES.find((p) => p.id === 'a4')!;
const CUN1 = PHOTO_PRESETS.find((p) => p.id === '1cun')!;

describe('computeLayout 核心算法', () => {
  it('A4 排 1 寸：7×7=49 张/纸', () => {
    expect(computeLayout(A4.w, A4.h, CUN1.w, CUN1.h, 5, 2)).toEqual({ cols: 7, rows: 7, perSheet: 49 });
  });

  it('A4 排 2 寸(35×49)：5×5=25 张/纸', () => {
    const c2 = PHOTO_PRESETS.find((p) => p.id === '2cun')!;
    // cols=floor(202/37)=5; rows=floor(289/51)=5
    expect(computeLayout(A4.w, A4.h, c2.w, c2.h, 5, 2)).toEqual({ cols: 5, rows: 5, perSheet: 25 });
  });

  it('A5 排 1 寸：3×5=15 张/纸', () => {
    const a5 = PAPER_SIZES.find((p) => p.id === 'a5')!;
    // usableW=138, usableH=200; cols=floor(140/27)=5; rows=floor(202/37)=5 → 25
    expect(computeLayout(a5.w, a5.h, CUN1.w, CUN1.h, 5, 2)).toEqual({ cols: 5, rows: 5, perSheet: 25 });
  });

  it('gap 计入单元格步长：gap 越大每张越少', () => {
    const g0 = computeLayout(A4.w, A4.h, CUN1.w, CUN1.h, 5, 0);
    const g10 = computeLayout(A4.w, A4.h, CUN1.w, CUN1.h, 5, 10);
    // gap0: cols=floor(200/25)=8, rows=floor(287/35)=8 → 64
    expect(g0).toEqual({ cols: 8, rows: 8, perSheet: 64 });
    // gap10: cols=floor(210/35)=6, rows=floor(297/45)=6 → 36
    expect(g10).toEqual({ cols: 6, rows: 6, perSheet: 36 });
    expect(g10.perSheet).toBeLessThan(g0.perSheet);
  });

  it('边距越大每张越少', () => {
    const m0 = computeLayout(A4.w, A4.h, CUN1.w, CUN1.h, 0, 2);
    const m20 = computeLayout(A4.w, A4.h, CUN1.w, CUN1.h, 20, 2);
    expect(m0.perSheet).toBeGreaterThan(m20.perSheet);
  });
});

describe('computeLayout 边界', () => {
  it('照片尺寸 ≥ 可用区 → 降级 1×1，不返回 0', () => {
    expect(computeLayout(A4.w, A4.h, 300, 400, 5, 2)).toEqual({ cols: 1, rows: 1, perSheet: 1 });
  });

  it('照片刚好等于可用区 → 1×1', () => {
    // usableW=200, usableH=287，照片 200×287：cols=floor(202/202)=1
    expect(computeLayout(A4.w, A4.h, 200, 287, 5, 2)).toEqual({ cols: 1, rows: 1, perSheet: 1 });
  });

  it('边距吃掉整张纸（可用区为负）→ 仍 1×1', () => {
    expect(computeLayout(A4.w, A4.h, CUN1.w, CUN1.h, 200, 2)).toEqual({ cols: 1, rows: 1, perSheet: 1 });
  });

  it('gap=0 且整除时密排', () => {
    // 纸 100×100、照片 25×25、边距 0、gap 0 → 4×4
    expect(computeLayout(100, 100, 25, 25, 0, 0)).toEqual({ cols: 4, rows: 4, perSheet: 16 });
  });

  it('横向纸（R6）排横版证件', () => {
    const r6 = PAPER_SIZES.find((p) => p.id === 'r6')!;
    // R6 127×89.3，驾照 22×32 横放即 32×22：usable 117×79.3
    // cols=floor(119/34)=3; rows=floor(81.3/24)=3 → 9
    expect(computeLayout(r6.w, r6.h, 32, 22, 5, 2)).toEqual({ cols: 3, rows: 3, perSheet: 9 });
  });
});

describe('computeLayout 异常输入', () => {
  it('照片尺寸为 0 → 1×1 不抛', () => {
    expect(computeLayout(A4.w, A4.h, 0, 35, 5, 2)).toEqual({ cols: 1, rows: 1, perSheet: 1 });
  });

  it('照片尺寸为负 → 1×1 不抛', () => {
    expect(computeLayout(A4.w, A4.h, -25, 35, 5, 2)).toEqual({ cols: 1, rows: 1, perSheet: 1 });
  });

  it('NaN 尺寸 → 按轴降级，不抛', () => {
    // 纸宽 NaN → 该轴 0 化 → 1 列；纸高正常 → 7 行（按轴降级优于整体 1×1）
    expect(computeLayout(Number.NaN, A4.h, CUN1.w, CUN1.h, 5, 2)).toEqual({ cols: 1, rows: 7, perSheet: 7 });
    // 边距/间隙 NaN → 边距按 0、间隙按 0
    expect(computeLayout(A4.w, A4.h, CUN1.w, CUN1.h, Number.NaN, Number.NaN)).toEqual({ cols: 8, rows: 8, perSheet: 64 });
  });

  it('Infinity 纸尺寸 → 该轴降级，不抛', () => {
    expect(computeLayout(Number.POSITIVE_INFINITY, A4.h, CUN1.w, CUN1.h, 5, 2)).toEqual({
      cols: 1,
      rows: 7,
      perSheet: 7,
    });
  });

  it('负 gap 按 0 处理', () => {
    expect(computeLayout(A4.w, A4.h, CUN1.w, CUN1.h, 5, -5)).toEqual({ cols: 8, rows: 8, perSheet: 64 });
  });
});

describe('coverSrcRect', () => {
  it('宽原图裁左右居中', () => {
    // 1000×500 (2:1) 填入 100×100 (1:1)：裁出居中 500×500
    expect(coverSrcRect(1000, 500, 100, 100)).toEqual({ sx: 250, sy: 0, sw: 500, sh: 500 });
  });

  it('高原图裁上下居中', () => {
    // 500×1000 (1:2) 填入 100×100：裁出居中 500×500
    expect(coverSrcRect(500, 1000, 100, 100)).toEqual({ sx: 0, sy: 250, sw: 500, sh: 500 });
  });

  it('比例一致 → 整图不裁', () => {
    expect(coverSrcRect(200, 100, 100, 50)).toEqual({ sx: 0, sy: 0, sw: 200, sh: 100 });
    expect(coverSrcRect(100, 100, 300, 300)).toEqual({ sx: 0, sy: 0, sw: 100, sh: 100 });
  });

  it('裁切矩形与目标同比例（不畸变）', () => {
    const r = coverSrcRect(1600, 900, 295, 413); // 16:9 图填入 1 寸竖向
    expect(r.sw / r.sh).toBeCloseTo(295 / 413, 6);
    expect(r.sw).toBeLessThanOrEqual(1600);
    expect(r.sh).toBeLessThanOrEqual(900);
  });

  it('源图尺寸为 0 → 空矩形', () => {
    expect(coverSrcRect(0, 500, 100, 100)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 0 });
    expect(coverSrcRect(500, 0, 100, 100)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 0 });
  });

  it('目标尺寸非法 → 空矩形', () => {
    expect(coverSrcRect(500, 500, 0, 100)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 0 });
    expect(coverSrcRect(500, 500, Number.NaN, 100)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 0 });
  });
});

describe('预设数据完整性', () => {
  it('纸张与照片预设均为正尺寸且 id 唯一', () => {
    for (const list of [PAPER_SIZES, PHOTO_PRESETS]) {
      const ids = new Set(list.map((x) => x.id));
      expect(ids.size).toBe(list.length);
      for (const x of list) {
        expect(x.w).toBeGreaterThan(0);
        expect(x.h).toBeGreaterThan(0);
      }
    }
  });
});
