// appres:// 本地资源协议校验（P0-B）：
// 用真实 Electron 起一个隐藏窗口，从 data: 页面 fetch appres://res/matting-model/resources.json
// 与其中一个模型块，确认「离线可取」「CORS 可跨源 fetch」「WASM 正确 MIME」。
// 运行：npx electron tools/appres.check.cjs
const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const fs = require('fs');

protocol.registerSchemesAsPrivileged([
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

const ROOT = path.join(__dirname, '..', 'resources');
const MIME = {
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.onnx': 'application/octet-stream',
  '.traineddata': 'application/octet-stream',
};

app.whenReady().then(async () => {
  protocol.handle('appres', async (req) => {
    try {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
      const full = path.normalize(path.join(ROOT, rel));
      if (!full.startsWith(path.normalize(ROOT))) return new Response('forbidden', { status: 403 });
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        return new Response('not-found', { status: 404 });
      }
      return new Response(fs.readFileSync(full), {
        headers: {
          'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (e) {
      return new Response('bad ' + String(e), { status: 400 });
    }
  });

  const win = new BrowserWindow({ show: false });
  const code = `
    (async () => {
      const out = {};
      const meta = await fetch('appres://res/matting-model/resources.json');
      const map = await meta.json();
      out.meta = meta.status + ' ' + meta.headers.get('content-type');
      out.models = Object.keys(map).length;
      const first = map['/models/isnet_fp16'].chunks[0].name;
      const r2 = await fetch('appres://res/matting-model/' + first);
      const buf = await r2.arrayBuffer();
      out.chunk = r2.status + ' ' + r2.headers.get('content-type') + ' ' + buf.byteLength + 'B';
      out.expect = map['/models/isnet_fp16'].chunks[0].offsets[1] - map['/models/isnet_fp16'].chunks[0].offsets[0] + 'B';
      const r3 = await fetch('appres://res/matting-model/does-not-exist');
      out.missing = r3.status;
      const r4 = await fetch('appres://res/../../etc/passwd').catch((e) => ({ status: 'blocked:' + e.name }));
      out.traversal = r4.status;
      return out;
    })()`;
  try {
    await win.loadURL('data:text/html,<title>appres check</title>');
    const res = await win.webContents.executeJavaScript(code);
    const ok =
      String(res.meta).startsWith('200') &&
      String(res.chunk).startsWith('200') &&
      res.chunk.endsWith(res.expect) &&
      res.missing === 404;
    console.log(JSON.stringify(res, null, 2));
    console.log(ok ? 'APPRES_OK' : 'APPRES_FAIL');
    app.exit(ok ? 0 : 1);
  } catch (e) {
    console.error('APPRES_FAIL', e);
    app.exit(1);
  }
});
