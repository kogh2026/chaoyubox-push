/** 配置原子写 + 备份回退（C6）测试：自带内存版 localStorage 桩，不依赖浏览器环境。 */
import { beforeEach, describe, expect, it } from 'vitest';
import { atomicGet, atomicSet, backupKey } from './atomicStorage';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();
});

describe('atomicStorage', () => {
  it('backupKey：主 key 加 .bak 后缀', () => {
    expect(backupKey('a.b')).toBe('a.b.bak');
  });

  it('写入后可原样读回', () => {
    atomicSet('k', JSON.stringify({ a: 1 }));
    expect(atomicGet('k')).toBe(JSON.stringify({ a: 1 }));
  });

  it('第二次写入会把上一版存入 .bak', () => {
    atomicSet('k', '{"v":1}');
    expect(localStorage.getItem(backupKey('k'))).toBeNull(); // 首次无旧值，不备份

    atomicSet('k', '{"v":2}');
    expect(localStorage.getItem(backupKey('k'))).toBe('{"v":1}');
    expect(atomicGet('k')).toBe('{"v":2}');
  });

  it('核心：主 key 是非法 JSON → 回退备份（备份=上一版）', () => {
    atomicSet('k', '{"v":1}'); // 首次写入，无旧值可备份
    atomicSet('k', '{"v":2}'); // 此时 .bak = {"v":1}
    localStorage.setItem('k', '{broken'); // 模拟写入中断/数据损坏
    expect(atomicGet('k')).toBe('{"v":1}'); // 回退到上一版而非默认
  });

  it('主 key 与备份都不可用 → 返回 null（调用方回落默认）', () => {
    localStorage.setItem('k', '{broken');
    localStorage.setItem(backupKey('k'), 'also broken');
    expect(atomicGet('k')).toBeNull();
  });

  it('未写入过 → 返回 null', () => {
    expect(atomicGet('nope')).toBeNull();
  });
});
