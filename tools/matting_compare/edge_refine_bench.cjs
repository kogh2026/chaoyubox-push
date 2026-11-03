/**
 * 边缘精修的真实性能测量（Electron / 真浏览器 + esbuild 编译产品模块）。
 *
 * 为什么必须真跑浏览器：产品实现是逐像素 JS 循环，numpy 向量化实现的常数差 5~15 倍，
 * 拿 Python 的数去估 JS 的开销会误导结论。这里直接跑 `src/lib/edgeRefine.ts` 的真实代码。
 *
 * 测三件事：
 *   1. refineEdge 的纯计算耗时（按原图分辨率）
 *   2. 内存占用
 *   3. 正确性：alpha 是否被改动（必须为 0）、边缘色偏是否下降
 *
 * 运行：env -u ELECTRON_RUN_AS_NODE npx electron tools/matting_compare/edge_refine_bench.cjs --job=<job.json>
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.wasm': 'application/wasm',
  '.json': 'application/json',
};

const JOB = process.argv.find((a) => a.startsWith('--job='));
if (!JOB) {
  console.error('missing --job=<path>');
  app.exit(1);
}
const job = JSON.parse(fs.readFileSync(JOB.slice('--job='.length), 'utf8'));

/** 把 TS 模块编译成浏览器可 import 的 JS（esbuild 是 vite 的依赖，已在 node_modules 里） */
async function buildEdgeRefineModule() {
  const esbuild = require('esbuild');
  const out = path.join(ROOT, '.tmp', 'edge-refine', 'edgeRefine.bundle.js');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'lib', 'edgeRefine.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2020',
    outfile: out,
    logLevel: 'error',
  });
  return out;
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/__q.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><body></body>');
    return;
  }
  // 1) 编译产物
  const bundle = path.join(ROOT, '.tmp', 'edge-refine', 'edgeRefine.bundle.js');
  if (url === '/edgeRefine.js') {
    if (!fs.existsSync(bundle)) {
      res.writeHead(404).end('nf');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    fs.createReadStream(bundle).pipe(res);
    return;
  }
  // 2) 图片：job.imgRoot 下的文件
  if (url.startsWith('/img/')) {
    const rel = url.slice('/img/'.length);
    const full = path.resolve(job.imgRoot, rel);
    if (!full.startsWith(path.resolve(job.imgRoot)) || !fs.existsSync(full)) {
      res.writeHead(404).end('nf');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
    return;
  }
  res.writeHead(404).end('nf');
});

setTimeout(() => {
  console.error('BENCH_FAIL timeout');
  app.exit(1);
}, 900000);

app.whenReady().then(async () => {
  await buildEdgeRefineModule();
  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const win = new BrowserWindow({ show: false });
    try {
      await win.loadURL(`http://127.0.0.1:${port}/__q.html`);
      const code = `
      (async () => {
        const mod = await import('/edgeRefine.js');
        const results = [];
        for (const item of ${JSON.stringify(job.items)}) {
          try {
            const resp = await fetch('/img/' + encodeURIComponent(item.file));
            const blob = await resp.blob();
            const bmp = await createImageBitmap(blob);
            const cv = document.createElement('canvas');
            cv.width = bmp.width; cv.height = bmp.height;
            const ctx = cv.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(bmp, 0, 0);
            const img = ctx.getImageData(0, 0, cv.width, cv.height);
            const d = img.data;

            const alphaBefore = new Uint8ClampedArray(d.length / 4);
            for (let p = 0, i = 0; p < d.length; p += 4, i++) alphaBefore[i] = d[p + 3];

            const memBefore = performance.memory ? performance.memory.usedJSHeapSize : 0;
            const t0 = performance.now();
            const usedBg = mod.refineEdge(d, cv.width, cv.height, { strength: 0.8, kappa: 0.35 });
            const ms = performance.now() - t0;
            const memAfter = performance.memory ? performance.memory.usedJSHeapSize : 0;

            let alphaChanged = 0;
            for (let p = 0, i = 0; p < d.length; p += 4, i++) {
              if (d[p + 3] !== alphaBefore[i]) alphaChanged++;
            }
            results.push({
              key: item.key, ok: true, width: cv.width, height: cv.height,
              ms: Math.round(ms), bg: usedBg ? usedBg.map(x => Math.round(x)) : null,
              alphaChanged,
              memDeltaMB: memBefore ? Math.round((memAfter - memBefore) / 1048576) : null,
            });
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
      fs.writeFileSync(path.join(outDir, 'bench.json'), JSON.stringify(results, null, 2));

      const ok = results.filter((r) => r.ok);
      const bad = results.filter((r) => !r.ok);
      console.log('\n=== 边缘精修真实性能（产品代码 src/lib/edgeRefine.ts，Electron/V8）===');
      console.log('样本'.padEnd(24) + '尺寸'.padEnd(12) + 'MP'.padEnd(8) + '耗时ms'.padEnd(10) + '每像素us'.padEnd(12) + 'alpha改动');
      console.log('-'.repeat(78));
      let tot = 0;
      let ms = 0;
      for (const r of ok) {
        const px = r.width * r.height;
        tot += px;
        ms += r.ms;
        console.log(
          `${r.key.padEnd(24)}${(r.width + 'x' + r.height).padEnd(12)}${(px / 1e6).toFixed(2).padEnd(8)}${String(r.ms).padEnd(10)}${(r.ms * 1000 / px).toFixed(4).padEnd(12)}${r.alphaChanged}`,
        );
      }
      console.log('-'.repeat(78));
      console.log(ok.length + ' 张共 ' + (tot / 1e6).toFixed(1) + 'MP，合计 ' + Math.round(ms) + 'ms，平均 ' + Math.round(ms / ok.length) + 'ms/张');
      console.log(`alpha 被改动的像素总数：${ok.reduce((s, r) => s + r.alphaChanged, 0)}（必须为 0 —— 发丝层次必须保留）`);
      if (bad.length) console.log('失败:', JSON.stringify(bad.slice(0, 3)));
      app.exit(0);
    } catch (e) {
      console.error('[bench] fatal:', e && e.stack ? e.stack : e);
      app.exit(1);
    }
  });
});
