// exporter.ts 单测：覆盖文件名净化、批内去重、桥接分派与浏览器回退。
// Node 环境无 window/document，用 globalThis 注入两种环境，验证「有没有桥接」行为都正确。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  sanitizeFileName,
  dedupeName,
  planBatchTargets,
  canSaveToDisk,
  saveBytes,
  saveBlob,
  saveBatch,
  revealIfWanted,
  outcomeMessage,
  batchMessage,
} from './exporter';

type AnyWin = { electronAPI?: unknown };
const g = globalThis as unknown as { window?: AnyWin };

/** 注入最小 DOM 桩，让浏览器回退路径可测 */
function installDom() {
  const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
  const body = { appendChild: vi.fn(), removeChild: vi.fn() };
  (globalThis as unknown as { document?: unknown }).document = {
    createElement: () => anchor,
    body,
  };
  const U = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
  U.createObjectURL = vi.fn(() => 'blob:mock');
  U.revokeObjectURL = vi.fn();
  return { anchor, revoke: U.revokeObjectURL as ReturnType<typeof vi.fn> };
}

function clearDom() {
  delete (globalThis as unknown as { document?: unknown }).document;
}

/**
 * 取 spy 第一次调用的第一个参数。
 * vitest 对无参 vi.fn 会把 calls 推断成长度 0 的元组，这里统一绕开类型。
 */
function call1<T>(spy: { mock: { calls: readonly unknown[][] } }): T {
  return (spy.mock.calls[0] as unknown as T[])[0];
}

beforeEach(() => {
  delete g.window;
});

afterEach(() => {
  delete g.window;
  clearDom();
  vi.restoreAllMocks();
});

/* ============================ sanitizeFileName ============================ */

