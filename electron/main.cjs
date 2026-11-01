// Electron 主进程：把 Web 原型包成桌面应用，并桥接"真打印" + "Office 转 PDF"
const { app, BrowserWindow, ipcMain, shell, Menu, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
// 本机 Office COM 转 PDF（P2 备选路径，失败自动回退 LibreOffice）
const officeCom = require('./officeCom.cjs');

// 本地资源协议（P0-B）：把预装模型/语言包等大文件以 appres:// 提供给渲染进程。
// 必须在使用前注册特权（app ready 之前），否则 fetch / WASM 流式加载会被拦。
protocol.registerSchemesAsPrivileged([
  // 渲染层承载协议 app://：必须以 COOP/COEP 承载文档，SharedArrayBuffer 才可用，
  // onnxruntime-web（抠图/人脸）才真正跑多线程 WASM（否则退化单线程，单张约 21s）。
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      bypassCSP: true,
    },
  },
  {
    scheme: 'appres',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      bypassCSP: true,
    },
  },
]);

/** 预装资源根目录：开发态在仓库 resources/，打包后在安装目录 resources/res/ */
function appResRoot() {
  const packaged = path.join(process.resourcesPath || '', 'res');
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', 'resources');
}

// ---- 应用临时根（启动体检 + 一键清理到 D 盘） ----
// 默认用系统 temp；用户可在「维护」面板把根迁到 D 盘，持久化到 userData 小文件，
// 之后所有应用临时写盘（Office 输出、自检、缓存）都落到该盘，C 盘不再被撑爆。
const APP_TEMP_ROOT_FILE = path.join(app.getPath('userData'), 'appTempRoot.json');
const CHAOYU_PREFIX = 'chaoyu';
const CACHE_DIR_NAME = 'chaoyu-cache';

function readAppTempRoot() {
  try {
    const raw = JSON.parse(fs.readFileSync(APP_TEMP_ROOT_FILE, 'utf-8'));
    if (raw && typeof raw.root === 'string' && raw.root) return raw.root;
  } catch {
    /* 未配置或文件损坏 → 回退系统 temp */
  }
  return null;
}

function writeAppTempRoot(root) {
  try {
    fs.mkdirSync(path.dirname(APP_TEMP_ROOT_FILE), { recursive: true });
    fs.writeFileSync(APP_TEMP_ROOT_FILE, JSON.stringify({ root: root || null }), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** 应用临时根：迁到 D 盘就返回 D 盘路径，否则系统 temp */
function appTempDir() {
  const root = readAppTempRoot();
  if (root) {
    try {
      fs.mkdirSync(root, { recursive: true });
      return root;
    } catch {
      /* 迁移目标不可写 → 回退系统 temp */
    }
  }
  return app.getPath('temp');
}

/** 递归统计一个目录/文件的总字节数与条目数（不跟随符号链接） */
function measure(p) {
  let bytes = 0;
  let files = 0;
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return { bytes: st.size, files: 1 };
    const stack = [p];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const fp = path.join(dir, e.name);
        try {
          if (e.isDirectory()) {
            files += 1;
            stack.push(fp);
          } else if (e.isFile()) {
            bytes += fs.statSync(fp).size;
            files += 1;
          }
        } catch {
          /* 权限/竞态：跳过 */
        }
      }
    }
  } catch {
    /* 不存在 */
  }
  return { bytes, files };
}

/** 仅统计应用自有条目（chaoyu-* 与 chaoyu-cache），绝不碰系统 temp 里的其他程序文件 */
function measureOwnedTemp(root) {
  let bytes = 0;
  let files = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const e of entries) {
    if (!e.name.startsWith(CHAOYU_PREFIX) && e.name !== CACHE_DIR_NAME) continue;
    const r = measure(path.join(root, e.name));
    bytes += r.bytes;
    files += r.files + 1;
  }
  return { bytes, files };
}

