import { beforeEach, describe, expect, it } from 'vitest';
import {
  CURRENT_OPTIONS_SCHEMA,
  clearPhotoOptions,
  isDefaultPhotoOptions,
  loadPhotoOptions,
  normalizePhotoOptions,
  savePhotoOptions,
  toPersisted,
} from './idphotoOptionsStorage';
import { DEFAULT_PHOTO_OPTIONS, type PhotoOptions } from './idphotoOptions';
import { backupKey } from './atomicStorage';

/** 内存版 localStorage 桩（node 环境无浏览器存储） */
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
  /** 测试用：直接塞原始串（模拟脏数据/旧版本存档） */
  seed(k: string, v: string): void {
    this.m.set(k, v);
  }
  keys(): string[] {
    return [...this.m.keys()];
  }
}

const KEY = 'chaoyu.idphoto.options.v1';

let store: MemStorage;

beforeEach(() => {
  store = new MemStorage();
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = store;
});

const custom = (): PhotoOptions => ({
  ...DEFAULT_PHOTO_OPTIONS,
  exportSizeIds: [...DEFAULT_PHOTO_OPTIONS.exportSizeIds],
  presetId: '2cun',
  bgId: 'blue',
  paperId: 'six',
  gapMm: 4,
  defringeOn: false,
  beautyLevel: 'refined',
});

describe('normalizePhotoOptions —— 脏数据不许越过字段边界', () => {
  it('非对象 / null / 数组 → 全默认', () => {
    for (const raw of [null, undefined, 42, 'x', [], true]) {
      expect(normalizePhotoOptions(raw)).toEqual(DEFAULT_PHOTO_OPTIONS);
    }
  });

  it('未知 id（规格被删除 / 版本回退）→ 回落该字段默认，不留给下游去猜', () => {
    const o = normalizePhotoOptions({ presetId: 'no-such-size', paperId: 'b5', bgId: 'green' });
    expect(o.presetId).toBe('1cun');
    expect(o.paperId).toBe('r6');
    expect(o.bgId).toBe('white');
  });

  it('数值越界 → 钳到滑杆区间（而非丢弃整条存档）', () => {
    const o = normalizePhotoOptions({
      fillScale: 9,
      edgeThreshold: -3,
      advSmooth: 999,
      brightness: -999,
      gapMm: 40,
    });
    expect(o.fillScale).toBe(1.35); // BOTTOM_FILL_HARD_MAX
    expect(o.edgeThreshold).toBe(0);
    expect(o.advSmooth).toBe(100);
    expect(o.brightness).toBe(-50);
    expect(o.gapMm).toBe(10);
  });

  it('非有限数（NaN/Infinity/字符串）→ 回落默认而非钳制', () => {
    const o = normalizePhotoOptions({ fillScale: NaN, brightness: Infinity, gapMm: '3' });
    expect(o.fillScale).toBe(DEFAULT_PHOTO_OPTIONS.fillScale);
    expect(o.brightness).toBe(DEFAULT_PHOTO_OPTIONS.brightness);
    expect(o.gapMm).toBe(DEFAULT_PHOTO_OPTIONS.gapMm);
  });

  it('非法枚举 → 默认（引擎/构图模式/美颜/排版方式各一例）', () => {
    const o = normalizePhotoOptions({
      engine: 'super',
      specMode: 'zzz',
      beautyLevel: 'max',
      whitenLevel: 'white',
      sheetMode: 'both',
    });
    expect(o.engine).toBe('modnet'); // 默认已改为「快速」
    expect(o.specMode).toBe('default');
    expect(o.beautyLevel).toBe('natural');
    expect(o.whitenLevel).toBe('natural');
    expect(o.sheetMode).toBe('multi');
  });

  it('booleans 只认真布尔（"true"/1 一律回落，避免 JSON 手改出隐形真值）', () => {
    const o = normalizePhotoOptions({ defringeOn: 'true', monoOn: 1, batchAutoFrame: null });
    expect(o.defringeOn).toBe(DEFAULT_PHOTO_OPTIONS.defringeOn);
    expect(o.monoOn).toBe(DEFAULT_PHOTO_OPTIONS.monoOn);
    expect(o.batchAutoFrame).toBe(DEFAULT_PHOTO_OPTIONS.batchAutoFrame);
  });

  it('自定义底色只认 #RRGGBB', () => {
    expect(normalizePhotoOptions({ customHex: '#1a2B3c' }).customHex).toBe('#1a2B3c');
    expect(normalizePhotoOptions({ customHex: 'blue' }).customHex).toBe('#ffffff');
    expect(normalizePhotoOptions({ customHex: '#fff' }).customHex).toBe('#ffffff');
  });

  it('未知字段被丢弃（存档里塞什么都不影响结果结构）', () => {
    const o = normalizePhotoOptions({ nonsense: 1, tab: 'sheet' });
    expect(Object.keys(o).sort()).toEqual(Object.keys(DEFAULT_PHOTO_OPTIONS).sort());
  });
});

describe('exportSizeIds 刻意不落盘', () => {
  it('toPersisted 里没有该字段', () => {
    expect('exportSizeIds' in toPersisted(custom())).toBe(false);
  });

  it('存档串里不含该键', () => {
    savePhotoOptions(custom());
    expect(store.getItem(KEY)).not.toContain('exportSizeIds');
  });

  it('读回恒为「只导出当前规格」——上次勾的 7 个规格不会被继承', () => {
    store.seed(
      KEY,
      JSON.stringify({ presetId: '2cun', exportSizeIds: ['1cun', '2cun', 'passport', 'drive'] }),
    );
    expect(loadPhotoOptions().exportSizeIds).toEqual(['2cun']);
  });
});

