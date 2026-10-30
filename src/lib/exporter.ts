// 统一导出出口（方案 C：tmp + rename 原子写盘）。
//
// 之前所有 UI 各自 `URL.createObjectURL + <a download>`，由 Chromium 下载管理器落盘：
// 半截文件的风险它已经用 .crdownload 兜住了，但带来三个解决不了的问题——
//   1) 磁盘满 / 目标被占用 / 杀软拦截时界面早已显示「导出成功」，用户其实没拿到文件；
//   2) 拿不到最终路径，无法「打开所在文件夹」；
//   3) 批量导出只能一个个弹保存框（图文店一次出几十份完全不同）。
// 本模块把「导出到磁盘」收敛成一个入口：桌面端走主进程 showSaveDialog → write tmp → fsync → rename，
// 浏览器预览 / 无桥接时回退到原来的 <a download>，两种环境行为都不丢。

/** 单文件导出结果 */
export interface SaveOutcome {
  ok: boolean;
  /** 最终落盘绝对路径（桌面端）；浏览器回退时为文件名 */
  path?: string;
  /** 面向用户的中文错误提示 */
  error?: string;
  /** 机器可读错误码：cancelled / enospc / ebusy / eacces / erofs / enoent / unknown */
  code?: string;
  /** true 表示走的是浏览器下载兜底，结果不可验证 */
  fallback?: boolean;
}

/** 批量导出的一份文件 */
export interface ExportItem {
  name: string;
  data: Uint8Array | ArrayBuffer;
}

export interface BatchProgress {
  done: number;
  total: number;
  current?: string;
}

export interface BatchOutcome {
  ok: boolean;
  /** 实际写入目录；用户取消时为 null */
  dir: string | null;
  saved: { name: string; path: string }[];
  failed: { name: string; error: string; code?: string }[];
  cancelled?: boolean;
  fallback?: boolean;
}

export interface SaveOpts {
  /**
   * 目标目录；给了就静默写入，不弹对话框（批量由主进程选目录，此字段保留给将来的「导出到固定目录」能力，
   * 目前尚无调用方）。注意：走这条路径时不会询问覆盖，调用方需自行确认语义。
   */
  dir?: string;
  /** 单文件对话框的默认目录 / 默认文件名 */
  defaultDir?: string;
  /** 另存为对话框的文件类型过滤器 */
  filters?: { name: string; extensions: string[] }[];
}

/* ============================ 纯函数：文件名净化 ============================ */

// Windows 文件名非法字符（POSIX 只禁 '/' 和 NUL，但跨端一致性按最严处理）
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
// Windows 保留设备名（con、prn、aux、nul、com1-9、lpt1-9），单独用作文件名会被静默丢弃
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * 净化文件名：去非法字符与控制字符、处理保留名、避免首尾空格/点、限制长度。
 * 图文店的文件名常带客户名里的 / : * 等符号，不净化会直接写盘失败。
 * 保留扩展名，长度超限只截断主干。
 */
export function sanitizeFileName(raw: string, maxLen = 120): string {
  const input = String(raw ?? '');
  const dot = input.lastIndexOf('.');
  let stem = dot > 0 ? input.slice(0, dot) : input;
  let ext = dot > 0 ? input.slice(dot) : '';

  const clean = (s: string) =>
    s
      .replace(CONTROL_CHARS, '')
      .replace(ILLEGAL_CHARS, '_')
      .replace(/\s+/g, ' ')
      .trim();

  stem = clean(stem);
  ext = clean(ext).replace(/\.+$/, '');
  if (ext && ext.length > 16) ext = ext.slice(0, 16); // 异常长扩展名多半是被污染的输入

  if (RESERVED_NAME.test(stem)) stem = `_${stem}`;
  stem = stem.replace(/^\.+/, ''); // 点开头（隐藏文件）统一剥掉

  const stemMax = Math.max(1, maxLen - ext.length);
  if (stem.length > stemMax) stem = stem.slice(0, stemMax);
  stem = stem.replace(/[\s.]+$/, ''); // 截断后可能留下尾随空白/点
  if (!stem) stem = '未命名';
  return stem + ext;
}

/**
 * 同名冲突时追加序号：证件照 (1).jpg、证件照 (2).jpg …
 * taken 用小写集合比较（Windows/NTFS 大小写不敏感）。
 */
