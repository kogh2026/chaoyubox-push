/* 打印机枚举与打印预设映射单测 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  listSystemPrinters,
  canListPrinters,
  activePreset,
  presetPrintOpts,
  type SysPrinter,
} from './printers';
import { defaultSettings, type AppSettings } from './appSettings';

function settingsWith(presets: AppSettings['printPresets']): AppSettings {
  return { ...defaultSettings(), printPresets: presets };
}

describe('presetPrintOpts 预设→打印选项', () => {
  const userP = {
    id: 2,
    name: '照片',
    printer: '\\\\COLD-20240125RH\\Canon LBP2900',
    paper: '6寸',
    color: 'bw' as const,
    duplex: 'duplex' as const,
    driver: 'windows',
  };

  it('固定打印机 + 黑白 + 双面 → 透传 printer/grayscale/duplex', () => {
    const o = presetPrintOpts(settingsWith([{ ...userP }]));
    expect(o).toEqual({
      printer: '\\\\COLD-20240125RH\\Canon LBP2900',
      grayscale: true,
      duplex: 'longEdge',
    });
  });

  it("printer='auto' 不带 printer 键（交给 Windows 打印对话框）", () => {
    const o = presetPrintOpts(settingsWith([{ ...userP, printer: 'auto' }]));
    expect(o.printer).toBeUndefined();
  });

  it("color='ask' / duplex='ask' / 'simplex' 不带对应键", () => {
    const o = presetPrintOpts(
      settingsWith([{ ...userP, color: 'ask', duplex: 'ask' }]),
    );
    expect(o.grayscale).toBeUndefined();
    expect(o.duplex).toBeUndefined();
    const o2 = presetPrintOpts(settingsWith([{ ...userP, color: 'color', duplex: 'simplex' }]));
    expect(o2).toEqual({ printer: userP.printer, grayscale: false });
  });

  it('无用户预设时用内置系统默认（auto/ask → 空选项）', () => {
    const o = presetPrintOpts(settingsWith(defaultSettings().printPresets));
    expect(o).toEqual({});
  });
});

describe('activePreset 取生效预设', () => {
  it('优先第一个非内置预设', () => {
    const s = settingsWith([
      ...defaultSettings().printPresets,
      { id: 5, name: 'A', printer: 'auto', paper: 'follow', color: 'ask', duplex: 'ask', driver: 'windows' },
    ]);
    expect(activePreset(s).id).toBe(5);
  });
  it('只有内置时返回内置', () => {
    const s = settingsWith(defaultSettings().printPresets);
    expect(activePreset(s).builtin).toBe(true);
  });
});

describe('listSystemPrinters 枚举', () => {
  // vitest 环境为 node，无 window；用 globalThis 模拟「无 electronAPI」与「有 API」两种态
  const g = globalThis as unknown as { window?: { electronAPI?: unknown } };

  beforeEach(() => {
    delete g.window;
  });

  it('无 electronAPI（浏览器预览）→ 空列表且 canListPrinters=false', async () => {
    expect(canListPrinters()).toBe(false);
    expect(await listSystemPrinters()).toEqual([]);
  });

  it('透传并规范化主进程返回（displayName 空→回退 name）', async () => {
    const raw = [
      { name: '\\\\COLD-20240125RH\\Canon LBP2900', displayName: '', isDefault: true },
      { name: 'Microsoft Print to PDF', displayName: 'Microsoft Print to PDF' },
      { name: '' }, // 脏数据过滤
    ];
    g.window = {
      electronAPI: { listPrinters: vi.fn(async () => raw) },
    };
    const list: SysPrinter[] = await listSystemPrinters();
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      name: '\\\\COLD-20240125RH\\Canon LBP2900',
      displayName: '\\\\COLD-20240125RH\\Canon LBP2900',
      isDefault: true,
    });
    expect(list[1].displayName).toBe('Microsoft Print to PDF');
  });

  it('IPC 抛错 → 空列表不向上抛', async () => {
    g.window = {
      electronAPI: {
        listPrinters: vi.fn(async () => {
          throw new Error('spooler down');
        }),
      },
    };
    expect(await listSystemPrinters()).toEqual([]);
  });
});
