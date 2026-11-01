// 有上限的 LRU 缓存：超过 maxSize 时淘汰最久未使用的条目，
// 防止「长任务（导入/合成上百张证件照）」让内存随结果数线性增长。
//
// 纯类、零 DOM / fs 依赖，可直接单测。用于 IdPhoto 的 matteCache / layerCache / frameData：
// 这些 Map 原先无上限，长时间批量处理会一直累积（每张照片一个抠图 Blob + 若干人物层）。
export class BoundedCache<K, V> {
  private map = new Map<K, V>();
  private onEvict?: (key: K, value: V) => void;

  constructor(
    public readonly maxSize: number,
    onEvict?: (key: K, value: V) => void,
  ) {
    this.onEvict = onEvict;
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    // 命中即移到末尾（最新），实现 LRU
    const v = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  /** 写入；若超上限则淘汰队首（最久未用）。返回被淘汰的 [key,value] 列表。 */
  set(key: K, value: V): [K, V][] {
    const evicted: [K, V][] = [];
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      const v = this.map.get(oldest) as V;
      this.map.delete(oldest);
      this.onEvict?.(oldest, v);
      evicted.push([oldest, v]);
    }
    return evicted;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    if (this.onEvict) for (const [k, v] of this.map) this.onEvict(k, v);
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  /** 删除所有 key 以 prefix 开头的条目（IdPhoto 按 id| 前缀清某张照片的层缓存）。 */
  deletePrefix(prefix: string): number {
    let n = 0;
    for (const k of Array.from(this.map.keys())) {
      if (String(k).startsWith(prefix)) {
        const v = this.map.get(k) as V;
        this.map.delete(k);
        this.onEvict?.(k, v);
        n += 1;
      }
    }
    return n;
  }
}