export function dedupeName(taken: Iterable<string>, name: string): string {
  const seen = new Set<string>();
  for (const t of taken) seen.add(String(t).toLowerCase());
  if (!seen.has(name.toLowerCase())) return name;

  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 9999; i++) {
    const cand = `${stem} (${i})${ext}`;
    if (!seen.has(cand.toLowerCase())) return cand;
  }
  return `${stem} (${Date.now()})${ext}`;
}

/**
 * 批量导出前的排产：净化每个文件名，并在「本批次内」去重。
 * 纯函数，不碰磁盘 —— 同名（例如 5 张照片都叫「证件照_张三.jpg」）不会互相覆盖。
 */
export function planBatchTargets(items: readonly ExportItem[]): ExportItem[] {
  const taken: string[] = [];
  return items.map((it) => {
    const clean = sanitizeFileName(it.name);
    const final = dedupeName(taken, clean);
    taken.push(final);
    return { name: final, data: it.data };
  });
}

/* ============================ Electron 桥接探测 ============================ */

interface SaveFileArgs {
  data: Uint8Array | ArrayBuffer;
  name: string;
  dir?: string;
  defaultDir?: string;
  filters?: { name: string; extensions: string[] }[];
}

interface SaveFilesArgs {
  dir?: string;
  defaultDir?: string;
  files: ExportItem[];
}

interface ElectronExportAPI {
  saveFile?: (a: SaveFileArgs) => Promise<SaveOutcome>;
  saveFiles?: (a: SaveFilesArgs) => Promise<BatchOutcome>;
  pickSaveDir?: (a?: { defaultDir?: string }) => Promise<{ dir: string | null; cancelled?: boolean }>;
  openPath?: (p: string) => Promise<{ ok: boolean }>;
  /** 批量写盘进度订阅，返回退订函数 */
  onExportProgress?: (handler: (p: BatchProgress) => void) => () => void;
  isElectron?: boolean;
}

function api(): ElectronExportAPI | undefined {
  return typeof window !== 'undefined'
    ? (window as unknown as { electronAPI?: ElectronExportAPI }).electronAPI
    : undefined;
}

/** 是否具备「主进程原子写盘」能力（仅桌面版）；决定了走 C 还是回退浏览器下载 */
export function canSaveToDisk(): boolean {
  return typeof api()?.saveFile === 'function';
}

/* ============================ 浏览器回退 ============================ */

function fallbackDownload(blob: Blob, name: string): SaveOutcome {
  if (typeof document === 'undefined') return { ok: false, error: '当前环境不支持保存文件', code: 'unknown' };
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { ok: true, fallback: true, path: name };
}

function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function blobOf(data: Uint8Array | ArrayBuffer, type = 'application/octet-stream'): Blob {
  return new Blob([toBytes(data) as BlobPart], { type });
}

/**
 * 用户在设置里指定的默认导出目录。
 * 作为对话框的起始位置（而非强制静默写入）—— 用户仍可临时改名或换位置，
 * 但连续导出不用每次重新导航。设置项 exportRememberDir / exportDir 之前是死字段，这里首次生效。
 */
async function preferredDir(): Promise<string | undefined> {
  try {
    const { loadSettings } = await import('./appSettings');
    const s = loadSettings();
    return s.exportRememberDir && s.exportDir ? s.exportDir : undefined;
  } catch {
    return undefined; // 设置不可用时不该挡住导出
  }
}

/** 合并调用方指定目录与用户默认目录（调用方优先） */
async function dirOpts(opts: SaveOpts): Promise<SaveOpts> {
  if (opts.dir || opts.defaultDir) return opts;
  const d = await preferredDir();
  return d ? { ...opts, defaultDir: d } : opts;
}

/**
 * 只挑 IPC 可接受的字段交给桥接层 —— **永远不要 `{ ...opts }` 直接展开调用方的对象**。
 *
 * 踩过的真坑（2026-10-29，用户报「50 张导出失败：An object could not be cloned.」）：
 * `saveBatch` 的 opts 类型是 `SaveOpts & { onProgress }`，调用方自然会把 `onProgress`
 * （一个函数）传进来；`dirOpts(opts)` 原样返回后 `{ files, ...opts }` 展开，
 * **函数就进了 `ipcRenderer.invoke` 的参数**。V8 的结构化克隆遇到函数直接抛
 * DataCloneError，整批导出一份都没写出去。
 *
 * 为什么测试没抓到：`verify:export` 与浏览器回退路径都跑在没有 `electronAPI` 的环境，
 * 根本不经过 IPC，所以「带函数过桥」这件事只有真机才会炸。
 *
 * 因此这里改成显式白名单：新增 SaveOpts 字段时必须同步加进来，漏了就是「静默不生效」，
 * 比「整批失败」好定位得多。
 */