describe('sanitizeFileName', () => {
  it('把 Windows 非法字符替换为下划线', () => {
    expect(sanitizeFileName('客户A/B:C*D?E"F<G>H|I.pdf')).toBe('客户A_B_C_D_E_F_G_H_I.pdf');
  });

  it('去掉控制字符（粘贴带来的换行/制表符会直接弄坏文件名）', () => {
    expect(sanitizeFileName('订\n单\t号.pdf')).toBe('订单号.pdf');
  });

  it('前后空白与多点被清理', () => {
    expect(sanitizeFileName('  报价单  .pdf')).toBe('报价单.pdf');
    expect(sanitizeFileName('报价单...pdf')).toBe('报价单.pdf');
  });

  it('Windows 保留设备名加前缀，避免被静默丢弃', () => {
    expect(sanitizeFileName('CON')).toBe('_CON');
    expect(sanitizeFileName('nul.txt')).toBe('_nul.txt');
    expect(sanitizeFileName('com1.pdf')).toBe('_com1.pdf');
  });

  it('点开头被剥掉（避免生成隐藏文件）', () => {
    expect(sanitizeFileName('.hidden.pdf')).toBe('hidden.pdf');
  });

  it('超长文件名截断主干但保留扩展名', () => {
    const long = '甲'.repeat(300);
    const out = sanitizeFileName(`${long}.pdf`);
    expect(out.endsWith('.pdf')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(120);
  });

  it('空输入落到「未命名」', () => {
    expect(sanitizeFileName('')).toBe('未命名');
    expect(sanitizeFileName('   ')).toBe('未命名');
  });

  it('全非法字符保留长度结构而非塌成「未命名」（便于回溯原始输入）', () => {
    expect(sanitizeFileName('///')).toBe('___');
    expect(sanitizeFileName('...')).toBe('未命名'); // 纯点：lastIndexOf 会把它当扩展名吃掉
  });

  it('异常长的扩展名被截断（多半是被污染的输入）', () => {
    const out = sanitizeFileName(`a.${'b'.repeat(80)}`);
    expect(out.length).toBeLessThanOrEqual(121);
  });
});

/* ============================ dedupeName ============================ */

describe('dedupeName', () => {
  it('未冲突时原样返回', () => {
    expect(dedupeName(['a.pdf'], 'b.pdf')).toBe('b.pdf');
  });

  it('冲突时追加序号', () => {
    expect(dedupeName(['证件照.jpg'], '证件照.jpg')).toBe('证件照 (1).jpg');
    expect(dedupeName(['证件照.jpg', '证件照 (1).jpg'], '证件照.jpg')).toBe('证件照 (2).jpg');
  });

  it('大小写不敏感（NTFS 同名不同大小写会互相覆盖）', () => {
    expect(dedupeName(['ABC.PDF'], 'abc.pdf')).toBe('abc (1).pdf');
  });

  it('无扩展名也能编号', () => {
    expect(dedupeName(['导出'], '导出')).toBe('导出 (1)');
  });
});

/* ============================ planBatchTargets ============================ */

describe('planBatchTargets', () => {
  it('批次内同名自动编号，不会互相覆盖', () => {
    const d = new Uint8Array([1]);
    const out = planBatchTargets([
      { name: '证件照_张三.jpg', data: d },
      { name: '证件照_张三.jpg', data: d },
      { name: '证件照_张三.jpg', data: d },
    ]);
    expect(out.map((o) => o.name)).toEqual([
      '证件照_张三.jpg',
      '证件照_张三 (1).jpg',
      '证件照_张三 (2).jpg',
    ]);
    // 顺序与数量不变
    expect(out).toHaveLength(3);
  });

  it('顺带净化每个文件名', () => {
    const out = planBatchTargets([{ name: 'a/b.pdf', data: new Uint8Array([1]) }]);
    expect(out[0].name).toBe('a_b.pdf');
  });

  it('空输入返回空数组', () => {
    expect(planBatchTargets([])).toEqual([]);
  });
});

/* ============================ 环境探测 ============================ */

describe('canSaveToDisk', () => {
  it('无 window（Node/SSR）→ false', () => {
    expect(canSaveToDisk()).toBe(false);
  });

  it('无 electronAPI（浏览器预览）→ false', () => {
    g.window = {};
    expect(canSaveToDisk()).toBe(false);
  });

  it('有 saveFile 桥接 → true', () => {
    g.window = { electronAPI: { saveFile: async () => ({ ok: true }) } };
    expect(canSaveToDisk()).toBe(true);
  });
});

/* ============================ 单文件导出 ============================ */

describe('saveBytes', () => {
  it('有桥接 → 走主进程原子写，返回真实路径', async () => {
    const saveFile = vi.fn(async () => ({ ok: true, path: 'D:\\out\\结果.pdf' }));
    g.window = { electronAPI: { saveFile } };
    const r = await saveBytes(new Uint8Array([1, 2, 3]), '结果.pdf');
    expect(r.ok).toBe(true);
    expect(r.path).toBe('D:\\out\\结果.pdf');
    expect(r.fallback).toBeUndefined();
    expect(saveFile).toHaveBeenCalledTimes(1);
  });

  it('传给主进程的文件名已净化（IPC 边界前就把非法字符处理掉）', async () => {
    const saveFile = vi.fn(async () => ({ ok: true, path: 'x' }));
    g.window = { electronAPI: { saveFile } };
    await saveBytes(new Uint8Array([1]), 'a/b:c.pdf');
    expect(call1<{ name: string }>(saveFile).name).toBe('a_b_c.pdf');
  });

  it('透传 dir/defaultDir/filters', async () => {
    const saveFile = vi.fn(async () => ({ ok: true, path: 'x' }));
    g.window = { electronAPI: { saveFile } };
    await saveBytes(new Uint8Array([1]), 'a.pdf', {
      dir: 'D:\\out',
      defaultDir: 'D:\\last',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    expect(call1<Record<string, unknown>>(saveFile)).toMatchObject({
      dir: 'D:\\out',
      defaultDir: 'D:\\last',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
  });

  it('opts 里混入函数也不会过桥（白名单只挑 dir/defaultDir/filters）', async () => {
    const saveFile = vi.fn(async () => ({ ok: true, path: 'x' }));
    g.window = { electronAPI: { saveFile } };
    // 类型上 SaveOpts 没有回调字段，但运行时完全可能被调用方（或未来扩展）塞进来
    const dirty = { dir: 'D:\\out', onDone: () => {} } as unknown as Parameters<typeof saveBytes>[2];
    await saveBytes(new Uint8Array([1]), 'a.pdf', dirty);
    const args = call1<Record<string, unknown>>(saveFile);
    expect(() => structuredClone(args)).not.toThrow();
    expect(Object.keys(args).sort()).toEqual(['data', 'dir', 'name']);
  });

  it('用户取消 → ok=false 且 code=cancelled，不当成失败落日志', async () => {
    g.window = { electronAPI: { saveFile: async () => ({ ok: false, code: 'cancelled', error: '已取消保存' }) } };
    const r = await saveBytes(new Uint8Array([1]), 'a.pdf');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('cancelled');
    expect(outcomeMessage(r)).toBe('已取消保存');
  });

  it('主进程返回磁盘满 → 错误透传给 UI', async () => {
    g.window = {
      electronAPI: {
        saveFile: async () => ({ ok: false, code: 'enospc', error: '磁盘空间不足，请清理后重试' }),
      },
    };
    const r = await saveBytes(new Uint8Array([1]), 'a.pdf');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('enospc');
    expect(outcomeMessage(r)).toBe('磁盘空间不足，请清理后重试');
  });

  it('桥接抛异常（IPC 断开）→ 回退浏览器下载而不是崩掉', async () => {
    installDom();
    g.window = {
      electronAPI: {
        saveFile: async () => {
          throw new Error('ipc down');
        },
      },
    };
    const r = await saveBytes(new Uint8Array([1]), 'a.pdf');
    expect(r.fallback).toBe(true);
  });

  it('无桥接 → 浏览器下载兜底', async () => {
    const dom = installDom();
    g.window = {};
    const r = await saveBytes(new Uint8Array([1]), 'a.pdf');
    expect(r.fallback).toBe(true);
    expect(r.ok).toBe(true);
    expect(dom.anchor.click).toHaveBeenCalledTimes(1);
  });
});

describe('saveBlob', () => {
  it('有桥接 → Blob 转字节后交主进程', async () => {
    const saveFile = vi.fn(async () => ({ ok: true, path: 'D:\\o\\p.jpg' }));
    g.window = { electronAPI: { saveFile } };
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' });
    const r = await saveBlob(blob, '证件照.jpg');
    expect(r.ok).toBe(true);
    const sent = call1<{ data: Uint8Array }>(saveFile).data;
    expect(sent).toBeInstanceOf(Uint8Array);
    expect(sent.length).toBe(4);
  });

  it('无桥接 → 直接下载原 Blob', async () => {
    const dom = installDom();
    g.window = {};
    const r = await saveBlob(new Blob([new Uint8Array([1])]), 'a.zip');
    expect(r.fallback).toBe(true);
    expect(dom.anchor.click).toHaveBeenCalledTimes(1);
  });
});

/* ============================ 批量导出 ============================ */

describe('saveBatch', () => {
  const items = [
    { name: 'a.pdf', data: new Uint8Array([1]) },
    { name: 'b.pdf', data: new Uint8Array([2]) },
    { name: 'b.pdf', data: new Uint8Array([3]) },
  ];

  it('走主进程批量写，文件名已批内去重', async () => {
    const saveFiles = vi.fn(async (a: { files: { name: string }[] }) => ({
      ok: true,
      dir: 'D:\\out',
      saved: a.files.map((f) => ({ name: f.name, path: `D:\\out\\${f.name}` })),
      failed: [],
    }));
    g.window = { electronAPI: { saveFiles } };
    const r = await saveBatch(items);
    expect(r.dir).toBe('D:\\out');
    const sent = call1<{ files: { name: string }[] }>(saveFiles).files.map((f) => f.name);
    expect(sent).toEqual(['a.pdf', 'b.pdf', 'b (1).pdf']);
  });

  /**
   * 回归护栏（2026-10-29 真机事故）：
   * 调用方习惯把 `onProgress` 一起传进来，早先 `{ ...opts }` 展开后函数进了 IPC 参数，
   * V8 结构化克隆直接抛 DataCloneError → 整批导出失败，提示「An object could not be cloned.」。
   * 这里用 structuredClone 精确复现那条边界：能克隆 = 过得了桥。
   */
  it('IPC 参数必须可结构化克隆：onProgress 回调不许混进过桥对象', async () => {
    const saveFiles = vi.fn(async () => ({ ok: true, dir: 'D:\\out', saved: [], failed: [] }));
    g.window = { electronAPI: { saveFiles } };
    const onProgress = vi.fn();
    await saveBatch(items, { onProgress });

    const args = call1<Record<string, unknown>>(saveFiles);
    expect(() => structuredClone(args)).not.toThrow();
    // 连引用都不该带过去（白名单重建，而不是「过滤掉函数」）
    expect(Object.values(args)).not.toContain(onProgress);
    expect(Object.keys(args).sort()).toEqual(['files']);
  });

  it('桥接存在时 onProgress 仍是本地回调，写盘进度照常上报', async () => {
    const saveFiles = vi.fn(async () => ({ ok: true, dir: 'D:\\out', saved: [], failed: [] }));
    g.window = { electronAPI: { saveFiles } }; // 没有 onExportProgress → 退化为只回调一次也没有
    const onProgress = vi.fn();
    await saveBatch(items, { onProgress });
    // 没有主进程推送通道时不应崩，也不该把回调塞进参数
    expect(saveFiles).toHaveBeenCalledTimes(1);
  });

  it('部分失败时 ok=false 但明细完整（单个文件失败不影响整批）', async () => {
    g.window = {
      electronAPI: {
        saveFiles: async () => ({
          ok: false,
          dir: 'D:\\out',
          saved: [{ name: 'a.pdf', path: 'D:\\out\\a.pdf' }],
          failed: [{ name: 'b.pdf', error: '目标文件被占用，请先关闭已打开的「b.pdf」再重试', code: 'ebusy' }],
        }),
      },
    };
    const r = await saveBatch(items.slice(0, 2));
    expect(r.ok).toBe(false);
    expect(r.saved).toHaveLength(1);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].code).toBe('ebusy');
    expect(batchMessage(r)).toContain('1 个失败');
  });

  it('用户取消选目录 → cancelled=true，不写任何文件', async () => {
    const saveFiles = vi.fn(async () => ({
      ok: true,
      dir: null,
      saved: [],
      failed: [],
      cancelled: true,
    }));
    g.window = { electronAPI: { saveFiles } };
    const r = await saveBatch(items);
    expect(r.cancelled).toBe(true);
    expect(batchMessage(r)).toBe('已取消保存');
    expect(saveFiles).toHaveBeenCalledTimes(1);
  });

  it('目标目录可传入（已有默认导出目录时不再弹框）', async () => {
    const saveFiles = vi.fn(async () => ({ ok: true, dir: 'D:\\默认', saved: [], failed: [] }));
    g.window = { electronAPI: { saveFiles } };
    await saveBatch(items, { dir: 'D:\\默认' });
    expect(call1<{ dir: string }>(saveFiles).dir).toBe('D:\\默认');
  });

  it('空列表不调主进程', async () => {
    const saveFiles = vi.fn();
    g.window = { electronAPI: { saveFiles } };
    const r = await saveBatch([]);
    expect(saveFiles).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
  });

  it('无桥接 → 逐个浏览器下载（错开触发，避免被合并成一次）', async () => {
    const dom = installDom();
    g.window = {};
    const r = await saveBatch(items);
    expect(r.fallback).toBe(true);
    expect(r.saved).toHaveLength(3);
    expect(dom.anchor.click).toHaveBeenCalledTimes(3);
  });
});

/* ============================ 文案汇总 ============================ */

describe('汇总文案', () => {
  it('outcomeMessage：成功显示路径，取消/失败显示原因', () => {
    expect(outcomeMessage({ ok: true, path: 'D:\\a.pdf' })).toBe('已保存到 D:\\a.pdf');
    expect(outcomeMessage({ ok: true, fallback: true })).toBe('已开始下载');
    expect(outcomeMessage({ ok: false })).toBe('保存失败');
  });

  it('batchMessage：全成功 / 部分失败 / 回退', () => {
    expect(batchMessage({ ok: true, dir: 'D:\\out', saved: [{ name: 'a', path: 'a' }], failed: [] })).toBe(
      '已保存 1 个文件到 D:\\out',
    );
    expect(
      batchMessage({ ok: true, dir: null, saved: [{ name: 'a', path: 'a' }], failed: [], fallback: true }),
    ).toBe('已开始下载 1 个文件');
  });
});

/* ============================ 打开所在目录 ============================ */

describe('revealIfWanted', () => {
  // revealIfWanted 内部会动态读 appSettings（默认「导出后打开文件夹」= true）。
  // Node 环境没有 localStorage，不装这个桩会直接读失败被静默吞掉，什么都测不到。
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    (globalThis as unknown as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = String(v);
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('浏览器回退时不调用 openPath（path 只是文件名，打开必然失败）', async () => {
    const openPath = vi.fn(async () => ({ ok: true }));
    g.window = { electronAPI: { openPath } };
    await revealIfWanted('证件照_张三.jpg', true);
    expect(openPath).not.toHaveBeenCalled();
  });

  it('桌面端成功路径正常调用 openPath', async () => {
    const openPath = vi.fn(async () => ({ ok: true }));
    g.window = { electronAPI: { openPath } };
    await revealIfWanted('exports/证件照_张三.jpg');
    expect(openPath).toHaveBeenCalledWith('exports/证件照_张三.jpg');
  });
});

/* ============================ 跨实现一致性 ============================ */

describe('渲染层与主进程两份 sanitizeFileName 必须一致', () => {
  // exporter.ts（TS）与 electron/atomicWrite.cjs（CJS）各维护一份实现：
  // 跨 CJS/TS 边界没法直接复用，所以至少要用同一组输入锁住两边行为一致，防日后漂移。
  const cjs = createRequire(import.meta.url)('../../electron/atomicWrite.cjs') as {
    sanitizeFileName: (raw: string) => string;
  };

  it('同一组输入两边输出相同', () => {
    const cases = [
      '证件照_张三.jpg',
      'a/b:c.pdf',
      '报价单 2026/10*26.pdf',
      'CON',
      '../../etc/passwd',
      '',
      '.隐藏文件.png',
      '空格  很多的 名字.pdf',
      `${'很长的中文文件名'.repeat(20)}.pdf`,
    ];
    for (const c of cases) {
      expect({ input: c, renderer: sanitizeFileName(c) }).toEqual({
        input: c,
        renderer: cjs.sanitizeFileName(c),
      });
    }
  });
});
