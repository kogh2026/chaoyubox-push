// 抠图性能基准：量化「模型档位 × 是否启用跨源隔离（ORT 多线程）」对单张耗时的真实影响。
//
// 背景（已由代码确认）：@imgly 恒把输入 resize 到 1024×1024 再推理，所以推理耗时与输入像素无关；
// 真正可变的只有两个开关 —— model 档位（isnet_fp16 / isnet_quint8）与 ORT 是否能用多线程
// （需要 crossOriginIsolated，否则 SharedArrayBuffer 不可用、ORT 退化成单线程）。
//
// 做法：起两个隐藏窗口，一个普通页面、一个带 COOP/COEP 的隔离页面，各跑两个模型档位，
// 用 @imgly 自带的 progress 四阶段打点（decode/inference/mask/encode）拆出耗时。
//
// 运行：env -u ELECTRON_RUN_AS_NODE npx electron tools/matting.bench.cjs
const { app, BrowserWindow } = require('electron');
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
};
// @imgly 的 dist 用裸模块名动态 import("onnxruntime-web")，浏览器侧靠 importmap 解析
const ORT = '/node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs';
const ISO_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/__bench.html' || url === '/__bench_iso.html') {
    const iso = url === '/__bench_iso.html';
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      ...(iso ? ISO_HEADERS : {}),
    });
    res.end(
      `<!doctype html><meta charset="utf-8"><body><script type="importmap">
{"imports":{"onnxruntime-web":"${ORT}","onnxruntime-web/webgpu":"${ORT}"}}
</script></body>`,
    );
    return;
  }
  const full = path.normalize(path.join(ROOT, url.replace(/^\/+/, '')));
  if (!full.startsWith(path.normalize(ROOT)) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404).end('nf');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
    // COEP 下所有子资源都要显式声明 CORP，否则被拦
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  fs.createReadStream(full).pipe(res);
});

setTimeout(() => {
  console.error('BENCH_FAIL timeout');
  app.exit(1);
}, 900000);

const CODE = (port) => `
(async () => {
  const base = 'http://127.0.0.1:${port}/';
  const mod = await import(base + 'node_modules/@imgly/background-removal/dist/index.mjs');
  const ort = await import('${ORT}');
  const publicPath = base + 'resources/matting-model/';

  function draw(w, h) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const c = cv.getContext('2d');
    const g = c.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#8ec5ff'); g.addColorStop(1, '#f7d6c4');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.fillStyle = '#c98d63';
    c.beginPath(); c.ellipse(w / 2, h * 0.42, w * 0.22, h * 0.28, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#3a2a20';
    c.beginPath(); c.ellipse(w / 2, h * 0.2, w * 0.2, h * 0.14, 0, 0, Math.PI * 2); c.fill();
    return cv;
  }
  const toBlob = (cv) => new Promise((r) => cv.toBlob(r, 'image/png'));
  const dimsOf = async (blob) => {
    const bmp = await createImageBitmap(blob);
    const d = { w: bmp.width, h: bmp.height };
    bmp.close();
    return d;
  };

  async function run(model, w, h, quality) {
    const blob = await toBlob(draw(w, h));
    const marks = [];
    const t0 = performance.now();
    const out = await mod.removeBackground(blob, {
      output: { format: 'image/png', quality },
      publicPath,
      model,
      progress: (k, cur, total) => { marks.push([k, Math.round(performance.now() - t0)]); },
    });
    const total = Math.round(performance.now() - t0);
    const d = await dimsOf(out);
    const phases = {};
    for (let i = 1; i < marks.length; i++) {
      const key = marks[i - 1][0].replace('compute:', '');
      phases[key] = (phases[key] || 0) + (marks[i][1] - marks[i - 1][1]);
    }
    return { phases, total, out: d.w + 'x' + d.h, outBytes: out.size, marks: marks.length };
  }

  const rows = [];
  for (const model of ['isnet_fp16', 'isnet_quint8']) {
    // warmup 用另一个 quality 触发一次独立 init（quality 会进入 memo key），
    // 这样正式那次的 progress 才挂在当前配置上（否则打点会打到 warmup 的数组里）
    await run(model, 512, 384, 0.71);
    const r = await run(model, 1600, 1200, 0.8);
    rows.push({ model, ...r });
  }
  return {
    iso: !!globalThis.crossOriginIsolated,
    cores: navigator.hardwareConcurrency,
    threads: ort.env.wasm.numThreads,
    rows,
  };
})()`;

async function benchWindow(port, page) {
  const win = new BrowserWindow({ show: false });
  await win.loadURL(`http://127.0.0.1:${port}/${page}`);
  const r = await win.webContents.executeJavaScript(CODE(port), true);
  win.close();
  return r;
}

app.whenReady().then(() =>
  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    try {
      const res = [];
      res.push({ tag: '普通页面      ', ...(await benchWindow(port, '__bench.html')) });
      res.push({ tag: '隔离页面(线程)', ...(await benchWindow(port, '__bench_iso.html')) });
      for (const r of res) {
        console.log(
          `${r.tag}  crossOriginIsolated=${r.iso}  cores=${r.cores}  ort.numThreads=${r.threads}`,
        );
        for (const x of r.rows) {
          console.log(
            `   ${x.model.padEnd(13)} out=${String(x.out).padEnd(10)} ` +
              `decode=${String(x.phases.decode ?? 0).padStart(4)} infer=${String(x.phases.inference ?? 0).padStart(6)} ` +
              `mask=${String(x.phases.mask ?? 0).padStart(4)} encode=${String(x.phases.encode ?? 0).padStart(5)} ` +
              `合计=${String(x.total).padStart(6)}ms`,
          );
        }
      }
      console.log('BENCH_OK');
      app.exit(0);
    } catch (e) {
      console.error('BENCH_FAIL', e);
      app.exit(1);
    } finally {
      server.close();
    }
  }),
);
