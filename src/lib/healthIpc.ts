// 渲染端健康桥：把主进程 health-probe / health-cleanup / 临时根迁移 封装成 Promise。
// 浏览器预览环境无 electronAPI → 安全回退（探针返回空、清理/迁移为 no-op），
// 保证不带桥时 UI 不崩（与 exporter 的 canSaveToDisk 同一套兜底思路）。
import type { HealthProbe } from './healthCheck';

interface HealthBridge {
  healthProbe?: () => Promise<HealthProbe>;
  healthCleanup?: () => Promise<{ freedBytes: number; removed: { name: string; bytes: number }[] }>;
  getAppTempRoot?: () => Promise<{ root: string }>;
  setAppTempRoot?: (root: string) => Promise<{ ok: boolean; root: string; effective: string; error?: string }>;
  isElectron?: boolean;
}

function bridge(): HealthBridge | undefined {
  return typeof window !== 'undefined'
    ? (window as unknown as { electronAPI?: HealthBridge }).electronAPI
    : undefined;
}

export function canHealthCheck(): boolean {
  return typeof bridge()?.healthProbe === 'function';
}

/** 采集运行环境探针；非桌面端返回 null（UI 据此隐藏体检入口）。 */
export async function probeHealth(): Promise<HealthProbe | null> {
  const fn = bridge()?.healthProbe;
  if (!fn) return null;
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** 一键清理应用自有临时/缓存；返回释放字节与明细。非桌面端返回 { freedBytes: 0, removed: [] }。 */
export async function cleanupHealth(): Promise<{ freedBytes: number; removed: { name: string; bytes: number }[] }> {
  const fn = bridge()?.healthCleanup;
  if (!fn) return { freedBytes: 0, removed: [] };
  try {
    return await fn();
  } catch {
    return { freedBytes: 0, removed: [] };
  }
}

export async function getAppTempRoot(): Promise<string> {
  const fn = bridge()?.getAppTempRoot;
  if (!fn) return '';
  try {
    return (await fn()).root || '';
  } catch {
    return '';
  }
}

export async function setAppTempRoot(root: string): Promise<{ ok: boolean; root: string; effective: string; error?: string }> {
  const fn = bridge()?.setAppTempRoot;
  if (!fn) return { ok: false, root: '', effective: '' };
  try {
    return await fn(root);
  } catch (e) {
    return { ok: false, root: '', effective: '', error: e instanceof Error ? e.message : String(e) };
  }
}
