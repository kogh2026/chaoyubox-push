import { describe, expect, it } from 'vitest';
import {
  evaluateHealth,
  formatBytes,
  worst,
  type HealthProbe,
  type ModelStatus,
  type Policy,
} from './healthCheck';

const GB = 1024 ** 3;

// 注入精简策略，避免依赖 healthPolicy.json 的具体阈值，测试更稳
const policy: Policy = {
  bytesInGb: GB,
  thresholds: {
    temp: { warnGb: 1, failGb: 4 },
    cache: { warnGb: 0.5, failGb: 2 },
    diskFree: { warnGb: 5, failGb: 2 },
  },
  models: [
    { id: 'm1', rel: 'm1', label: 'M1', critical: true, minBytes: 1_000_000 },
    { id: 'm2', rel: 'm2', label: 'M2', critical: false, minBytes: 1_000_000 },
  ],
};

function model(id: string, exists: boolean, bytes: number, critical: boolean, label: string): ModelStatus {
  return { id, rel: id, label, critical, exists, bytes };
}

function baseProbe(over: Partial<HealthProbe> = {}): HealthProbe {
  return {
    tempRoot: '/tmp',
    tempBytes: 0,
    tempFiles: 0,
    cacheBytes: 0,
    cacheFiles: 0,
    diskFreeBytes: 10 * GB,
    resRoot: '/res',
    models: [model('m1', true, 2_000_000, true, 'M1'), model('m2', true, 2_000_000, false, 'M2')],
    ...over,
  };
}

describe('formatBytes', () => {
  it('B/KB/MB/GB 换算', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('2 KB');
    expect(formatBytes(GB)).toBe('1.0 GB');
    expect(formatBytes(2.5 * GB)).toBe('2.5 GB');
  });
});

describe('worst', () => {
  it('取最严重的档', () => {
    expect(worst('ok', 'ok')).toBe('ok');
    expect(worst('ok', 'warn')).toBe('warn');
    expect(worst('warn', 'fail')).toBe('fail');
    expect(worst('fail', 'ok')).toBe('fail');
  });
});

describe('evaluateHealth：各维度三档裁决', () => {
  it('临时文件：<1G 绿 / 2G 黄 / 5G 红', () => {
    expect(evaluateHealth(baseProbe({ tempBytes: 0 }), policy).items.find((i) => i.name === 'temp')!.severity).toBe('ok');
    expect(evaluateHealth(baseProbe({ tempBytes: 2 * GB }), policy).items.find((i) => i.name === 'temp')!.severity).toBe('warn');
    expect(evaluateHealth(baseProbe({ tempBytes: 5 * GB }), policy).items.find((i) => i.name === 'temp')!.severity).toBe('fail');
  });

  it('缓存：<0.5G 绿 / 1G 黄 / 3G 红', () => {
    expect(evaluateHealth(baseProbe({ cacheBytes: 0 }), policy).items.find((i) => i.name === 'cache')!.severity).toBe('ok');
    expect(evaluateHealth(baseProbe({ cacheBytes: 1 * GB }), policy).items.find((i) => i.name === 'cache')!.severity).toBe('warn');
    expect(evaluateHealth(baseProbe({ cacheBytes: 3 * GB }), policy).items.find((i) => i.name === 'cache')!.severity).toBe('fail');
  });

  it('磁盘可用空间：越大越绿（<2G 红 / 3G 黄 / 10G 绿）', () => {
    expect(evaluateHealth(baseProbe({ diskFreeBytes: 1 * GB }), policy).items.find((i) => i.name === 'diskFree')!.severity).toBe('fail');
    expect(evaluateHealth(baseProbe({ diskFreeBytes: 3 * GB }), policy).items.find((i) => i.name === 'diskFree')!.severity).toBe('warn');
    expect(evaluateHealth(baseProbe({ diskFreeBytes: 10 * GB }), policy).items.find((i) => i.name === 'diskFree')!.severity).toBe('ok');
  });

  it('模型完整性：全部就绪绿 / 缺失非关键黄 / 缺失关键红', () => {
    const ok = evaluateHealth(baseProbe(), policy).items.find((i) => i.name === 'models')!;
    expect(ok.severity).toBe('ok');

    const warn = evaluateHealth(
      baseProbe({ models: [model('m1', true, 2_000_000, true, 'M1'), model('m2', false, 0, false, 'M2')] }),
      policy,
    ).items.find((i) => i.name === 'models')!;
    expect(warn.severity).toBe('warn');

    const fail = evaluateHealth(
      baseProbe({ models: [model('m1', false, 0, true, 'M1'), model('m2', true, 2_000_000, false, 'M2')] }),
      policy,
    ).items.find((i) => i.name === 'models')!;
    expect(fail.severity).toBe('fail');
  });

  it('模型体积过小也判异常（与缺失同档）', () => {
    const r = evaluateHealth(
      baseProbe({ models: [model('m1', true, 10, true, 'M1'), model('m2', true, 2_000_000, false, 'M2')] }),
      policy,
    ).items.find((i) => i.name === 'models')!;
    expect(r.severity).toBe('fail'); // 关键模型体积低于 minBytes
  });
});

describe('evaluateHealth：总体结论', () => {
  it('总体 = 所有检查项里最严重一档', () => {
    const r = evaluateHealth(baseProbe({ tempBytes: 2 * GB }), policy);
    expect(r.overall).toBe('warn');
  });
  it('任一项红则总体红', () => {
    const r = evaluateHealth(baseProbe({ tempBytes: 5 * GB, diskFreeBytes: 10 * GB }), policy);
    expect(r.overall).toBe('fail');
  });
  it('全部健康则总体绿', () => {
    const r = evaluateHealth(baseProbe(), policy);
    expect(r.overall).toBe('ok');
  });
});
