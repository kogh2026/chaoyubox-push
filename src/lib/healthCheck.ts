// 启动体检（运行环境健康度）：复用 ci_gate 的「阈值 → 三档裁决 → 总体结论」思路，
// 但领域换成桌面端的运行环境健康度。本模块是纯函数，不碰 fs / DOM，便于单测与在渲染端复用。
//
// 三档语义（与 ci_gate 的 ok/warn/fail 一一对应，只是展示成红/黄/绿）：
//   ok   = 健康（绿）  warn = 中等（黄）  fail = 严重（红）
// 总体结论 = 所有检查项里最严重的那档。
//
// 探针（HealthProbe）由主进程 health-probe IPC 采集（fs 只在主进程跑，渲染端只负责展示与决策）。
import policyData from './healthPolicy.json';

export type Severity = 'ok' | 'warn' | 'fail';

/** 单模型探测结果（主进程填） */
export interface ModelStatus {
  id: string;
  rel: string;
  label: string;
  critical: boolean;
  exists: boolean;
  bytes: number;
}

/** 主进程 health-probe 返回的「原始测量值」 */
export interface HealthProbe {
  /** 应用临时根（appTempRoot ?? 系统 temp） */
  tempRoot: string;
  /** 应用自有临时条目（chaoyu-*）体积（字节） */
  tempBytes: number;
  tempFiles: number;
  /** 应用缓存目录（chaoyu-cache）体积（字节） */
  cacheBytes: number;
  cacheFiles: number;
  /** tempRoot 所在盘可用空间（字节） */
  diskFreeBytes: number;
  /** 模型资源根目录 */
  resRoot: string;
  models: ModelStatus[];
}

export interface HealthCheckItem {
  name: string;
  label: string;
  severity: Severity;
  detail: string;
  skipped?: boolean;
}

export interface HealthReport {
  overall: Severity;
  generatedAt: string;
  probe: HealthProbe;
  items: HealthCheckItem[];
}

export const STATUS_COLOR: Record<Severity, string> = {
  ok: 'green',
  warn: 'yellow',
  fail: 'red',
};

export const STATUS_LABEL: Record<Severity, string> = {
  ok: '健康',
  warn: '注意',
  fail: '严重',
};

/** 字节 → 人类可读（自动 B/KB/MB/GB）；保持中文习惯。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function worst(a: Severity, b: Severity): Severity {
  const rank: Record<Severity, number> = { ok: 0, warn: 1, fail: 2 };
  return rank[a] >= rank[b] ? a : b;
}

export interface Policy {
  bytesInGb?: number;
  thresholds: {
    temp: { warnGb: number; failGb: number };
    cache: { warnGb: number; failGb: number };
    diskFree: { warnGb: number; failGb: number };
  };
  models?: { id: string; rel: string; label: string; critical: boolean; minBytes: number }[];
}

const POLICY = policyData as unknown as Policy;
const GB = POLICY.bytesInGb ?? 1024 ** 3;

/**
 * 把探针原始值按策略评估成红/黄/绿体检报告。
 * policy 可注入（测试用）；默认用 healthPolicy.json。
 */
export function evaluateHealth(probe: HealthProbe, policy: Policy = POLICY): HealthReport {
  const t = policy.thresholds;
  const items: HealthCheckItem[] = [];

  // 1) 临时目录体积（越大越糟）
  const tempSev: Severity =
    probe.tempBytes > t.temp.failGb * GB ? 'fail' : probe.tempBytes > t.temp.warnGb * GB ? 'warn' : 'ok';
  items.push({
    name: 'temp',
    label: '临时文件',
    severity: tempSev,
    detail: `${formatBytes(probe.tempBytes)}（${probe.tempFiles} 项）｜阈值 警告 ${t.temp.warnGb}GB / 严重 ${t.temp.failGb}GB`,
  });

  // 2) 缓存体积（越大越糟）
  const cacheSev: Severity =
    probe.cacheBytes > t.cache.failGb * GB ? 'fail' : probe.cacheBytes > t.cache.warnGb * GB ? 'warn' : 'ok';
  items.push({
    name: 'cache',
    label: '缓存占用',
    severity: cacheSev,
    detail: `${formatBytes(probe.cacheBytes)}（${probe.cacheFiles} 项）｜阈值 警告 ${t.cache.warnGb}GB / 严重 ${t.cache.failGb}GB`,
  });

  // 3) 磁盘可用空间（越小越糟，与体积反向）
  const freeSev: Severity =
    probe.diskFreeBytes < t.diskFree.failGb * GB
      ? 'fail'
      : probe.diskFreeBytes < t.diskFree.warnGb * GB
        ? 'warn'
        : 'ok';
  items.push({
    name: 'diskFree',
    label: '磁盘可用空间',
    severity: freeSev,
    detail: `${formatBytes(probe.diskFreeBytes)}（${probe.tempRoot || '-'}）｜阈值 警告 <${t.diskFree.warnGb}GB / 严重 <${t.diskFree.failGb}GB`,
  });

  // 4) 模型完整性（缺失/过小）
  const missing = probe.models.filter((m) => !m.exists || m.bytes < (policy.models?.find((p) => p.id === m.id)?.minBytes ?? 0));
  const criticalMissing = missing.filter((m) => m.critical);
  let modelSev: Severity = 'ok';
  if (criticalMissing.length > 0) modelSev = 'fail';
  else if (missing.length > 0) modelSev = 'warn';
  items.push({
    name: 'models',
    label: '模型完整性',
    severity: modelSev,
    detail:
      missing.length === 0
        ? `全部 ${probe.models.length} 个模型就绪`
        : `缺失/异常 ${missing.length} 个：${missing.map((m) => m.label).join('、')}`,
  });

  const overall = items
    .filter((i) => !i.skipped)
    .reduce<Severity>((acc, i) => worst(acc, i.severity), 'ok');

  return {
    overall,
    generatedAt: new Date().toISOString(),
    probe,
    items,
  };
}
