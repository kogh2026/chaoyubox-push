// 抠图模型质量对比：isnet_fp16(默认) vs isnet_quint8(int8 量化)。
// 量化模型体积小一半、CPU 上更快，但边缘（头发丝、半透明）可能变糙 —— 换之前先用数字确认掉档幅度。
//
// 指标：把两张结果的 alpha 通道逐像素比较
//   IoU       : alpha>=128 区域的交并比（整体轮廓一致性）
//   meanAbs   : |Δalpha| 的平均值（整体差异）
//   p99Abs    : |Δalpha| 的 99 分位（极端差异）
//   edgeDiff  : 只在"边缘带"（任一侧 alpha 处于 16..240）内统计的平均 |Δalpha| —— 最能反映发丝质量
//
// 运行：env -u ELECTRON_RUN_AS_NODE npx electron tools/matting.quality.cjs
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.wasm': 'application/wasm', '.json': 'application/json' };
const ORT = '/node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs';

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
  console.error('QUALITY_FAIL timeout');
  app.exit(1);
}, 600000);

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
        const alphaOf = async (blob) => {
          const bmp = await createImageBitmap(blob);
          const cv = document.createElement('canvas');
          cv.width = bmp.width; cv.height = bmp.height;
          const c = cv.getContext('2d', { willReadFrequently: true });
          c.drawImage(bmp, 0, 0);
          const d = c.getImageData(0, 0, cv.width, cv.height).data;
          bmp.close();
          return { w: cv.width, h: cv.height, a: d };
        };
        const run = async (file, model) => {
          const blob = await (await fetch(base + file)).blob();
          const out = await mod.removeBackground(blob, { output: { format: 'image/png' }, publicPath, model });
          return alphaOf(out);
        };
        const cmp = (x, y) => {
          let inter = 0, uni = 0, sum = 0, edgeSum = 0, edgeN = 0;
          const diffs = [];
          const n = Math.min(x.w * x.h, y.w * y.h);
          const scale = Math.min(x.w / y.w, 1) * Math.min(x.h / y.h, 1); // 尺寸不同时按最小边对齐采样（实际不会触发）
          for (let i = 0; i < n; i++) {
            const ax = x.a[4 * i + 3], ay = y.a[4 * i + 3];
            const bx = ax >= 128, by = ay >= 128;
            if (bx && by) inter++;
            if (bx || by) uni++;
            const d = Math.abs(ax - ay);
            sum += d;
            if (d > 0) diffs.push(d);
            // 边缘带：任一侧处于半透明区间
            const ex = ax > 16 && ax < 240, ey = ay > 16 && ay < 240;
            if (ex || ey) { edgeSum += d; edgeN++; }
          }
          diffs.sort((p, q) => p - q);
          return {
            IoU: uni ? +(inter / uni).toFixed(4) : 1,
            meanAbs: +(sum / n).toFixed(2),
            p99Abs: diffs.length ? diffs[Math.floor(diffs.length * 0.99)] : 0,
            maxAbs: diffs.length ? diffs[diffs.length - 1] : 0,
            edgeMeanAbs: edgeN ? +(edgeSum / edgeN).toFixed(2) : 0,
            edgePxRatio: +(edgeN / n).toFixed(4),
          };
        };
        const rows = [];
        for (const f of ['src/assets/demo/photo1.png', 'src/assets/demo/photo2.png']) {
          const a = await run(f, 'isnet_fp16');
          const b = await run(f, 'isnet_quint8');
          rows.push({ file: f.split('/').pop(), size: a.w + 'x' + a.h, ...cmp(a, b) });
        }
        return rows;
      })()`;
      const rows = await win.webContents.executeJavaScript(code, true);
      for (const r of rows) {
        console.log(
          `${r.file.padEnd(12)} ${r.size.padEnd(10)} IoU=${String(r.IoU).padEnd(7)} mean|Δ|=${String(r.meanAbs).padEnd(7)} ` +
            `p99|Δ|=${String(r.p99Abs).padEnd(4)} max|Δ|=${String(r.maxAbs).padEnd(4)} 边缘带均差=${String(r.edgeMeanAbs).padEnd(7)} 边缘占比=${r.edgePxRatio}`,
        );
      }
      console.log('QUALITY_OK');
      app.exit(0);
    } catch (e) {
      console.error('QUALITY_FAIL', e);
      app.exit(1);
    } finally {
      server.close();
    }
  }),
);
