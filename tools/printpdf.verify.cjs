// 验证结论：Electron 对「已加载的 PDF 页面」做 printToPDF / print 是否会出空白页。
// A 组：直接加载 PDF 后 printToPDF（期望空白 → 说明 PDFium 打印路径不可用）
// B 组：把同一页 PDF 用 pdfjs 渲染成 canvas 的 HTML 后 printToPDF（期望有内容 → 说明栅格打印可行）
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length 44>>stream
BT /F1 24 Tf 72 760 Td (PRINT-CHECK) Tj ET
endstream
endobj
trailer<</Root 1 0 R>>
%%EOF
`;

const tmpPdf = path.join(os.tmpdir(), `chaoyu-v-${process.pid}.pdf`);
const tmpHtml = path.join(os.tmpdir(), `chaoyu-v-${process.pid}.html`);
fs.writeFileSync(tmpPdf, PDF, 'latin1');
// 一个纯 DOM 的 A4 页面：若它能打出内容，说明 printToPDF 本身正常，问题只出在 PDF 插件
fs.writeFileSync(
  tmpHtml,
  `<!doctype html><meta charset="utf-8"><style>@page{size:210mm 297mm;margin:0}html,body{margin:0}
  .p{width:210mm;height:297mm;box-sizing:border-box;padding:20mm;font:24px/1.4 sans-serif}</style>
  <div class="p"><h1>PRINT-CHECK</h1><p>dom vector content</p></div>`,
  'utf8',
);

// 销毁窗口后默认会退出 app，必须挡掉，否则脚本跑到一半就没了
app.on('window-all-closed', () => {});

setTimeout(() => { console.error('V timeout'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  const out = {};
  const mk = () => new BrowserWindow({ show: false, webPreferences: { sandbox: true, plugins: true } });

  // A 组：加载 PDF → printToPDF
  try {
    const w = mk();
    await w.loadFile(tmpPdf);
    await new Promise((r) => setTimeout(r, 900));
    const b = await w.webContents.printToPDF({ printBackground: true });
    fs.writeFileSync(path.join(os.tmpdir(), 'chaoyu-v-a.pdf'), b);
    out.a = b.length;
    w.destroy();
  } catch (e) { out.a = 'ERR ' + String(e).slice(0, 100); }

  // B 组：加载普通 HTML → printToPDF
  try {
    const w = mk();
    await w.loadFile(tmpHtml);
    await new Promise((r) => setTimeout(r, 400));
    const b = await w.webContents.printToPDF({ printBackground: true });
    fs.writeFileSync(path.join(os.tmpdir(), 'chaoyu-v-b.pdf'), b);
    out.b = b.length;
    w.destroy();
  } catch (e) { out.b = 'ERR ' + String(e).slice(0, 100); }

  // 顺便看机器上有没有打印机（决定能否做真实静默打印验证）
  try {
    const list = await BrowserWindow.getAllWindows()[0]?.webContents.getPrintersAsync?.() ?? [];
    out.printers = list.map((p) => p.name + (p.isDefault ? '*' : ''));
  } catch (e) { out.printers = 'ERR'; }

  console.log(JSON.stringify(out));
  try { fs.unlinkSync(tmpPdf); fs.unlinkSync(tmpHtml); } catch {}
  app.exit(0);
});
