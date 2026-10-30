// 中文字体加载：pdf-lib 画中文（页码 / 水印 / 编号 / 空白页页眉）需要嵌入 TTF。
// 桌面端经 preload 桥读系统字体（C:/Windows/Fonts/simhei.ttf 等）；纯浏览器环境降级为标准字体。
// 字体字节缓存一份，按文档 embed（pdf-lib 的 font 绑定文档，无法跨文档复用）。
import { PDFDocument, PDFFont } from 'pdf-lib';

declare global {
  interface Window {
    electronAPI?: {
      readFont?: (paths: string[]) => Promise<ArrayBuffer | null>;
    };
  }
}

// 候选字体（按优先级）。TTC 集合 pdf-lib 无法嵌入，读不到会自动跳过；
// 主进程还会枚举系统字体目录自动补候选（见 electron/main.cjs discoverCjkFonts）。
const FONT_CANDIDATES = [
  'C:/Windows/Fonts/simhei.ttf', // 黑体（最稳）
  'C:/Windows/Fonts/simkai.ttf', // 楷体
  'C:/Windows/Fonts/simfang.ttf', // 仿宋
  'C:/Windows/Fonts/Deng.ttf', // 等线
  'C:/Windows/Fonts/simsunb.ttf',
  'C:/Windows/Fonts/msyh.ttc', // 雅黑（多为集合，失败自动跳过）
  '/System/Library/Fonts/STHeiti Light.ttc',
  '/System/Library/Fonts/PingFang.ttc',
  '/Library/Fonts/Songti.ttc',
];

/** 缺少中文字体时广播的事件名（供 UI 层 toast 提示，而非静默丢字） */
export const CJK_MISSING_EVENT = 'chaoyu-font-missing';

/** 字体文件偏好排序（纯函数，可单测）：.ttf/.otf 优先，.ttc 集合兜底。 */
export function rankFontPaths(paths: string[]): string[] {
  const score = (p: string) => (/\.(ttf|otf)$/i.test(p) ? 0 : /\.ttc$/i.test(p) ? 2 : 1);
  return [...paths].sort((a, b) => score(a) - score(b));
}

let bytesPromise: Promise<Uint8Array | null> | null = null;
let loadedBytes: Uint8Array | null = null;
let cjkSupported: boolean | null = null;

function readViaBridge(): Promise<Uint8Array | null> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!api?.readFont) return Promise.resolve(null);
  return api
    .readFont(FONT_CANDIDATES)
    .then((buf) => (buf ? new Uint8Array(buf) : null))
    .catch(() => null);
}

// 首次调用后才可知是否支持中文；此后同步可用
export async function ensureCjkFont(): Promise<boolean> {
  if (cjkSupported !== null) return cjkSupported;
  if (!bytesPromise) bytesPromise = readViaBridge();
  loadedBytes = await bytesPromise;
  cjkSupported = loadedBytes !== null && loadedBytes.length > 0;
  return cjkSupported;
}

export function cjkReady(): boolean {
  return cjkSupported === true;
}

export async function embedCjkFont(doc: PDFDocument): Promise<PDFFont | null> {
  if (cjkSupported === false) return null;
  if (!loadedBytes) {
    const ok = await ensureCjkFont();
    if (!ok || !loadedBytes) return null;
  }
  try {
    return await doc.embedFont(loadedBytes, { subset: true });
  } catch {
    cjkSupported = false;
    return null;
  }
}

// 文本是否含 CJK 字符（用于无中文字体时给出提示）
export function hasCjkText(s: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(s);
}

/** 明确提示「缺字体」：广播事件 + 控制台告警，避免中文静默变空白。 */
export function notifyMissingCjkFont(text: string): void {
  if (typeof console !== 'undefined') {
    console.warn('[cjkFont] 缺少中文字体，以下文本可能显示为空白：', text.slice(0, 24));
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CJK_MISSING_EVENT, { detail: { text } }));
  }
}

/**
 * 解析并嵌入中文字体；若文本含 CJK 而字体不可用，明确告警（C8：不再静默丢字）。
 * 返回 null 表示调用方需自行降级（例如改画 ASCII 或跳过该文本）。
 */
export async function resolveCjkFont(doc: PDFDocument, text = ''): Promise<PDFFont | null> {
  const font = await embedCjkFont(doc);
  if (!font && hasCjkText(text)) notifyMissingCjkFont(text);
  return font;
}