describe('load / save / clear', () => {
  it('无存档 → 默认（且是独立副本，不与模块常量共享引用）', () => {
    const a = loadPhotoOptions();
    expect(a).toEqual(DEFAULT_PHOTO_OPTIONS);
    expect(a.exportSizeIds).not.toBe(DEFAULT_PHOTO_OPTIONS.exportSizeIds);
  });

  it('存 → 读往返一致（exportSizeIds 归位为当前规格）', () => {
    savePhotoOptions(custom());
    expect(loadPhotoOptions()).toEqual({ ...custom(), exportSizeIds: ['2cun'] });
  });

  it('写入带 schemaVersion，便于将来迁移', () => {
    savePhotoOptions(custom());
    expect(JSON.parse(store.getItem(KEY)!).schemaVersion).toBe(CURRENT_OPTIONS_SCHEMA);
  });

  it('主 key 损坏 → 自动用上一版备份（atomicStorage 的回退链）', () => {
    savePhotoOptions(custom()); // 第一版内容进入 value
    savePhotoOptions({ ...custom(), gapMm: 1 }); // 上一版被备份
    store.seed(KEY, '{broken'); // 模拟写入中断
    expect(loadPhotoOptions().gapMm).toBe(4); // 备份里是上一版
  });

  it('主 key 与备份都坏 → 默认，不抛错', () => {
    store.seed(KEY, '{broken');
    store.seed(backupKey(KEY), 'also broken');
    expect(() => loadPhotoOptions()).not.toThrow();
    expect(loadPhotoOptions()).toEqual(DEFAULT_PHOTO_OPTIONS);
  });

  it('clear 同时清掉主 key 与备份', () => {
    savePhotoOptions(custom());
    savePhotoOptions({ ...custom(), gapMm: 1 });
    expect(store.keys().length).toBe(2);
    clearPhotoOptions();
    expect(store.keys()).toEqual([]);
  });
});

/**
 * 存档迁移 v1 → v2（2026-10-29）。
 *
 * 产品把「抠图质量」默认值从精细 ISNet 改成快速 MODNet，并强调「去边缘」默认开。
 * 只改 `DEFAULT_PHOTO_OPTIONS` 是**不够**的：老用户存档里存着 `engine: 'isnet'`，
 * 读回时会原样盖掉新默认 —— 表现就是「代码改了、装上新版还是精细」。
 * 这一组用例锁住「升级时这两项一次性归位、其他偏好不动」。
 */
describe('存档迁移 v1 → v2', () => {
  const v1 = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ schemaVersion: 1, engine: 'isnet', defringeOn: false, ...extra });

  it('v1 存档：engine 归位到「快速」、defringeOn 归位到「开」', () => {
    store.seed(KEY, v1());
    const o = loadPhotoOptions();
    expect(o.engine).toBe('modnet');
    expect(o.defringeOn).toBe(true);
  });

  it('v1 存档：只动这两项，其他用户偏好原样保留', () => {
    store.seed(
      KEY,
      v1({ presetId: '2cun', bgId: 'blue', paperId: 'six', gapMm: 4, beautyLevel: 'refined' }),
    );
    const o = loadPhotoOptions();
    expect(o.presetId).toBe('2cun');
    expect(o.bgId).toBe('blue');
    expect(o.paperId).toBe('six');
    expect(o.gapMm).toBe(4);
    expect(o.beautyLevel).toBe('refined');
  });

  it('迁移结果立刻写回：schemaVersion 升到 2，避免每次启动重跑迁移', () => {
    store.seed(KEY, v1());
    loadPhotoOptions();
    const saved = JSON.parse(store.getItem(KEY) as string);
    expect(saved.schemaVersion).toBe(CURRENT_OPTIONS_SCHEMA);
    expect(saved.engine).toBe('modnet');
    expect(saved.defringeOn).toBe(true);
  });

  it('缺 schemaVersion 的更老存档同样按 v1 迁移', () => {
    store.seed(KEY, JSON.stringify({ engine: 'isnet' }));
    expect(loadPhotoOptions().engine).toBe('modnet');
  });

  it('v2 存档尊重用户主动选择（用户就是要精细，不许再改回来）', () => {
    store.seed(KEY, JSON.stringify({ schemaVersion: 2, engine: 'isnet', defringeOn: false }));
    const o = loadPhotoOptions();
    expect(o.engine).toBe('isnet');
    expect(o.defringeOn).toBe(false);
  });

  it('迁移写回后存档里仍不含 exportSizeIds（不破坏约束 1）', () => {
    store.seed(KEY, v1({ exportSizeIds: ['1cun', '2cun', 'passport'] }));
    loadPhotoOptions();
    expect(store.getItem(KEY)).not.toContain('exportSizeIds');
  });
});

describe('isDefaultPhotoOptions —— 恢复默认按钮的可用性判据', () => {  it('默认对象 → true', () => {
    expect(isDefaultPhotoOptions(DEFAULT_PHOTO_OPTIONS)).toBe(true);
  });

  it('改任一落盘字段 → false', () => {
    expect(isDefaultPhotoOptions(custom())).toBe(false);
  });

  it('只改 exportSizeIds 仍算默认（它本来就不落盘）', () => {
    const o: PhotoOptions = {
      ...DEFAULT_PHOTO_OPTIONS,
      exportSizeIds: ['1cun', '2cun', 'passport'],
    };
    expect(isDefaultPhotoOptions(o)).toBe(true);
  });
});
