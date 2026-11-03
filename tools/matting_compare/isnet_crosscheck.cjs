/**
 * ISNet 交叉验证（Electron / 真浏览器）：用 @imgly 官方 JS 跑同一批图，
 * 与 compare3.py 的 Python 复现逐像素对拍。
 *
 * 为什么需要这个：compare3.py 是我们自己按 @imgly 源码写的 Python 复现。
 * 如果结论（ISNet 在证件照上偏离爱印更多）建立在复现有 bug 的基础上，就是错的。
 * 本脚本用**生产同款 @imgly JS**（同一份 dist/index.mjs、同一份 MIT 权重、同一套
 * 预处理）在真浏览器里跑，把 alpha 落盘给 Python 比对 → 结论可信。
 *
 * 运行：env -u ELECTRON_RUN_AS_NODE npx electron tools/matting_compare/isnet_crosscheck.cjs
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.json': 'application/json',
};
const ORT = '/node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs';

const JOB = process.argv.find((a) => a.startsWith('--job='));
if (!JOB) {
  console.error('missing --job=<path>');
  app.exit(1);
}
const job = JSON.parse(fs.readFileSync(JOB.slice('--job='.length), 'utf8'));

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/__q.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><body><script type="importmap">
{"imports":{"onnxruntime-web":"${ORT}","onnxruntime-web/webgpu":"${ORT}"}}
</script></body>`);
    return;
  }
  const full = path.normalize(path.join(ROOT, url.replace(/^\/+/, '')));
  if (!full.startsWith(path.normalize(ROOT)) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404).end('nf');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
});

setTimeout(() => {
  console.error('CROSSCHECK_FAIL timeout');
  app.exit(1);
}, 900000);

app.whenReady().then(() =>
  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const win = new BrowserWindow({ show: false });
    try {
      await win.loadURL(`http://127.0.0.1:${port}/__q.html`);
      const code = `
      (async () => {
        const base = 'http://127.0.0.1:${port}/';
        const mod = await import(base + 'node_modules/@imgly/background-removal/dist/index.mjs');
        const publicPath = base + 'resources/matting-model/';
        const out = [];
        for (const item of ${JSON.stringify(job.items)}) {
          try {
            const resp = await fetch(base + item.rawPath.replace(/^.*?(resources\\/)/, '$1'));
            const buf = new Uint8Array(await resp.arrayBuffer());
            const blob = new Blob([buf.buffer], { type: 'image/x-rgba8;width=' + item.width + ';height=' + item.height });
            const t0 = performance.now();
            const res = await mod.removeBackground(blob, {
              output: { format: 'image/png' },
              publicPath,
              model: 'isnet_fp16',
            });
            const ms = Math.round(performance.now() - t0);
            const ab = await res.arrayBuffer();
            // 直接取 PNG 原始字节，Python 侧解码 alpha
            out.push({ key: item.key, ok: true, ms, png: Array.from(new Uint8Array(ab)) });
          } catch (e) {
            out.push({ key: item.key, ok: false, error: String(e && e.message ? e.message : e) });
          }
        }
        return out;
      })()
      `;
      const results = await win.webContents.executeJavaScript(code, true);
      const outDir = path.resolve(job.outDir);
      fs.mkdirSync(outDir, { recursive: true });
      const manifest = { items: [], errors: [] };
      for (const r of results) {
        if (!r.ok) {
          manifest.errors.push({ key: r.key, error: r.error });
          continue;
        }
        fs.writeFileSync(path.join(outDir, `${r.key}.png`), Buffer.from(r.png));
        manifest.items.push({ key: r.key, ms: r.ms });
      }
      fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      console.log(`[crosscheck] done: ${manifest.items.length} ok, ${manifest.errors.length} err -> ${outDir}`);
      if (manifest.errors.length) console.log(JSON.stringify(manifest.errors.slice(0, 3)));
      app.exit(0);
    } catch (e) {
      console.error('[crosscheck] fatal:', e && e.stack ? e.stack : e);
      app.exit(1);
    }
  }),
);
