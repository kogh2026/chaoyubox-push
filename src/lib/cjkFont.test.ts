/** 中文字体健壮化（C8）纯函数测试：候选排序 + CJK 文本判定。 */
import { describe, expect, it } from 'vitest';
import { hasCjkText, rankFontPaths } from './cjkFont';

describe('rankFontPaths', () => {
  it('.ttf/.otf 排在 .ttc 集合前面（pdf-lib 不能嵌入 TTC）', () => {
    const ranked = rankFontPaths([
      'C:/Windows/Fonts/msyh.ttc',
      'C:/Windows/Fonts/simhei.ttf',
      'C:/Windows/Fonts/Deng.otf',
    ]);
    expect(ranked[0]).toBe('C:/Windows/Fonts/simhei.ttf');
    expect(ranked[1]).toBe('C:/Windows/Fonts/Deng.otf');
    expect(ranked[2]).toBe('C:/Windows/Fonts/msyh.ttc');
  });

  it('稳定排序：同分保持原相对顺序', () => {
    const ranked = rankFontPaths(['a.ttf', 'b.ttf', 'c.ttc']);
    expect(ranked.slice(0, 2)).toEqual(['a.ttf', 'b.ttf']);
  });

  it('空数组 → 空数组', () => {
    expect(rankFontPaths([])).toEqual([]);
  });
});

describe('hasCjkText', () => {
  it('含中文字符 → true', () => {
    expect(hasCjkText('超誉工作台')).toBe(true);
    expect(hasCjkText('第 1 页')).toBe(true);
  });
  it('纯 ASCII → false', () => {
    expect(hasCjkText('Page 1 / 10')).toBe(false);
    expect(hasCjkText('')).toBe(false);
  });
});
