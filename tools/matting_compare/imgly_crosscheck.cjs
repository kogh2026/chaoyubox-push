/**
 * 交叉验证：用 @imgly 官方 JS（真·生产路径）跑同一批图，与 Python 侧 ISNet 实现对拍。
 *
 * 目的：确认 compare3.py 里的 ISNet 复现是否忠实。如果 @imgly 官方输出与我的 Python
 * 输出一致 → 说明"ISNet 在证件照上效果差"是模型本身的特性，不是我实现有 bug；
 * 如果不一致 → 是我的复现有问题，结论要推翻重来。
 *
 * 口径：@imgly 内部恒 resize 到 1024×1024（keepAspect=false），归一化 mean128/std256。
 * 我们喂 512×512 的图进去，@imgly 会再放大到 1024 推理，再回贴到 512。
 *
 * 用法：node tools/matting_compare/imgly_crosscheck.cjs --job job.json
 */
'use strict';

const fs = require('fs');
const path = require('path');
const url = require('url');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1];
  }
  return out;
}

class ImageDataShim {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.job) throw new Error('missing --job');
  const job = JSON.parse(fs.readFileSync(args.job, 'utf8'));
  const outDir = path.resolve(job.outDir);
  fs.mkdirSync(outDir, { recursive: true });

  const ort = require('onnxruntime-web');
  const wasmDir = url.pathToFileURL(
    path.resolve('node_modules/onnxruntime-web/dist') + path.sep,
  ).href;
  ort.env.wasm.wasmPaths = wasmDir;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;

  const { removeBackground } = require('@imgly/background-removal');

  // @imgly 用 fetch(publicPath + '/models/xxx') 取模型分片；Node 的 fetch 不支持 file://，
  // 所以起一个本地静态服务把 resources/matting-model/ 暴露成 http。
  const http = require('http');
  const MIME = { '.json': 'application/json', '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream' };
  const modelRoot = path.resolve(job.modelRoot || 'resources/matting-model');
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const full = path.normalize(path.join(modelRoot, rel));
    if (!full.startsWith(modelRoot) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404).end('nf');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const publicPath = `http://127.0.0.1:${port}/`;
  console.log(`[imgly] model server at ${publicPath}`);

  // @imgly 内部会强行写 ort.env.wasm.wasmPaths = publicPath（浏览器里是同源相对路径）。
  // 我们的 publicPath 是 http://，Node 的 ESM loader 不接受 http 协议 → 报
  // ERR_UNSUPPORTED_ESM_URL_SCHEME。用属性拦截把 wasmPaths 固定回 file:// 的 wasm 目录，
  // 其余行为（模型走 http、预处理、推理）与生产完全一致。
  try {
    Object.defineProperty(ort.env.wasm, 'wasmPaths', {
      configurable: true,
      get: () => wasmDir,
      set: () => { /* 忽略 @imgly 写入的 http publicPath */ },
    });
  } catch (e) {
    process.stderr.write(`[imgly] wasmPaths override skipped: ${e.message}\n`);
  }

  const manifest = { items: [], errors: [] };

  for (const item of job.items) {
    try {
      const raw = new Uint8Array(fs.readFileSync(path.resolve(item.rawPath)));
      // @imgly 支持裸 RGBA8 blob：'image/x-rgba8;width=W;height=H'
      const blob = new Blob([raw.buffer], {
        type: `image/x-rgba8;width=${item.width};height=${item.height}`,
      });
      const t0 = Date.now();
      const outBlob = await removeBackground(blob, {
        output: { format: 'image/png' },
        publicPath,
        model: job.model || 'isnet_fp16',
      });
      const ms = Date.now() - t0;
      const outBuf = Buffer.from(await outBlob.arrayBuffer());
      fs.writeFileSync(path.join(outDir, `${item.key}.png`), outBuf);
      manifest.items.push({ key: item.key, ms });
    } catch (e) {
      manifest.errors.push({ key: item.key, error: e instanceof Error ? e.message : String(e) });
    }
  }

  server.close();
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`[imgly] done: ${manifest.items.length} ok, ${manifest.errors.length} err`);
}

main().then(() => process.exit(0)).catch((e) => {
  process.stderr.write(`[imgly] fatal: ${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
