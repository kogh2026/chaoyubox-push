import { useEffect, useState } from 'react';
import type { ColorMode } from './pdfAnalyze';
import type { Preset } from './quote';

/* ===== 类型 ===== */

// 打印价格表的一行（单位：元/面，双面价为双面打印时每一面的价格）
export interface PriceRow {
  paper: string; // A4 / A3 / A2 / A1 / A0
  bw1: number;
  bw2: number;
  dot1: number;
  dot2: number;
  color1: number;
  color2: number;
  ladder: { min: number; unit: number } | null; // 阶梯价：满 min 面后每面 unit 元，null=不启用
}

export interface PrinterPreset {
  id: number;
  name: string;
  builtin?: boolean; // 系统默认，不可改删
  printer: string; // 'auto'=打印时选，记住上次用的；或打印机名
  paper: string; // 'follow'=跟着拼版；或具体纸张
  color: 'ask' | ColorMode; // 打印时选 / 固定
  duplex: 'ask' | 'simplex' | 'duplex';
  driver: 'windows' | string; // 打印首选项：跟随 Windows / 说明文字
}

export interface AppSettings {
  // 通用
  theme: 'light' | 'dark' | 'system';
  zoom: number; // 100 = 100%
  autoStart: boolean;
  closeToTray: boolean;
  updateNotify: boolean;
  exportRememberDir: boolean;
  exportDir: string;
  idPhotoUseOrigName: boolean;
  exportOpenFolder: boolean;
  bpAutoDetect: boolean; // 批量打印：按文件名自动识别份数、颜色、单双面
  officeOpenAfter: boolean; // Word/PPT/Excel 转 PDF：完成后打开
  wizardDone: boolean; // 首页"开始前设置一下"向导已关闭
  // 实验功能
  labQrBarcode: boolean; // 添加宣传二维码与条码单号
  labSkinCompare: boolean; // 磨皮方式对比
  labShootCheck: boolean; // 拍摄质量检查
  // 打印价格
  dotThreshold: number; // 点彩：彩色占比低于 X% 的页按点彩
  prices: PriceRow[];
  // 打印预设
  printPresets: PrinterPreset[];
  // 店铺信息
  shopName: string;
  shopPhone: string;
  shopAddress: string;
}

const KEY = 'chaoyu.settings.v1';

export function defaultPrices(): PriceRow[] {
  return [
    { paper: 'A4', bw1: 0.5, bw2: 0.4, dot1: 0.7, dot2: 0.6, color1: 1, color2: 0.8, ladder: null },
    { paper: 'A3', bw1: 1, bw2: 0.8, dot1: 1.4, dot2: 1.2, color1: 2, color2: 1.6, ladder: null },
    { paper: 'A2', bw1: 3, bw2: 3, dot1: 4, dot2: 4, color1: 6, color2: 6, ladder: null },
    { paper: 'A1', bw1: 5, bw2: 5, dot1: 7, dot2: 7, color1: 10, color2: 10, ladder: null },
    { paper: 'A0', bw1: 10, bw2: 10, dot1: 14, dot2: 14, color1: 20, color2: 20, ladder: null },
  ];
}