function ipcArgs(opts: SaveOpts): SaveOpts {
  const out: SaveOpts = {};
  if (typeof opts.dir === 'string' && opts.dir) out.dir = opts.dir;
  if (typeof opts.defaultDir === 'string' && opts.defaultDir) out.defaultDir = opts.defaultDir;
  if (Array.isArray(opts.filters) && opts.filters.length) {
    // 过滤器也要重建：调用方可能传了带方法的对象
    out.filters = opts.filters.map((f) => ({
      name: String(f && f.name),
      extensions: (Array.isArray(f && f.extensions) ? f.extensions : []).map(String),
    }));
  }
  return out;
}

/* ============================ 单文件导出 ============================ */

/**
 * 导出字节数据。桌面端走主进程原子写（带另存为对话框，除非给了 dir 静默写），
 * 否则回退浏览器下载。
 */
export async function saveBytes(
  data: Uint8Array | ArrayBuffer,
  name: string,
  opts: SaveOpts = {},
): Promise<SaveOutcome> {
  const clean = sanitizeFileName(name);
  const fn = api()?.saveFile;
  if (fn) {
    try {
      const merged = await dirOpts(opts);
      return await fn({ data: toBytes(data), name: clean, ...ipcArgs(merged) });
    } catch (e) {
      // 桥接异常（IPC 断开等）不阻断用户，退回浏览器下载
      return fallbackDownload(blobOf(data, mimeGuess(clean)), clean);
    }
  }
  return fallbackDownload(blobOf(data, mimeGuess(clean)), clean);
}

/** 导出 Blob */
export async function saveBlob(blob: Blob, name: string, opts: SaveOpts = {}): Promise<SaveOutcome> {
  const clean = sanitizeFileName(name);
  const fn = api()?.saveFile;
  if (fn) {
    try {
      const merged = await dirOpts(opts);
      return await fn({ data: new Uint8Array(await blob.arrayBuffer()), name: clean, ...ipcArgs(merged) });
    } catch {
      return fallbackDownload(blob, clean);
    }
  }
  return fallbackDownload(blob, clean);
}

/**
 * Blob / dataURL → Uint8Array。画布导出（CardLayout 整页位图）要把结果交给主进程写盘，
 * 必须先变成字节；这里统一处理，避免每个调用点各写一套 base64 解析。
 */
export async function bytesOf(source: Blob | string): Promise<Uint8Array> {
  if (source instanceof Blob) return new Uint8Array(await source.arrayBuffer());
  const text = String(source ?? '');
  if (typeof fetch === 'function') {
    const r = await fetch(text);
    return new Uint8Array(await r.arrayBuffer());
  }
  // 无 fetch 的环境：手工 base64 解码
  const comma = text.indexOf(',');
  const b64 = comma >= 0 ? text.slice(comma + 1) : text;
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  throw new Error('当前环境无法把 dataURL 转成字节');
}

/**
 * 导出 dataURL（CardLayout 的整页位图 / 单页 JPG 走这条）。
 * 优先取字节走主进程原子写；取不到字节则统一回退到 fallbackDownload，
 * 由它统一处理「<a> 必须先入 DOM」这件事 —— 之前这里漏了 appendChild，
 * Firefox 下不在文档中的元素是不触发下载的。
 */
export async function saveDataUrl(dataUrl: string, name: string, opts: SaveOpts = {}): Promise<SaveOutcome> {
  const clean = sanitizeFileName(name);
  // dataURL → 字节只算一次：主进程写盘和浏览器兜底用的是同一份
  let bytes: Uint8Array | null = null;
  try {
    bytes = await bytesOf(dataUrl);
  } catch {
    bytes = null;
  }

  const fn = api()?.saveFile;
  if (fn && bytes) {
    try {
      return await saveBytes(bytes, clean, opts);
    } catch {
      /* 桥接异常：落到下面的浏览器下载 */
    }
  }
  if (bytes) return fallbackDownload(blobOf(bytes, mimeGuess(clean)), clean);

  // 连字节都拆不出来（既无 fetch 也无 atob 的极端环境）：最后直接把 dataURL 挂到 anchor 上试
  if (typeof document === 'undefined') return { ok: false, error: '当前环境不支持保存文件', code: 'unknown' };
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = clean;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return { ok: true, fallback: true, path: clean };
}

