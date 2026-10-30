// 打印机枚举与「打印预设 → 真实打印选项」的映射。
// 枚举依赖 Electron 主进程的 list-printers IPC（webContents.getPrintersAsync），
// 浏览器预览环境下不可用，返回空列表由 UI 给出提示。
import { loadSettings, type AppSettings, type PrinterPreset } from './appSettings';

export interface SysPrinter {
  /** 传给 webContents.print 的 deviceName；网络打印机为 UNC 形如 \\host\printer */
  name: string;
  /** 展示名（Electron 的 displayName 可能为空，回退为 name） */
  displayName: string;
  isDefault: boolean;
}

interface ElectronPrinter {
  name?: string;
  displayName?: string;
  isDefault?: boolean;
}

interface ElectronAPI {
  listPrinters?: () => Promise<ElectronPrinter[]>;
  /** PDF 静默直出（主进程：pdf.js 栅格化拼版后送印） */
  printPdf?: (data: Uint8Array, opts: PrintOpts) => Promise<PdfPrintResult>;
  isElectron?: boolean;
}

function api(): ElectronAPI | undefined {
  return typeof window !== 'undefined'
    ? (window as unknown as { electronAPI?: ElectronAPI }).electronAPI
    : undefined;
}

export interface PdfPrintResult {
  ok: boolean;
  /** 打印系统返回的失败原因（如 cancelled / no-printer） */
  reason?: string;
  /** IPC/异常层面的错误描述 */
  error?: string;
  /** 实际送印页数 */
  pages?: number;
  /** 送印纸张尺寸（pt），取自 PDF 自带页面 */
  widthPt?: number;
  heightPt?: number;
  /** 实际栅格化分辨率 */
  dpi?: number;
  /** 文档内纸张尺寸不一致（已按首页统一，其余页留白边） */
  mixedSize?: boolean;
}

/**
 * PDF 静默直出：把 PDF 字节交给主进程，在隐藏窗口里栅格化拼版后静默送印。
 * 页面尺寸跟随 PDF 自带纸张（不需要用户在打印对话框里选纸），灰度/双面/份数/打印机沿用打印预设。
 * 非桌面环境（浏览器预览）回退 window.print() 打印当前页面。
 */
export async function printPdfBytes(bytes: Uint8Array, opts: PrintOpts): Promise<PdfPrintResult> {
  const fn = api()?.printPdf;
  if (fn) {
    try {
      const r = await fn(bytes, opts);
      // 主进程回的是机器码，这里翻成人话（各模块直接把 error 显示在状态栏）
      if (!r.ok && r.error === 'no-printer') return { ...r, error: '未检测到打印机，请先在系统中添加打印机' };
      return r;
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  if (typeof window !== 'undefined' && typeof window.print === 'function') {
    window.print();
    return { ok: true };
  }
  return { ok: false, error: 'print-unavailable' };
}

/** 是否具备打印机检测能力（仅桌面版） */
export function canListPrinters(): boolean {
  return typeof api()?.listPrinters === 'function';
}

/** 枚举系统打印机；非桌面版或调用失败时返回空数组（不抛错） */
export async function listSystemPrinters(): Promise<SysPrinter[]> {
  const fn = api()?.listPrinters;
  if (!fn) return [];
  try {
    const list = await fn();
    if (!Array.isArray(list)) return [];
    return list
      .map((p) => ({
        name: String(p?.name || ''),
        displayName: String(p?.displayName || p?.name || ''),
        isDefault: !!p?.isDefault,
      }))
      .filter((p) => p.name.length > 0);
  } catch {
    return [];
  }
}

/** 打印时生效的预设：优先第一个用户预设，否则内置的「系统默认」 */
export function activePreset(s: AppSettings): PrinterPreset {
  return s.printPresets.find((p) => !p.builtin) ?? s.printPresets[0];
}

export interface PrintOpts {
  printer?: string;
  grayscale?: boolean;
  duplex?: 'longEdge';
  copies?: number;
  /**
   * 栅格化分辨率，默认 300。小纸张（证件照、证卡拼版）可提到 400，
   * 页数多的文档会自动降档（300→250→200）以免撑爆渲染进程内存。
   */
  dpi?: number;
  /** 原文档页序对齐的灰度标记，索引 = 页码 - 1（批量打印的按页分色） */
  grayPages?: boolean[];
  /** 只打印这些页（1 起），缺省为全部（批量打印跳过「不打印」页） */
  pages?: number[];
}

/**
 * 打印预设 → Electron print 选项。
 * 'auto'（打印时选）/'ask'（打印时选）一律不传对应键，让 Windows 打印对话框去决定，
 * 避免预设把用户每次的临时选择覆盖掉。
 */
export function presetPrintOpts(s?: AppSettings): PrintOpts {
  const settings = s ?? safeLoad();
  if (!settings) return {};
  const p = activePreset(settings);
  const o: PrintOpts = {};
  if (p.printer && p.printer !== 'auto') o.printer = p.printer;
  if (p.color === 'bw') o.grayscale = true;
  else if (p.color === 'color') o.grayscale = false;
  if (p.duplex === 'duplex') o.duplex = 'longEdge';
  return o;
}

function safeLoad(): AppSettings | undefined {
  try {
    return loadSettings();
  } catch {
    return undefined;
  }
}
