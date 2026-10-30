// 配置安全写入（C6）：写入前先把上一份值备份到 <key>.bak，
// 读取时若主 key 缺失或解析失败，则回退备份。避免写入中断/数据损坏导致配置丢失。
// localStorage.setItem 本身是原子的，这里补的是「可回退的上一版」。

const SUFFIX = '.bak';

/** 备份键名 */
export function backupKey(key: string): string {
  return `${key}${SUFFIX}`;
}

/**
 * 原子写：先备份旧值再写新值。
 * 备份失败（如配额不足）不阻塞主写入——保证正常路径永远可用。
 */
export function atomicSet(key: string, value: string): void {
  try {
    const prev = localStorage.getItem(key);
    if (prev != null) localStorage.setItem(backupKey(key), prev);
  } catch {
    /* 备份失败可容忍，继续写主值 */
  }
  localStorage.setItem(key, value);
}

/**
 * 带回退的读取：主 key 可用（存在且为合法 JSON）则用它；
 * 否则尝试备份；两者都不可用返回 null（调用方回落默认值）。
 */
export function atomicGet(key: string): string | null {
  const raw = localStorage.getItem(key);
  if (raw != null && isParsable(raw)) return raw;
  const bak = localStorage.getItem(backupKey(key));
  if (bak != null && isParsable(bak)) return bak;
  return null;
}

function isParsable(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}
