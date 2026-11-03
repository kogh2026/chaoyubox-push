/**
 * Worker 内边缘精修的最终验证（Electron + 真实 Worker + 真实 MODNet 模型）。
 *
 * 这是**最接近生产**的验证：
 *   - 真实 Worker 线程（matting.worker.ts 由 Vite `?worker` 打包）
 *   - 真实 MODNet ONNX 模型（resources/matting-model/modnet/modnet.onnx）
 *   - 真实 ort(wasm) 推理
 *   - 真实边缘精修（refineEdgePixels）
 * 输出：精修前后的透明 PNG，供像素级比对 + 人眼核对。
 *
 * 需要先 `npx vite build`（Worker 是 ?worker 入口，需构建产物）。
 *
 * 运行：env -u ELECTRON_RUN_AS_NODE npx electron tools/matting_compare/worker_refine_final.cjs --job=<job.json>
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream',
};

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
    res.end('<!doctype html><meta charset="utf-8"><body></body>');
    return;
  }
  // 图片
  if (url.startsWith('/img/')) {
    const rel = decodeURIComponent(url.slice('/img/'.length));
    const full = path.resolve(job.imgRoot, rel);
    if (!full.startsWith(path.resolve(job.imgRoot)) || !fs.existsSync(full)) {
      res.writeHead(404).end('nf');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
    return;
  }
  // 静态资源（构建产物）
  const full = path.normalize(path.join(ROOT, url.replace(/^\/+/, '')));
  if (!full.startsWith(path.normalize(ROOT)) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404).end('nf');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
});

setTimeout(() => {
  console.error('FINAL_FAIL timeout');
  app.exit(1);
}, 1500000);

app.whenReady().then(() =>
  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const win = new BrowserWindow({ show: false });
    try {
      await win.loadURL(`http://127.0.0.1:${port}/__q.html`);
      const code = `
      (async () => {
        const base = 'http://127.0.0.1:${port}/';
        const results = [];
        // 真实 Worker（Vite 构建产物里的 matting.worker chunk）
        const workerUrl = base + ${JSON.stringify(job.workerChunk)};
        for (const item of ${JSON.stringify(job.items)}) {
          try {
            const resp = await fetch('/img/' + encodeURIComponent(item.file));
            const blob = await resp.blob();
            const w = new Worker(workerUrl, { type: 'module' });
            const t0 = performance.now();
            const buf = await new Promise((resolve, reject) => {
              w.onmessage = (e) => {
                if (e.data && e.data.id === 1) {
                  if (e.data.ok) resolve(e.data.blob);
                  else reject(new Error(e.data.error || 'worker failed'));
                }
              };
              w.onerror = (e) => reject(new Error('worker error: ' + (e.message || '')));
              w.postMessage({
                id: 1,
                file: blob,
                publicPath: base + 'resources/matting-model/',
                ortPath: base + 'resources/ort/',
                modnetUrl: base + 'resources/matting-model/modnet/modnet.onnx',
                engine: 'modnet',
                refineStrength: ${job.refineStrength},
                refineKappa: ${job.refineKappa},
                threads: 1,
              });
            });
            const ms = Math.round(performance.now() - t0);
            w.terminate();
            // 转成 dataURL 供 Python 侧落盘
            const outBlob = new Blob([buf], { type: 'image/png' });
            const ab = await outBlob.arrayBuffer();
            const u8 = new Uint8Array(ab);
            let bin = '';
            for (let i = 0; i < u8.length; i += 8192) {
              bin += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
            }
            results.push({ key: item.key, ok: true, ms, b64: btoa(bin) });
          } catch (e) {
            results.push({ key: item.key, ok: false, error: String(e && e.message ? e.message : e) });
          }
        }
        return results;
      })()
      `;
      const results = await win.webContents.executeJavaScript(code, true);
      const outDir = path.resolve(job.outDir);
      fs.mkdirSync(outDir, { recursive: true });
      const manifest = [];
      for (const r of results) {
        if (!r.ok) {
          manifest.push({ key: r.key, ok: false, error: r.error });
          continue;
        }
        const f = path.join(outDir, r.key + '.png');
        fs.writeFileSync(f, Buffer.from(r.b64, 'base64'));
        manifest.push({ key: r.key, ok: true, ms: r.ms, out: f });
      }
      fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      const ok = manifest.filter((m) => m.ok);
      console.log('\n=== Worker 内精修 · 真实模型最终验证 ===');
      for (const m of manifest) {
        console.log(m.ok ? (m.key + '  ' + m.ms + 'ms') : (m.key + '  FAILED: ' + m.error));
      }
      console.log('成功 ' + ok.length + ' / ' + manifest.length + ' -> ' + outDir);
      app.exit(ok.length === manifest.length ? 0 : 3);
    } catch (e) {
      console.error('[final] fatal:', e && e.stack ? e.stack : e);
      app.exit(1);
    }
  }),
);