export function defaultSettings(): AppSettings {
  return {
    theme: 'light',
    zoom: 100,
    autoStart: false,
    closeToTray: true,
    updateNotify: true,
    exportRememberDir: true,
    exportDir: '',
    idPhotoUseOrigName: true,
    exportOpenFolder: true,
    bpAutoDetect: true,
    officeOpenAfter: true,
    wizardDone: false,
    labQrBarcode: false,
    labSkinCompare: false,
    labShootCheck: false,
    dotThreshold: 5,
    prices: defaultPrices(),
    printPresets: [
      {
        id: 0,
        name: '系统默认',
        builtin: true,
        printer: 'auto',
        paper: 'follow',
        color: 'ask',
        duplex: 'ask',
        driver: 'windows',
      },
    ],
    shopName: '',
    shopPhone: '',
    shopAddress: '',
  };
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultSettings();
    return { ...defaultSettings(), ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
  window.dispatchEvent(new CustomEvent('chaoyu-settings', { detail: s }));
}

/** 跨组件同步的设置 hook：任意页面 saveSettings 后，其他使用方自动更新 */
export function useSettings(): [AppSettings, (patch: Partial<AppSettings>) => void] {
  const [s, setS] = useState<AppSettings>(() => loadSettings());
  useEffect(() => {
    const onChange = (e: Event) => setS((e as CustomEvent<AppSettings>).detail);
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setS(loadSettings());
    };
    window.addEventListener('chaoyu-settings', onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('chaoyu-settings', onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  const update = (patch: Partial<AppSettings>) => {
    const next = { ...s, ...patch };
    setS(next);
    saveSettings(next);
  };
  return [s, update];
}

/* ===== 价格表 → 报价引擎 Preset 的适配 ===== */

const PRICE_EPS = 1e-9;

export function priceRowOf(s: AppSettings, paper: string): PriceRow {
  return (
    s.prices.find((p) => p.paper === paper) ??
    s.prices[0] ?? { paper, bw1: 0.5, bw2: 0.4, dot1: 0.7, dot2: 0.6, color1: 1, color2: 0.8, ladder: null }
  );
}

/** 把价格表一行转成 quote() 用的 Preset（双面按每一面计价 → 双面系数 = 双面价/单面价） */
export function presetFromPriceRow(row: PriceRow): Preset {
  const factor = (d: number, s: number) => (s > PRICE_EPS ? Math.round((d / s) * 100) / 100 : 1);
  return {
    id: 0,
    name: row.paper,
    paper: row.paper,
    bwCents: Math.round(row.bw1 * 100),
    dotCents: Math.round(row.dot1 * 100),
    colorCents: Math.round(row.color1 * 100),
    duplexFactor: factor(row.bw2, row.bw1),
    ladderThreshold: row.ladder ? row.ladder.min : 0,
    ladderCents: row.ladder ? Math.round(row.ladder.unit * 100) : 0,
  };
}

/** 双面单价（用于界面展示）：双面打印时每一面的价格 */
export function duplexUnitOf(row: PriceRow, mode: ColorMode): number {
  if (mode === 'bw') return row.bw2;
  if (mode === 'dot') return row.dot2;
  return row.color2;
}

/* ===== 按文件名自动识别（批量打印） ===== */

export interface NameDetect {
  copies?: number;
  duplex?: boolean;
  forceMode?: ColorMode;
}

/** 从文件名识别 (5份)、x3、双面、彩色 等标记 */
export function detectFromName(name: string): NameDetect {
  const out: NameDetect = {};
  const mCopies = name.match(/[（(【\[]\s*(\d+)\s*份\s*[）)】\]]/) ?? name.match(/(\d+)\s*份/);
  if (mCopies) out.copies = Math.max(1, Number(mCopies[1]));
  else {
    const mx = name.match(/[xX×]\s*(\d{1,3})\b/);
    if (mx) out.copies = Math.max(1, Number(mx[1]));
  }
  if (/双面|双打/.test(name)) out.duplex = true;
  else if (/单面/.test(name)) out.duplex = false;
  if (/彩色|彩打/.test(name)) out.forceMode = 'color';
  else if (/黑白|黑打/.test(name)) out.forceMode = 'bw';
  return out;
}

/** 按点彩阈值重新归类一页的颜色（与原版规则一致） */
export function reclassify(ratio: number, dotThresholdPct: number): ColorMode {
  if (ratio < 0.0005) return 'bw'; // 几乎看不出颜色（不到 0.05%）按黑白
  if (ratio * 100 < dotThresholdPct) return 'dot'; // 只有一点彩色按点彩
  return 'color';
}
