// 诊断：Electron 里加载 PDF 后，查看器到底落在哪一层（主文档 / shadow DOM / OOPIF 子帧）。
// 运行：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe tools/printpdf.diag.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { tempFile } = require('./tmproot.cjs'); // 临时档落仓库 .tmp（D 盘）

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

const tmp = tempFile(`chaoyu-diag-${process.pid}.pdf`);
fs.writeFileSync(tmp, PDF, 'latin1');

setTimeout(() => {
  console.error('DIAG timeout');
  app.exit(1);
}, 60000);

const PROBE = `(() => {
  const out = {
    url: location.href,
    type: document.contentType,
    bodyChildren: document.body ? document.body.childElementCount : -1,
    bodyTag: document.body ? document.body.innerHTML.slice(0, 300) : null,
    tags: [...new Set([...document.querySelectorAll('*')].map(e => e.tagName.toLowerCase()))].slice(0, 40),
    shadowHosts: [...document.querySelectorAll('*')].filter(e => e.shadowRoot).map(e => e.tagName.toLowerCase()),
    embedTop: !!document.querySelector('embed'),
  };
  // 深挖 shadow DOM 里的 embed
  const deep = (root, depth) => {
    if (depth > 4 || !root) return null;
    const e = root.querySelector && root.querySelector('embed');
    if (e) return { depth, type: e.getAttribute('type') };
    for (const el of root.querySelectorAll ? root.querySelectorAll('*') : []) {
      if (el.shadowRoot) { const r = deep(el.shadowRoot, depth + 1); if (r) return r; }
    }
    return null;
  };
  out.embedDeep = deep(document, 0);
  return out;
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, plugins: true } });
  try {
    win.webContents.on('did-finish-load', () => console.log('[event] did-finish-load'));
    await win.loadFile(tmp);
    await new Promise((r) => setTimeout(r, 1200));

    const main = await win.webContents.executeJavaScript(PROBE);
    console.log('MAIN ' + JSON.stringify(main));

    const frames = win.webContents.mainFrame.frames;
    console.log('childFrames=' + frames.length);
    for (const f of frames) {
      console.log('  frame url=' + f.url + ' proc=' + f.processId + ' routingId=' + f.routingId);
      try {
        const r = await f.executeJavaScript(PROBE);
        console.log('  FRAME ' + JSON.stringify(r));
      } catch (e) {
        console.log('  FRAME_ERR ' + String(e).slice(0, 160));
      }
    }

    // 关键：printToPDF 走的是同一套打印合成管线，产物非空即说明 PDF 真的被渲染成可打印页面
    const pdf = await win.webContents.printToPDF({ printBackground: true });
    console.log('printToPDF bytes=' + pdf.length);
    const head = pdf.subarray(0, 8).toString('latin1');
    console.log('head=' + JSON.stringify(head) + ' hasCount=' + /\/Count\s+\d+/.test(pdf.toString('latin1')));
    console.log('DIAG_DONE');
    app.exit(0);
  } catch (e) {
    console.error('DIAG_FAIL', e);
    app.exit(1);
  } finally {
    try { win.destroy(); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
  }
});
