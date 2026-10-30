// OCR 运行时校验（P1-B）：真实 Electron 里
//  ① 注册 appres:// 预装资源协议（与 main.cjs 同逻辑）
//  ② 页面（http 本地服务，等同开发态）导入 tesseract ESM 构建
//  ③ worker/core/lang 全部指向 appres://res/tesseract/，离线识别一张中文测试图
// 运行：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe tools/ocr.check.cjs
const { app, BrowserWindow, protocol } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIME = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.html': 'text/html',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.traineddata': 'application/octet-stream',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'appres', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true } },
]);

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const full = path.normalize(path.join(ROOT, rel));
  if (!full.startsWith(path.normalize(ROOT)) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404).end('nf');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
  });
  fs.createReadStream(full).pipe(res);
});

setTimeout(() => {
  console.error('OCR_FAIL timeout');
  app.exit(1);
}, 180000);

app.whenReady().then(() => {
  protocol.handle('appres', async (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
    const root = path.join(ROOT, 'resources');
    const full = path.normalize(path.join(root, rel));
    if (!full.startsWith(path.normalize(root)) || !fs.existsSync(full)) {
      return new Response('nf', { status: 404 });
    }
    return new Response(fs.readFileSync(full), {
      headers: {
        'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
      },
    });
  });

  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const win = new BrowserWindow({ show: false, webPreferences: { webSecurity: true } });
    await win.loadURL(`http://127.0.0.1:${port}/tools/blank.html`);
    const code = `
      (async () => {
        const base = 'http://127.0.0.1:${port}/';
        const mod = await import(base + 'node_modules/tesseract.js/dist/tesseract.esm.min.js');
        const Tesseract = mod.default || mod;
        const worker = await Tesseract.createWorker('chi_sim', 1, {
          workerPath: 'appres://res/tesseract/worker.min.js',
          corePath: 'appres://res/tesseract',
          langPath: 'appres://res/tesseract',
          gzip: false,
          logger: () => {},
        });
        const { data } = await worker.recognize(base + '.tmp/ocr-test.png');
        await worker.terminate();
        return { text: String(data.text || '').replace(/\\s+/g, ' ').slice(0, 80) };
      })()`;
    try {
      const r = await win.webContents.executeJavaScript(code);
      const text = r?.text || '';
      // Tesseract 会在汉字之间插空格（"中 华人 民 共 和 国"），
      // 与 cardOcr.classifyCardType 的归一化保持一致：匹配前先去掉所有空白
      const norm = text.replace(/\s+/g, '');
      const hit = ['居民身份证', '身份号码', '公民', '中华人民共和国'].filter((k) => norm.includes(k));
      const ok = hit.length >= 2;
      console.log(JSON.stringify({ text, hit }));
      console.log(ok ? 'OCR_OK' : 'OCR_FAIL');
      app.exit(ok ? 0 : 1);
    } catch (e) {
      console.error('OCR_FAIL', e);
      app.exit(1);
    } finally {
      server.close();
    }
  });
});
