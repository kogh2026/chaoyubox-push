// 排障：printToPDF / print 的 pageSize + margins 组合，哪个会让 Chromium 报 Printing failed
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const HELPER = path.join(__dirname, '..', 'dist', 'printHelper.html');
app.on('window-all-closed', () => {});
setTimeout(() => app.exit(1), 120000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  await win.loadURL(pathToFileURL(HELPER).href);
  // 载体页没任务时会立刻回报 no-job，但 DOM 可用；这里自己塞一页内容
  await win.webContents.executeJavaScript(`
    document.getElementById('app').innerHTML =
      '<div style="width:400pt;height:600pt;background:#eee"><div style="font:28pt sans-serif">OK</div></div>';
  `);

  const UM = 352.7777778;
  const cases = [
    ['plain', {}],
    ['pageSize', { pageSize: { width: Math.round(595 * UM), height: Math.round(842 * UM) } }],
    ['pageSize+marginsNone', { pageSize: { width: Math.round(595 * UM), height: Math.round(842 * UM) }, margins: { marginType: 'none' } }],
    ['marginsNone', { margins: { marginType: 'none' } }],
    ['marginsZero', { pageSize: { width: Math.round(595 * UM), height: Math.round(842 * UM) }, margins: { top: 0, bottom: 0, left: 0, right: 0 } }],
  ];
  for (const [name, opt] of cases) {
    try {
      const b = await win.webContents.printToPDF({ printBackground: true, ...opt });
      console.log(name + ' OK bytes=' + b.length);
    } catch (e) {
      console.log(name + ' FAIL ' + String(e).slice(0, 90));
    }
  }
  try { win.destroy(); } catch {}
  app.exit(0);
});