/* ============================ 批量导出 ============================ */

/**
 * 批量导出：只弹一次「选择目录」对话框，之后并发原子写入该目录。
 * 单个文件失败不影响其余；返回每份的成功/失败明细便于汇总提示。
 * 写盘并发由主进程控制（同目录 IO 并发过高反而降速，超过收益），这里只做编排。
 */
export async function saveBatch(
  items: readonly ExportItem[],
  opts: SaveOpts & { onProgress?: (p: BatchProgress) => void } = {},
): Promise<BatchOutcome> {
  const planned = planBatchTargets(items);
  const empty: BatchOutcome = { ok: true, dir: null, saved: [], failed: [] };
  if (planned.length === 0) return empty;

  const bridge = api();
  if (typeof bridge?.saveFiles !== 'function') {
    // 浏览器回退：必须错开触发，同一 tick 内多次 click 会被浏览器合并成一次下载
    const saved: { name: string; path: string }[] = [];
    for (const it of planned) {
      saved.push({ name: it.name, path: it.name });
      fallbackDownload(blobOf(it.data, mimeGuess(it.name)), it.name);
      opts.onProgress?.({ done: saved.length, total: planned.length, current: it.name });
      await sleep(300);
    }
    return { ok: true, dir: null, saved, failed: [], fallback: true };
  }

  // 主进程会按写盘进度逐条推 export:progress，这里订阅并转发给调用方做进度显示
  const unsubscribe =
    typeof bridge?.onExportProgress === 'function' && opts.onProgress
      ? bridge.onExportProgress((p) => opts.onProgress?.(p))
      : null;
  try {
    // 注意 `ipcArgs`：opts 里可能带 `onProgress`（函数），直接展开过桥会抛 DataCloneError
    const res = await bridge!.saveFiles({ files: planned, ...ipcArgs(await dirOpts(opts)) });
    return res && typeof res === 'object' ? res : empty;
  } finally {
    unsubscribe?.(); // 不订阅的话 ipcRenderer 监听器会一直挂着
  }
}

/* ============================ 打开所在目录 ============================ */
export async function revealPath(p: string): Promise<boolean> {
  const fn = api()?.openPath;
  if (!fn || !p) return false;
  try {
    const r = await fn(p);
    return !!r?.ok;
  } catch {
    return false;
  }
}

/**
 * 导出成功后按用户设置决定是否打开所在文件夹。
 * 设置项 exportOpenFolder / exportRememberDir 之前是死字段（没人读），这里首次生效。
 * 失败静默：打开资源管理器只是锦上添花，不该反过来打扰用户。
 *
 * @param fallback 走浏览器下载兜底时传 true —— 此时 target 只是文件名而非真实路径，
 *                 openPath 必然失败，不如干脆别调。之前四个调用点漏了这一判断。
 */
export async function revealIfWanted(target: string | undefined, fallback = false): Promise<void> {
  if (!target || fallback) return;
  try {
    const { loadSettings } = await import('./appSettings');
    if (loadSettings().exportOpenFolder) await revealPath(target);
  } catch {
    /* 设置读取失败或打开失败都不影响导出结果 */
  }
}

/** 弹出「选择保存目录」对话框（设置页的默认导出目录用） */
export async function pickSaveDir(defaultDir?: string): Promise<string | null> {
  const fn = api()?.pickSaveDir;
  if (!fn) return null;
  try {
    const r = await fn({ defaultDir });
    return r?.dir ?? null;
  } catch {
    return null;
  }
}

/* ============================ 内部工具 ============================ */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const EXT_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
};

function mimeGuess(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'application/octet-stream';
  return EXT_MIME[name.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

/** 把 SaveOutcome 变成一句可直接展示给用户的话 */
export function outcomeMessage(o: SaveOutcome, fallbackOk = '已开始下载'): string {
  if (o.ok) return o.fallback ? fallbackOk : `已保存到 ${o.path ?? ''}`;
  return o.error || '保存失败';
}

/** 把 BatchOutcome 汇总成一句统计话 */
export function batchMessage(b: BatchOutcome): string {
  const n = b.saved.length;
  const bad = b.failed.length;
  if (b.cancelled) return '已取消保存';
  if (b.fallback) return `已开始下载 ${n} 个文件`;
  let s = `已保存 ${n} 个文件到 ${b.dir ?? ''}`;
  if (bad > 0) s += `，${bad} 个失败`;
  return s;
}
