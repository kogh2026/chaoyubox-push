import { describe, expect, it } from 'vitest';
import { BoundedCache } from './boundedCache';

describe('BoundedCache', () => {
  it('基础 get/has/set/delete', () => {
    const c = new BoundedCache<string, number>(3);
    expect(c.has('a')).toBe(false);
    expect(c.get('a')).toBeUndefined();
    c.set('a', 1);
    expect(c.has('a')).toBe(true);
    expect(c.get('a')).toBe(1);
    expect(c.size).toBe(1);
    expect(c.delete('a')).toBe(true);
    expect(c.has('a')).toBe(false);
    expect(c.delete('a')).toBe(false);
  });

  it('超过上限时淘汰最久未用（LRU）', () => {
    const c = new BoundedCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    // 访问 a 使其成为「最近使用」，b 变成最久未用
    c.get('a');
    const evicted = c.set('c', 3); // 溢出 → 淘汰 b
    expect(evicted).toEqual([['b', 2]]);
    expect(c.has('b')).toBe(false);
    expect(c.has('a')).toBe(true);
    expect(c.has('c')).toBe(true);
    expect(c.size).toBe(2);
  });

  it('重复 set 同一 key 不算新增，不触发淘汰', () => {
    const c = new BoundedCache<string, number>(2);
    c.set('a', 1);
    c.set('a', 2); // 更新，移到末尾
    const evicted = c.set('b', 3);
    expect(evicted).toEqual([]);
    expect(c.get('a')).toBe(2);
    expect(c.size).toBe(2);
  });

  it('deletePrefix 按前缀删除（人物层缓存 id| 级联）', () => {
    const c = new BoundedCache<string, number>(10);
    c.set('p1|x', 1);
    c.set('p1|y', 2);
    c.set('p10|z', 3); // 不同 id，前缀 p1| 不应命中 p10|
    const n = c.deletePrefix('p1|');
    expect(n).toBe(2);
    expect(c.has('p1|x')).toBe(false);
    expect(c.has('p1|y')).toBe(false);
    expect(c.has('p10|z')).toBe(true);
  });

  it('淘汰时触发 onEvict 回调', () => {
    const evicted: [string, number][] = [];
    const c = new BoundedCache<string, number>(2, (k, v) => evicted.push([k, v]));
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3); // 淘汰 a
    expect(evicted).toEqual([['a', 1]]);
  });

  it('clear 触发 onEvict 并清空', () => {
    const evicted: string[] = [];
    const c = new BoundedCache<string, number>(4, (k) => evicted.push(k));
    c.set('a', 1);
    c.set('b', 2);
    c.clear();
    expect(c.size).toBe(0);
    expect(evicted.sort()).toEqual(['a', 'b']);
  });
});
