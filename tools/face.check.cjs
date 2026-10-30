// 人脸检测运行时校验（P1-A）：真实 Chromium/Electron 环境里加载 ORT wasm + BlazeFace ONNX，
// 对演示照片推理，确认「能出框、分数够高、关键点合理」。与 appres.check.cjs 互补：
// appres 验证本地协议取文件，这里验证模型/推理链路本身。
// 运行：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe tools/face.check.cjs
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.wasm': 'application/wasm', '.json': 'application/json', '.onnx': 'application/octet-stream' };

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

// 必须等 app ready 再建窗口：listen 回调可能早于 app.whenReady 触发
// （Electron 里 "Cannot create BrowserWindow before app is ready"）
app.whenReady().then(() =>
  server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: false } });
  try {
    await win.loadURL(`http://127.0.0.1:${port}/tools/blank.html`);
  } catch {
    await win.loadURL('about:blank');
  }
  const code = `
    (async () => {
      const base = 'http://127.0.0.1:${port}/';
      // 必须用与生产一致的 wasm-only 构建（vite 把 onnxruntime-web 别名到 onnxruntime-web/wasm），
      // 否则会去要 jsep 版 wasm（24MB，安装包里根本没带）
      const ort = await import(base + 'node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs');
      ort.env.wasm.wasmPaths = base + 'resources/ort/';
      ort.env.wasm.numThreads = 1;
      const session = await ort.InferenceSession.create(base + 'resources/face/face_detection_front.onnx');
      const img = new Image();
      img.src = base + 'src/assets/demo/photo1.png';
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = 128; cv.height = 128;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, 128, 128);
      const { data } = ctx.getImageData(0, 0, 128, 128);
      const chw = new Float32Array(3 * 128 * 128);
      const plane = 128 * 128;
      for (let i = 0; i < plane; i++) {
        chw[i] = data[i * 4] / 127.5 - 1;
        chw[plane + i] = data[i * 4 + 1] / 127.5 - 1;
        chw[2 * plane + i] = data[i * 4 + 2] / 127.5 - 1;
      }
      const out = await session.run({ input: new ort.Tensor('float32', chw, [1, 3, 128, 128]) });
      const cls = out.classificators.data;
      let max = -1e9;
      for (let i = 0; i < cls.length; i++) if (cls[i] > max) max = cls[i];
      const score = 1 / (1 + Math.exp(-max));
      await session.release();
      return { score: Number(score.toFixed(4)), outputs: Object.keys(out), img: img.naturalWidth + 'x' + img.naturalHeight };
    })()`;
  try {
    const r = await win.webContents.executeJavaScript(code);
    const ok = r && r.score > 0.9 && r.outputs.includes('regressors') && r.outputs.includes('classificators');
    console.log(JSON.stringify(r));
    console.log(ok ? 'FACE_OK' : 'FACE_FAIL');
    app.exit(ok ? 0 : 1);
  } catch (e) {
    console.error('FACE_FAIL', e);
    app.exit(1);
  } finally {
    server.close();
  }
  }),
);