// 模型清单（与主进程独立，避免依赖打包后不存在的 src/ JSON）：与 healthPolicy.json 的 models 同步维护。
const HEALTH_MODELS = [
  { id: 'card-correction-fp32', rel: 'card-model/card-correction-fp32.onnx', critical: true, minBytes: 40000000, label: '卡证矫正 FP32（增强识别）' },
  { id: 'ort-wasm', rel: 'ort/ort-wasm-simd-threaded.wasm', critical: true, minBytes: 10000000, label: 'onnxruntime WASM' },
  { id: 'matting', rel: 'matting-model', critical: true, minBytes: 1000000, label: '抠图模型' },
  { id: 'mediapipe', rel: 'mediapipe-vision', critical: false, minBytes: 1000000, label: '人脸关键点模型' },
  { id: 'seg', rel: 'seg-model', critical: false, minBytes: 1000000, label: '下半身分割模型' },
  { id: 'tesseract', rel: 'tesseract', critical: false, minBytes: 1000000, label: 'OCR 语言包' },
];

function diskFreeBytes(root) {
  try {
    // Node 18.19+ 全平台支持 statfsSync；老版本/异常时回退为「未知（视为充足）」
    const st = fs.statfsSync(root);
    const free = (st.bavail ?? st.bfree) * (st.bsize ?? 1);
    return Number.isFinite(free) ? free : Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** 渲染层（打包后的 dist）根目录：生产态由 app:// 协议承载（开发态走 vite dev server） */
function distRoot() {
  return path.join(__dirname, '..', 'dist');
}

/** app:// 承载的渲染层文件与预装资源的统一 MIME 表 */
const APP_MIME = {
  ...{
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.map': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.onnx': 'application/octet-stream',
    '.task': 'application/octet-stream',
    '.traineddata': 'application/octet-stream',
    '.gz': 'application/gzip',
    '.bin': 'application/octet-stream',
  },
};

// 自动更新器（E11）：惰性获取，模块缺失时不影响主流程
let updaterRef = null;
function getAutoUpdater() {
  if (updaterRef !== null) return updaterRef;
  try {
    updaterRef = require('electron-updater').autoUpdater;
  } catch {
    updaterRef = false;
  }
  return updaterRef;
}

// 定位 LibreOffice 的 soffice 可执行文件（用于 Office→PDF 转换，对应原版 aiyin-office.exe）
function findSoffice(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = [
    'soffice',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    'D:\\Program Files\\LibreOffice\\program\\soffice.exe',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
    '/opt/libreoffice/program/soffice',
  ];
  for (const c of candidates) {
    if (c === 'soffice') {
      try {
        execFile('soffice', ['--version'], { stdio: 'ignore' });
        return 'soffice';
      } catch {
        /* not in PATH */
      }
    } else if (fs.existsSync(c)) {
      return c;
    }
  }
  return null;
}

ipcMain.handle('check-office', async (_e, sofficePath) => {
  const p = findSoffice(sofficePath);
  // 顺带报告本机 Office（Word）是否可用：UI 用来提示「将用本机 Office 转换，保真更好」
  let com = false;
  try {
    com = await officeCom.comAvailable('Word.Application');
  } catch {
    com = false;
  }
  return { available: !!p || com, path: p, com };
});

ipcMain.handle('convert-office', async (_e, { files, sofficePath }) => {
  const soffice = findSoffice(sofficePath);
  const outDir = path.join(appTempDir(), 'chaoyu-office-out');
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const f of files) {
    // P2：优先本机 Office COM（保存原始排版/字体），不可用或失败自动回退 LibreOffice
    const out = path.join(outDir, path.basename(f, path.extname(f)) + '.pdf');
    let engine = 'office';
    try {
      try {
        fs.unlinkSync(out);
      } catch {
        /* 旧结果不存在 */
      }
      const com = await officeCom.convertWithCom(f, out);
      if (com.ok) {
        results.push({ input: f, output: out, ok: true, engine });
        continue;
      }
    } catch {
      /* 继续走 soffice */
    }
    if (!soffice) {
      results.push({ input: f, output: null, ok: false, engine: null, error: '未检测到本机 Office 或 LibreOffice' });
      continue;
    }
    engine = 'libreoffice';
    try {
      await new Promise((res, rej) => {
        execFile(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', outDir, f], (err) =>
          err ? rej(err) : res(),
        );
      });
      results.push({
        input: f,
        output: fs.existsSync(out) ? out : null,
        ok: fs.existsSync(out),
        engine,
      });
    } catch (e) {
      results.push({ input: f, output: null, ok: false, engine, error: String(e) });
    }
  }
  return { ok: results.some((r) => r.ok), results };
});

ipcMain.handle('open-path', async (_e, p) => {
  try {
    await shell.openPath(p);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

/* ==================== 方案 C： tmp + rename 原子写盘 ====================
 * 之前导出走 <a download>，落盘由 Chromium 下载管理器代劳：它自己用 .crdownload 过渡，
 * 半截文件的风险其实已经兜住了，但代价是三个问题无法解决——
 *   1) 磁盘满 / 目标被阅读器占用 / 杀软拦截时，UI 早已显示「导出成功」，用户拿不到文件；
 *   2) 拿不到最终路径，无法「打开所在文件夹」；
 *   3) 批量导出只能一个个弹保存框（图文店一次几十份完全没法用）。
 * 这里改为：showSaveDialog 拿目标路径 → 写同目录临时文件 → fsync → rename 替换。
 * rename 在同一分区是原子操作，所以目标路径上永远只有「旧完整文件」或「新完整文件」，
 * 不会出现写到一半的内容。
 */

// 上次保存目录（会话内记忆），让连续导出不用反复导航到同一个文件夹
let rememberedDir = '';
function rememberDir(p) {
  if (p) rememberedDir = path.dirname(p);
}

// 原子写盘核心实现（write tmp → fsync → rename）已抽到独立模块，
// 好处是这段代码可以在真实文件系统上单独验证 —— main.cjs 顶部 require('electron')，纯 Node 环境加载不了。
const {
  sanitizeFileName,
  listTaken,
  pickFreeName,
  assertInside,
  toBuffer,
  writeFileAtomic,
  translateFsError,
  ensureDiskSpace,
  pool,
} = require('./atomicWrite.cjs');

function winOf(e) {
  return (e && BrowserWindow.fromWebContents(e.sender)) || BrowserWindow.getAllWindows()[0];
}

// 单文件：弹出「另存为」对话框（传了 dir 则静默直接写），然后原子落盘
ipcMain.handle('save-file', async (e, args) => {
  const opts = args || {};
  const bytes = toBuffer(opts.data);
  const clean = sanitizeFileName(opts.name || '未命名');
  let target;
  if (opts.dir) {
    const dir = path.resolve(String(opts.dir));
    target = path.join(dir, clean);
    try {
      assertInside(dir, target);
    } catch (err) {
      return { ok: false, ...translateFsError(err, target) };
    }
  } else {
    const res = await dialog.showSaveDialog(winOf(e), {
      title: '导出文件',
      // 目录优先级：用户在设置里指定的 > 本次会话上次去过的位置 > 系统下载目录。
      // 三个对话框必须保持一致，否则设置项会时灵时不灵。
      defaultPath: path.join(opts.defaultDir || rememberedDir || app.getPath('downloads'), clean),
      buttonLabel: '保存',
      filters: Array.isArray(opts.filters) && opts.filters.length ? opts.filters : undefined,
    });
    if (res.canceled || !res.filePath) return { ok: false, code: 'cancelled', error: '已取消保存' };
    target = res.filePath;
  }
  rememberDir(target);
  try {
    await ensureDiskSpace(target, bytes.length);
    await writeFileAtomic(target, bytes);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, ...translateFsError(err, target) };
  }
});

// 批量：只弹一次「选择目录」，之后并发原子写入，返回每份明细
ipcMain.handle('save-files', async (e, args) => {
  const opts = args || {};
  const list = Array.isArray(opts.files) ? opts.files : [];
  const empty = { ok: true, dir: null, saved: [], failed: [] };
  if (list.length === 0) return empty;

  let dir = opts.dir ? path.resolve(String(opts.dir)) : null;
  if (!dir) {
    const res = await dialog.showOpenDialog(winOf(e), {
      title: `导出 ${list.length} 个文件到…`,
      properties: ['openDirectory', 'createDirectory'],
      // 同上：设置里指定的目录优先于会话记忆
      defaultPath: opts.defaultDir || rememberedDir || app.getPath('downloads'),
      buttonLabel: '保存到此处',
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) {
      return { ...empty, cancelled: true };
    }
    dir = res.filePaths[0];
  }
  rememberDir(dir);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (err) {
    return { ok: false, dir: null, saved: [], failed: [], ...translateFsError(err, dir) };
  }

  // 批量导出不覆盖已有文件（方案 A：自动顺延）：先把目录里已存在的名字登记下来。
  // 改造前由 Chromium 落盘，同名会自动变成「xx (1).pdf」；自己写了之后如果不做这一步，
  // 就是静默覆盖 —— 图文店改个参数重导一批，上一次的结果就不见了。
  // 这里刻意沿用浏览器那套「自动顺延」的习惯，用户从没表达过要覆盖。
  // taken 在 pickFreeName 里就地累加，且该函数是每个 worker 的第一条同步语句，不存在抢名竞态。
  // 整批一次算清空间，别让每份文件各自判断 —— 那样 20 份 50MB 各自「够用」，
  // 合起来可能差一大截，写到第 15 份才发现磁盘满了，前 14 份白做。
  try {
    const totalBytes = list.reduce((acc, it) => acc + toBuffer(it && it.data).length, 0);
    await ensureDiskSpace(dir, totalBytes);
  } catch (err) {
    return { ok: false, dir: null, saved: [], failed: [], ...translateFsError(err, dir) };
  }

  const taken = listTaken(dir);

  let done = 0;
  const results = await pool(list, 3, async (it) => {
    const clean = sanitizeFileName((it && it.name) || '未命名');
    const final = pickFreeName(taken, clean);
    const target = path.join(dir, final);
    try {
      assertInside(dir, target);
      const bytes = toBuffer(it && it.data);
      await ensureDiskSpace(target, bytes.length);
      await writeFileAtomic(target, bytes);
      // saved[].name 必须是磁盘上真实的名字（可能与用户传入的不同），否则 UI 显示对不上号
      return { ok: true, name: final, path: target };
    } catch (err) {
      const t = translateFsError(err, target);
      return { ok: false, name: final, error: t.error, code: t.code };
    } finally {
      done++;
      // 批量写盘可能持续数秒，推进度让 UI 有反馈（窗口已关则忽略）
      try {
        e.sender.send('export:progress', { done, total: list.length, current: final });
      } catch {
        /* 窗口已关闭 */
      }
    }
  });

  // 单文件失败不影响整批，但 ok 为 false 时 UI 要能提示「部分失败」
  const saved = results.filter((r) => r && r.ok).map((r) => ({ name: r.name, path: r.path }));
  const failed = results.filter((r) => !r || !r.ok).map((r) => ({ name: r.name, error: r.error, code: r.code }));
  return { ok: failed.length === 0, dir, saved, failed };
});

// 纯选目录：给设置页「默认导出目录」用（之前 pickFolder 只有 UI 没有实现，一直是 prompt 兜底）
ipcMain.handle('pick-save-dir', async (e, args) => {
  const opts = args || {};
  const res = await dialog.showOpenDialog(winOf(e), {
    title: '选择默认导出目录',
    properties: ['openDirectory', 'createDirectory'],
    // 同上：设置里指定的目录优先于会话记忆
    defaultPath: opts.defaultDir || rememberedDir || app.getPath('downloads'),
    buttonLabel: '选择',
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { dir: null, cancelled: true };
  return { dir: res.filePaths[0] };
});

// 枚举系统字体目录中可嵌入的 CJK 字体（.ttf/.otf 优先，.ttc 集合兜底）。
// 这样即使硬编码路径全部失效（不同 Windows 版本/精简系统），也能自动找到中文字体。
const CJK_FONT_NAME = /(simhei|simsun|simkai|simfang|deng|msyh|msjh|noto.*(sc|cjk)|sourcehan|source-han|pingfang|songti|heiti|hiragino|wqy|yahei|arialuni|mingliu|kaiu)/i;
function discoverCjkFonts() {
  const dirs = [
    process.env.WINDIR ? path.join(process.env.WINDIR, 'Fonts') : 'C:/Windows/Fonts',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts') : '',
    '/System/Library/Fonts',
    '/Library/Fonts',
    process.env.HOME ? path.join(process.env.HOME, 'Library', 'Fonts') : '',
    '/usr/share/fonts',
    '/usr/share/fonts/truetype',
  ].filter(Boolean);
  const out = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/\.(ttf|otf|ttc)$/i.test(n)) continue;
      if (!CJK_FONT_NAME.test(n)) continue;
      out.push(path.join(dir, n));
    }
  }
  const score = (p) => (/\.(ttf|otf)$/i.test(p) ? 0 : 2); // 集合格式排最后
  return out.sort((a, b) => score(a) - score(b));
}

// 读取字体文件字节（PDF 中文字体嵌入用）。先试调用方给定的候选，再自动枚举系统字体兜底。
ipcMain.handle('read-font', async (_e, paths) => {
  const given = Array.isArray(paths) ? paths : [];
  const candidates = [...given, ...discoverCjkFonts()];
  for (const p of candidates) {
    try {
      if (typeof p !== 'string' || !p) continue;
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > 32 * 1024 * 1024) continue;
      const buf = fs.readFileSync(p);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch {
      /* 候选项不存在或不可读，试下一个 */
    }
  }
  return null;
});

// 自动更新：仅在「已打包」且存在 app-update.yml（由 electron-builder publish 配置生成）时启用，
// 否则静默跳过，绝不影响正常使用。事件桥到渲染进程用于 toast 提示。
function setupAutoUpdate(win) {
  if (!app.isPackaged || !win) return;
  const updater = getAutoUpdater();
  if (!updater) return;
  const yml = path.join(process.resourcesPath || '', 'app-update.yml');
  if (!fs.existsSync(yml)) return; // 未配置更新源：不打扰用户
  try {
    const ymlText = fs.readFileSync(yml, 'utf8');
    if (/example\.com/i.test(ymlText)) return; // 占位地址：仍属未配置，跳过以免无谓网络请求
  } catch {
    /* 读不到就照常尝试 */
  }
  updater.autoDownload = true;
  updater.on('update-available', (info) => win.webContents.send('update:available', info));
  updater.on('download-progress', (p) => win.webContents.send('update:progress', p));
  updater.on('update-downloaded', (info) => win.webContents.send('update:downloaded', info));
  updater.on('error', (err) => console.warn('[update] 检查更新失败：', err && err.message));
  updater.checkForUpdatesAndNotify().catch(() => {});
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#f5f6f8',
    title: '超誉工作台',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 开发态走 vite dev server；否则走 app:// 本地协议（带 COOP/COEP，开 ORT 多线程）
  const dev = process.env.CHAOYU_DEV === '1';
  if (dev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadURL('app://local/index.html');
  }

  // 外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// 中文应用菜单：替代 Electron 默认的英文 File / Edit / View / Window
function buildAppMenu() {
  const tpl = [
    {
      label: '文件',
      submenu: [{ label: '退出', role: 'quit' }],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '删除', role: 'delete' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '查看',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: '关闭窗口', role: 'close' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

app.whenReady().then(() => {
  buildAppMenu();

  // 渲染层本地协议 app://：承载打包后的 dist，并对文档加 COOP/COEP（P0 线程改造）。
  // 只有文档带 Cross-Origin-Opener-Policy: same-origin + Cross-Origin-Embedder-Policy:
  // require-corp 时，crossOriginIsolated 才为 true，SharedArrayBuffer 才可用，
  // onnxruntime-web 才会真正跑多线程 WASM（否则单线程，单张约 21s）。
  // COEP require-corp 下跨源子资源必须带 CORP/CORS，故对 appres:// 也补 CORP 头。
  try {
    protocol.handle('app', async (req) => {
      try {
        const u = new URL(req.url);
        const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
        // 线程自检页（CHAOYU_SELFTEST_THREAD=1 时用，不进正常流程）
        if (rel === '__threadtest.html') {
          const html =
            '<!doctype html><meta charset="utf-8"><title>threadtest</title><p>ok</p>';
          return new Response(html, {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cross-Origin-Opener-Policy': 'same-origin',
              'Cross-Origin-Embedder-Policy': 'require-corp',
              'Cross-Origin-Resource-Policy': 'cross-origin',
            },
          });
        }
        const root = distRoot();
        const full = path.normalize(path.join(root, rel));
        if (!full.startsWith(path.normalize(root))) {
          return new Response('forbidden', { status: 403 });
        }
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
          return new Response('not-found', { status: 404 });
        }
        const data = fs.readFileSync(full);
        return new Response(data, {
          status: 200,
          headers: {
            'Content-Type': APP_MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Cache-Control': 'no-cache',
          },
        });
      } catch (e) {
        return new Response('bad-request: ' + String(e), { status: 400 });
      }
    });
  } catch (e) {
    console.warn('app protocol 注册失败:', e);
  }

  createWindow();

  // 本地预装资源：appres://res/<相对路径> → resources/ 下真实文件。
  // CORS + CORP 头：app:// 文档在 COEP require-corp 下仍可 fetch 模型/WASM，完全离线。
  try {
    protocol.handle('appres', async (req) => {
      try {
        const root = appResRoot();
        const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
        const full = path.normalize(path.join(root, rel));
        if (!full.startsWith(path.normalize(root))) {
          return new Response('forbidden', { status: 403 });
        }
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
          return new Response('not-found', { status: 404 });
        }
        const data = fs.readFileSync(full);
        return new Response(data, {
          status: 200,
          headers: {
            'Content-Type': APP_MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        });
      } catch (e) {
        return new Response('bad-request: ' + String(e), { status: 400 });
      }
    });
  } catch (e) {
    console.warn('appres protocol 注册失败（将回退 CDN 下载模型）:', e);
  }

  setupAutoUpdate(BrowserWindow.getAllWindows()[0]);
  // 用户点击「立即重启更新」时调用
  ipcMain.handle('update:install', () => {
    const u = getAutoUpdater();
    if (u && u.quitAndInstall) {
      u.quitAndInstall(false, true);
      return { ok: true };
    }
    return { ok: false };
  });

  // 真打印（旧路径）：直接打印当前窗口 HTML —— 保留作回退（浏览器语义打印）。
  ipcMain.handle('print', (_e, opts) => {
    const w = BrowserWindow.getFocusedWindow();
    if (!w) return { ok: false, error: 'no-window' };
    const printOpts = {
      silent: false,
      printBackground: true,
      color: opts && opts.grayscale === true ? false : true,
      copies: opts && opts.copies ? opts.copies : 1,
      collate: true,
      duplex: opts && opts.duplex ? 'longEdge' : undefined,
      deviceName: opts && opts.printer ? opts.printer : undefined,
    };
    try {
      w.webContents.print(printOpts, (success, reason) => {
        if (!success) console.warn('print failed:', reason);
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  // PDF 静默直出（新打印链路）：PDF → 隐藏窗口里 pdf.js 栅格化拼版 → 静默送印。
  //
  // 为什么不再把 PDF 交给 Chromium 内置查看器打印：实测该路径打出来是白纸 ——
  // 同一份 PDF，交给 PDFium 查看器后 printToPDF 只有 819 字节（空白 A4），
  // 而同样内容用普通 HTML 承载是 12847 字节。原因是 Electron 的打印合成管线
  // 取不到 pepper 插件（PDF 查看器）里的绘制内容。所以改为自己栅格化：
  //   · 页面尺寸仍严格跟随 PDF 自带纸张（@page + print 的 pageSize）
  //   · 页级灰度在渲染侧做（canvas filter），比依赖驱动 color:false 更可控
  //   · 一份文档一次送印，不再拆子 PDF，页序不会被打印队列打乱
  let printSeq = 0;
  /** 当前待渲染的打印任务：由载体页主动来拉，避免「loadURL 完成」与「数据下发」竞态 */
  let pendingPrintJob = null;
  /** 载体页就绪回调（一次性） */
  let printHelperWaiter = null;

  function printHelperUrl() {
    const dev = process.env.CHAOYU_DEV === '1';
    if (dev) return 'http://localhost:5173/printHelper.html';
    return 'app://local/printHelper.html';
  }

  // 载体页来取任务（拉模型，天然避免时序问题）
  ipcMain.handle('print-job-pull', () => {
    if (!pendingPrintJob) return null;
    return { data: pendingPrintJob.data, opts: pendingPrintJob.opts };
  });

  // 载体页渲染完成（或失败）回报
  ipcMain.handle('print-helper-ready', (_e, info) => {
    const w = printHelperWaiter;
    if (w && !w.done) {
      w.done = true;
      w.resolve(info && typeof info === 'object' ? info : { ok: false, error: 'bad-ready' });
    }
    return true;
  });

  ipcMain.handle('print-pdf', async (_e, arg) => {
    const opts = (arg && arg.opts) || {};
    const data = arg && arg.data;
    if (!data || !data.byteLength) return { ok: false, error: 'empty-pdf' };
    printSeq += 1;
    const id = printSeq;
    let win = null;
    try {
      // 没有打印机时 Chromium 的 silent print 仍会回调成功（不报错也不打印），
      // 必须先自己探一次，否则用户会看到「已发送到打印机」却什么都没打出来
      if (!opts.printer) {
        const target = _e.sender;
        const installed = await (target && target.getPrintersAsync ? target.getPrintersAsync() : Promise.resolve([]));
        if (!installed || installed.length === 0) return { ok: false, error: 'no-printer' };
      }
      pendingPrintJob = {
        id,
        data: new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength),
        opts,
      };
      win = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.join(__dirname, 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      // 隐藏窗口默认会被降频，栅格化是多页串行任务，别让它被限速
      win.webContents.setBackgroundThrottling(false);

      const ready = new Promise((resolve) => {
        printHelperWaiter = { id, done: false, resolve };
      });
      const timer = setTimeout(() => {
        const w = printHelperWaiter;
        if (w && w.id === id && !w.done) {
          w.done = true;
          w.resolve({ ok: false, error: 'render-timeout' });
        }
      }, 180000); // 超长文档（上百页）栅格化可能超过 2 分钟，给足余量

      await win.loadURL(printHelperUrl());
      const info = await ready;
      clearTimeout(timer);

      if (!info || info.ok !== true) {
        return { ok: false, error: (info && info.error) || 'render-failed' };
      }
      // 位图解码 + 布局已在载体页里等过两帧，这里再给一帧余量
      await new Promise((r) => setTimeout(r, 120));

      // pt → µm（Electron 的 pageSize 用微米；1pt = 25400/72 µm）
      const um = (pt) => Math.max(1, Math.round(pt * 352.7777777778));
      const result = await new Promise((resolve) => {
        let settled = false;
        const done = (ok, reason) => {
          if (settled) return;
          settled = true;
          resolve({ ok, reason: ok ? undefined : String(reason) });
        };
        try {
          win.webContents.print(
            {
              silent: true,
              printBackground: true,
              // 页面尺寸/边距必须锁死：否则驱动按默认纸张 + 默认边距缩排，拼版会错位
              margins: { marginType: 'none' },
              pageSize: { width: um(info.widthPt), height: um(info.heightPt) },
              // 整份任务都是灰度时让驱动也走单色（纯 K 黑比 CMY 合成黑更实）；
              // 混合文档必须 color:true，否则彩色页会被驱动整份转灰
              color: opts.grayscale === true ? false : true,
              copies: opts.copies ? opts.copies : 1,
              collate: true,
              duplex: opts.duplex ? 'longEdge' : undefined,
              deviceName: opts.printer ? opts.printer : undefined,
            },
            (success, reason) => done(!!success, reason),
          );
          // 兜底：个别驱动不回调导致悬挂，15 秒后按已提交处理（大文档光栅化后可能排队）
          setTimeout(() => done(true, 'timeout-assumed-ok'), 15000);
        } catch (err) {
          done(false, String(err));
        }
      });
      return {
        ...result,
        pages: info.pageCount,
        widthPt: info.widthPt,
        heightPt: info.heightPt,
        dpi: info.dpi,
        mixedSize: info.mixedSize === true,
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    } finally {
      pendingPrintJob = null;
      printHelperWaiter = null;
      // 打印任务提交后立刻销毁窗口有概率中止后台打印，留一段缓冲
      if (win) {
        setTimeout(() => {
          try { win.destroy(); } catch { /* 已销毁 */ }
        }, 1200);
      }
    }
  });

  // 开机自启（E12）：把设置页开关落到系统登录项，让「开机自动启动」真正生效。
  ipcMain.handle('set-autostart', (_e, enable) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enable, openAsHidden: false });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  // 枚举已安装打印机（打印预设用）。窗口未聚焦时退到任意窗口，保证设置页也能拿到列表。
  ipcMain.handle('list-printers', async () => {
    try {
      const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!w) return [];
      return await w.webContents.getPrintersAsync();
    } catch {
      return [];
    }
  });

  // ---- 启动体检：探针采集（fs 只在主进程跑） ----
  ipcMain.handle('health-probe', async () => {
    const root = appTempDir();
    const temp = measureOwnedTemp(root);
    const cachePath = path.join(root, CACHE_DIR_NAME);
    const cache = measure(cachePath);
    const resRoot = appResRoot();
    const models = HEALTH_MODELS.map((m) => {
      const fp = path.join(resRoot, m.rel);
      let exists = false;
      let bytes = 0;
      try {
        const st = fs.statSync(fp);
        exists = true;
        bytes = st.isDirectory() ? measure(fp).bytes : st.size;
      } catch {
        exists = false;
      }
      return { id: m.id, rel: m.rel, label: m.label, critical: m.critical, exists, bytes };
    });
    return {
      tempRoot: root,
      tempBytes: temp.bytes,
      tempFiles: temp.files,
      cacheBytes: cache.bytes,
      cacheFiles: cache.files,
      diskFreeBytes: diskFreeBytes(root),
      resRoot,
      models,
    };
  });

  // ---- 启动体检：一键清理应用自有临时/缓存（只动 chaoyu-* 与 chaoyu-cache，绝不碰系统 temp 其他程序） ----
  ipcMain.handle('health-cleanup', async () => {
    const root = appTempDir();
    const removed = [];
    let freed = 0;
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return { freedBytes: 0, removed: [] };
    }
    for (const e of entries) {
      if (!e.name.startsWith(CHAOYU_PREFIX) && e.name !== CACHE_DIR_NAME) continue;
      const fp = path.join(root, e.name);
      const m = measure(fp);
      try {
        fs.rmSync(fp, { recursive: true, force: true });
        freed += m.bytes;
        removed.push({ name: e.name, bytes: m.bytes });
      } catch {
        /* 占用中（如 Office 正在写）跳过，不影响其余 */
      }
    }
    return { freedBytes: freed, removed };
  });

  // ---- 应用临时根「迁移到 D 盘」：读/写持久化小文件 ----
  ipcMain.handle('get-app-temp-root', async () => ({ root: readAppTempRoot() || '' }));
  ipcMain.handle('set-app-temp-root', async (_e, root) => {
    const r = typeof root === 'string' ? root.trim() : '';
    if (!r) {
      const ok = writeAppTempRoot('');
      return { ok, root: '', effective: appTempDir() };
    }
    // 校验：绝对路径且父目录可建
    if (!path.isAbsolute(r)) return { ok: false, error: '必须是绝对路径', root: '', effective: appTempDir() };
    try {
      fs.mkdirSync(r, { recursive: true });
    } catch {
      return { ok: false, error: '目录不可创建/写入', root: '', effective: appTempDir() };
    }
    const ok = writeAppTempRoot(r);
    return { ok, root: r, effective: appTempDir() };
  });

  // 启动自检（CHAOYU_SELFTEST_THREAD=1 时）：加载真实 app://index.html，
  // 验证 ①crossOriginIsolated 生效（线程）②React 是否挂载（无白屏）③资源加载正常。
  // 结果写临时文件后退出。仅改造验收用，正常启动不触发。
  if (process.env.CHAOYU_SELFTEST_THREAD === '1') {
    const log = path.join(appTempDir(), 'chaoyu-thread-selftest.json');
    (async () => {
      try {
        const w = new BrowserWindow({
          show: false,
          width: 1200,
          height: 820,
          webPreferences: { contextIsolation: true, nodeIntegration: false },
        });
        await w.loadURL('app://local/index.html');
        // 等 React 挂载（最多 15s）
        let mounted = null;
        for (let i = 0; i < 30; i++) {
          mounted = await w.webContents.executeJavaScript(
            'document.getElementById("root") ? document.getElementById("root").children.length : -1',
          );
          if (mounted && mounted > 0) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        const r = await w.webContents.executeJavaScript(
          '({ co: !!self.crossOriginIsolated, sba: typeof SharedArrayBuffer !== "undefined", hc: navigator.hardwareConcurrency, href: location.href })',
        );
        fs.writeFileSync(log, JSON.stringify({ ok: true, rootChildren: mounted, ...r }, null, 2));
        w.destroy();
      } catch (e) {
        fs.writeFileSync(log, JSON.stringify({ ok: false, error: String(e) }, null, 2));
      }
      app.quit();
    })();
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
