// 打印链路校验（P0-A，改造后）：验证「PDF → 栅格化拼版 → 打印引擎」这条新路径。
//
// 背景：最初把 PDF 交给 Chromium 内置 PDFium 查看器再 webContents.print()，
// 实测打出空白页（printToPDF 只有 819 字节）。这里验证替代方案是否真的成立：
//   1) 载体页能把 PDF 每页渲染成位图（含页级灰度）
//   2) 打印引擎拿到的内容非空、页数正确、纸张尺寸等于 PDF 自带尺寸
//
// 无打印机也能验：最后一步用 printToPDF 代替 print（同一个打印合成管线，只差落盘还是送spooler）。
// 运行前需先 `npm run build`（要用 dist/printHelper.html）。
// 运行：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe tools/printpdf.check.cjs
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const OUT_DIR = path.join(__dirname, '..', '.tmp');
const HELPER = path.join(__dirname, '..', 'dist', 'printHelper.html');
const OUT_PDF = path.join(OUT_DIR, 'print-check-out.pdf');

const PT2UM = 352.7777778;

/** 两页 A4：第 1 页黑字（该走灰度），第 2 页红块（必须留彩色） */
async function makeFixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([595, 842]);
  p1.drawText('PRINT-CHECK PAGE-1', { x: 60, y: 760, size: 28, font, color: rgb(0, 0, 0) });
  p1.drawText('black text on white', { x: 60, y: 700, size: 16, font, color: rgb(0.1, 0.1, 0.1) });
  const p2 = doc.addPage([595, 842]);
  p2.drawRectangle({ x: 100, y: 500, width: 300, height: 200, color: rgb(0.9, 0.05, 0.05) });
  p2.drawText('RED PAGE-2', { x: 60, y: 760, size: 28, font, color: rgb(0.9, 0.05, 0.05) });
  return new Uint8Array(await doc.save());
}

// 采样每页位图：判断是否全灰 / 是否有红像素 —— 用来验证「页级灰度」真的生效
const SAMPLE_JS = `
(async () => {
  const imgs = [...document.querySelectorAll('#app img')];
  const out = [];
  for (const im of imgs) {
    const bmp = await createImageBitmap(await (await fetch(im.src)).blob());
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let colored = 0, red = 0, n = 0;
    for (let i = 0; i < d.length; i += 4 * 37) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      n++;
      if (Math.abs(r - g) > 12 || Math.abs(g - b) > 12) colored++;
      if (r > 120 && r - g > 60 && r - b > 60) red++;
    }
    out.push({ w: bmp.width, h: bmp.height, coloredRatio: colored / n, redRatio: red / n });
  }
  return out;
})()`;

setTimeout(() => { console.error('PRINTPDF_FAIL timeout'); app.exit(1); }, 180000);
app.on('window-all-closed', () => {});

function fail(msg, extra) {
  console.log(JSON.stringify({ fail: msg, ...(extra || {}) }));
  console.log('PRINTPDF_FAIL');
  app.exit(1);
}

app.whenReady().then(async () => {
  if (!fs.existsSync(HELPER)) return fail('缺少 dist/printHelper.html，请先 npm run build', { helper: HELPER });

  const pdf = await makeFixture();

  // 按主进程的真实协议提供任务：载体页主动 printJobPull 来取
  let job = { data: pdf, opts: { dpi: 150, grayPages: [true, false] } };
  ipcMain.handle('print-job-pull', () => {
    const j = job;
    job = null;
    return j;
  });
  let readyResolve;
  const ready = new Promise((r) => (readyResolve = r));
  ipcMain.handle('print-helper-ready', (_e, info) => {
    readyResolve(info);
    return true;
  });

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (_e, _lvl, msg) => {
    if (msg) console.log('[helper] ' + String(msg).slice(0, 300));
  });

  try {
    await win.loadURL(pathToFileURL(HELPER).href);
    const info = await Promise.race([
      ready,
      new Promise((r) => setTimeout(() => r({ ok: false, error: 'ready-timeout' }), 120000)),
    ]);
    if (!info || info.ok !== true) return fail('载体页渲染失败', info);

    // 1) 位图与灰度校验
    const imgs = await win.webContents.executeJavaScript(SAMPLE_JS);
    if (imgs.length !== 2) return fail('页数不符', { pages: imgs.length });
    const [g1, g2] = imgs;
    if (g1.coloredRatio > 0.002) return fail('第 1 页声明灰度但仍有彩色像素', g1);
    if (g2.redRatio <= 0.01) return fail('第 2 页彩色丢失（红块没渲染出来）', g2);

    // 2) 打印引擎产物校验：页数 / 纸张尺寸 / 非空白
    // 注意单位：webContents.print 的 pageSize 用微米，printToPDF 用英寸（Electron 两处不一致）
    const out = await win.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: 'none' },
      pageSize: { width: info.widthPt / 72, height: info.heightPt / 72 },
    });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_PDF, out);

    const parsed = await PDFDocument.load(out);
    const pages = parsed.getPageCount();
    const box = parsed.getPage(0).getSize();
    const sizeOk = Math.abs(box.width - 595) <= 2 && Math.abs(box.height - 842) <= 2;
    // 空白页只有 800 多字节；有图像的页面必然远大于此，且带 /Subtype /Image 资源
    const hasImage = /\/Subtype\s*\/Image/.test(out.toString('latin1'));
    const contentOk = out.length > 20000 && hasImage;

    const report = {
      helper: { pages: info.pageCount, widthPt: info.widthPt, heightPt: info.heightPt, dpi: info.dpi, mixedSize: !!info.mixedSize },
      grayPage: Number(g1.coloredRatio.toFixed(4)),
      redPage: Number(g2.redRatio.toFixed(4)),
      outBytes: out.length,
      outPages: pages,
      outBox: [Math.round(box.width), Math.round(box.height)],
      sizeOk,
      contentOk,
    };
    console.log(JSON.stringify(report));
    const ok = sizeOk && contentOk && pages === 2;
    console.log(ok ? 'PRINTPDF_OK' : 'PRINTPDF_FAIL');
    app.exit(ok ? 0 : 1);
  } catch (e) {
    fail('异常', { error: String(e) });
  } finally {
    setTimeout(() => { try { win.destroy(); } catch {} }, 500);
  }
});
