// 并发 Worker 上限规则（批量吞吐的主要杠杆）：核数 + 内存共同决定，兜底封顶 8。
// 规则本身是纯函数式的，用桩 navigator 覆盖各种机器配置，避免以后手滑改坏。
import { describe, it, expect, vi, afterEach } from 'vitest';

async function capOf(cores: number, memGB?: number): Promise<number> {
  vi.resetModules();
  const nav: Record<string, unknown> = { hardwareConcurrency: cores };
  if (memGB !== undefined) nav.deviceMemory = memGB;
  vi.stubGlobal('navigator', nav);
  const mod = await import('./mattingPool');
  return mod.MAX_MATTE;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('MAX_MATTE', () => {
  it('4 核：并发 4（与放开上限前一致，零回归）', async () => {
    expect(await capOf(4, 8)).toBe(4);
  });

  it('8 核 16G：并发 8（不再被旧的封顶 4 砍掉一半算力）', async () => {
    expect(await capOf(8, 16)).toBe(8);
  });

  it('内存不足时按内存收口：8 核 2G 不该拉 8 个会话', async () => {
    // 2G × 0.5 / 300MB ≈ 3
    expect(await capOf(8, 2)).toBe(3);
  });

  it('deviceMemory 缺失时按 8G 兜底', async () => {
    expect(await capOf(6, undefined)).toBe(6);
  });

  it('32 核也封顶 8', async () => {
    expect(await capOf(32, 64)).toBe(8);
  });

  it('永远至少 1 个（1 核 / 极小内存）', async () => {
    expect(await capOf(1, 0.25)).toBe(1);
  });
});

// ORT 线程配额：Worker 数 × 每 Worker 线程数 不能超过物理核数，否则线程互相抢核
// （实测 4 Worker × 4 线程 = 16 线程抢 4 核，单张 8.3s 退化到 34s）。
async function threadsOf(cores: number, parallel: number): Promise<number> {
  vi.resetModules();
  vi.stubGlobal('navigator', { hardwareConcurrency: cores });
  const mod = await import('./mattingPool');
  return mod.matteThreads(parallel);
}

describe('matteThreads', () => {
  it('单张（并发 1）吃满全核', async () => {
    expect(await threadsOf(4, 1)).toBe(4);
    expect(await threadsOf(8, 1)).toBe(8);
  });

  it('并发度均分核数', async () => {
    expect(await threadsOf(4, 2)).toBe(2);
    expect(await threadsOf(4, 4)).toBe(1);
    expect(await threadsOf(8, 4)).toBe(2);
  });

  it('核数少于并发度时每个 Worker 至少 1 线程（不返回 0）', async () => {
    expect(await threadsOf(2, 4)).toBe(1);
    expect(await threadsOf(1, 8)).toBe(1);
  });
});
