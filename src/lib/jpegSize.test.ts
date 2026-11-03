/** 证件照体积约束（V4）：档位解析 + quality 二分搜索（合成编码器，不依赖浏览器） */
import { describe, expect, it, vi } from 'vitest';
import {
  PHOTO_SIZE_IDS,
  PHOTO_SIZE_PRESETS,
  findQualityForSize,
  sizeTargetName,
  sizeTargetOf,
} from './jpegSize';

const KB = 1024;

describe('sizeTargetOf / 档位表', () => {
  it('none → null（不限制）', () => {
    expect(sizeTargetOf('none')).toBeNull();
  });

  it('20~200 KB → 字节区间', () => {
    expect(sizeTargetOf('band20_200')).toEqual({ minBytes: 20 * KB, maxBytes: 200 * KB });
  });

  it('未知 id 一律当作不限制（存档被改坏也不炸）', () => {
    expect(sizeTargetOf('who-knows')).toBeNull();
    expect(sizeTargetName('who-knows')).toBe('不限制');
  });

  it('合法 id 清单与档位表一致', () => {
    expect(PHOTO_SIZE_IDS).toEqual(PHOTO_SIZE_PRESETS.map((p) => p.id));
    expect(PHOTO_SIZE_IDS).toContain('none');
  });
});

describe('findQualityForSize', () => {
  /** 合成编码器：体积随 quality 线性增长（真实 JPEG 也是单调的） */
  const linear = (perUnit: number) => (q: number) => Promise.resolve(Math.round(q * perUnit));

  it('最高质量就达标 → 直接返回 hi，只调一次编码', async () => {
    const encode = vi.fn(linear(100 * KB)); // q=0.95 → 95KB
    const r = await findQualityForSize(encode, { minBytes: 20 * KB, maxBytes: 200 * KB });
    expect(r).toEqual({ quality: 0.95, bytes: 95 * KB, fits: true });
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it('需要压缩 → 落到「不超过上限的最高质量」', async () => {
    // 1.0 quality ≈ 400KB；上限 200KB → 目标 quality ≈ 0.5
    const r = await findQualityForSize(linear(400 * KB), { minBytes: 0, maxBytes: 200 * KB });
    expect(r.fits).toBe(true);
    expect(r.bytes).toBeLessThanOrEqual(200 * KB);
    // 允许一个二分步长的余量（精度 ≈ 0.01 → 约 4KB）
    expect(r.quality).toBeGreaterThan(0.48);
    expect(r.quality).toBeLessThan(0.53);
  });

  it('最低质量仍超标 → fits:false 且交付 lo（不返回糊图之外的空文件）', async () => {
    const r = await findQualityForSize(linear(2000 * KB), { minBytes: 0, maxBytes: 100 * KB });
    expect(r.fits).toBe(false);
    expect(r.quality).toBe(0.35);
    expect(r.bytes).toBe(700 * KB); // 0.35×2000
  });

  it('选中的 quality 一定产出 ≤ 上限的字节（向下取整不会越界）', async () => {
    // 500KB/quality 时上限 200KB 对应 q≈0.4，落在默认搜索区间内
    const perUnit = 500 * KB;
    const max = 200 * KB;
    const r = await findQualityForSize(linear(perUnit), { minBytes: 0, maxBytes: max }, { iters: 9 });
    expect(Math.round(r.quality * perUnit)).toBeLessThanOrEqual(max);
    // 反向确认：再高 0.02 就该超标（说明选的是"卡着上限的最高质量"）
    expect(Math.round((r.quality + 0.02) * perUnit)).toBeGreaterThan(max);
  });

  it('自定义 lo/hi 生效（可把下限抬到 0.6 避免糊图）', async () => {
    const r = await findQualityForSize(
      linear(400 * KB),
      { minBytes: 0, maxBytes: 200 * KB },
      { lo: 0.6, hi: 0.9 },
    );
    expect(r.quality).toBeGreaterThanOrEqual(0.6);
    expect(r.quality).toBeLessThanOrEqual(0.9);
  });

  it('maxBytes 为 0/负数时不崩（用 1 字节兜底 → fits:false）', async () => {
    const r = await findQualityForSize(linear(100 * KB), { minBytes: 0, maxBytes: 0 });
    expect(r.fits).toBe(false);
    expect(Number.isFinite(r.bytes)).toBe(true);
  });

  it('quality 恒为两位小数（不会把 0.71234 写进文件名/日志）', async () => {
    const r = await findQualityForSize(linear(333 * KB), { minBytes: 0, maxBytes: 150 * KB });
    expect(r.quality).toBe(Math.round(r.quality * 100) / 100);
  });
});
