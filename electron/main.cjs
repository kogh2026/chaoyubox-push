// Electron 主进程：把 Web 原型包成桌面应用，并桥接"真打印" + "Office 转 PDF"
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

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

ipcMain.handle('check-office', (_e, sofficePath) => {
  const p = findSoffice(sofficePath);
  return { available: !!p, path: p };
});

ipcMain.handle('convert-office', async (_e, { files, sofficePath }) => {
  const soffice = findSoffice(sofficePath);
  if (!soffice) return { ok: false, error: 'no-soffice', results: [] };
  const outDir = path.join(app.getPath('temp'), 'chaoyu-office-out');
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const f of files) {
    try {
      await new Promise((res, rej) => {
        execFile(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', outDir, f], (err) =>
          err ? rej(err) : res(),
        );
      });
      const base = path.basename(f, path.extname(f)) + '.pdf';
      const out = path.join(outDir, base);
      results.push({ input: f, output: fs.existsSync(out) ? out : null, ok: fs.existsSync(out) });
    } catch (e) {
      results.push({ input: f, output: null, ok: false, error: String(e) });
    }
  }
  return { ok: true, results };
});

ipcMain.handle('open-path', async (_e, p) => {
  try {
    await shell.openPath(p);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 开发态走 vite dev server；否则加载打包后的 dist
  const dev = process.env.CHAOYU_DEV === '1';
  if (dev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // 外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 内嵌 PDF 工具箱（iframe）的下载：弹「另存为」让用户选位置。
  // 只拦来自 pdf-toolbox iframe 的下载（webContents URL 含 pdf-toolbox），
  // 主应用自己的导出（a.download）保持默认行为，直接存系统下载目录。
  win.webContents.session.on('will-download', (event, item, wc) => {
    let from = '';
    try {
      from = wc && wc.getURL ? wc.getURL() : '';
    } catch {
      /* frame 已分离时 getURL 抛错，按非工具箱下载放行 */
    }
    if (!from.includes('pdf-toolbox')) return;
    event.preventDefault();
    dialog
      .showSaveDialog(win, {
        title: '保存文件',
        defaultPath: path.join(app.getPath('downloads'), item.getFilename()),
      })
      .then(({ canceled, filePath }) => {
        if (canceled || !filePath) {
          item.cancel();
          return;
        }
        item.setSavePath(filePath);
      })
      .catch(() => item.cancel());
  });
}

app.whenReady().then(() => {
  createWindow();

  // 真打印：调用系统打印机。grayscale -> color:false；份数/双面透传给驱动
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

  // 枚举已安装打印机
  ipcMain.handle('list-printers', async () => {
    try {
      const w = BrowserWindow.getFocusedWindow();
      if (!w) return [];
      return await w.webContents.getPrintersAsync();
    } catch {
      return [];
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
