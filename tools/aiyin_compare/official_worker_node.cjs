/**
 * 爱印官方 worker 真机托管器（Node）。
 *
 * 目的：不做任何算法移植，直接 eval 爱印解密得到的 vendor worker 源码，
 * 在 Node 里以同样的 ort(wasm) 后端跑同一 FP32 权重，取回官方裁图。
 * 这样官方侧输出与爱印 app 内的 worker 逐位一致（同一份 JS、同一份模型）。
 *
 * 接口（供 Python harness 调用）：
 *   node official_worker_node.js --job job.json
 *
 * job.json:
 *   {
 *     "workerPath": ".../id2pdf-card-correction-worker.js",
 *     "modelPath":  ".../card-correction-fp32.onnx",
 *     "maxPages": 2,
 *     "minAreaFrac": 0.04,
 *     "outDir": "...",
 *     "items": [{ "key": "...", "rawPath": "...raw RGBA 文件...", "width": W, "height": H }]
 *   }
 *
 * 输出：<outDir>/<key>__p<i>.rgba  +  <outDir>/manifest.json
 */
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1];
  }
  return out;
}

/** 极简 ImageData 垫片：worker 只用到 data/width/height 三个字段 */
class ImageDataShim {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

/**
 * 在 Node 里搭建 worker 宿主环境并执行官方源码。
 * 返回 { send(msg): Promise<result> }
 */
function bootWorker(workerPath, ort, wasmDir) {
  // 官方 worker 用 self / importScripts / postMessage / ImageData 四个宿主能力
  const posted = [];
  let onPosted = null;

  const sandboxSelf = globalThis;
  sandboxSelf.self = sandboxSelf;
  sandboxSelf.ImageData = ImageDataShim;
  sandboxSelf.postMessage = (msg) => {
    posted.push(msg);
    if (onPosted) onPosted(msg);
  };
  // worker 内 tt() 会 importScripts('/vendor/onnxruntime-web/ort.min.js') 后读 self.ort，
  // 并且随后强行写 e.env.wasm.wasmPaths = '/vendor/onnxruntime-web/'（浏览器内的绝对路径）。
  // 在 Node 里 '/vendor/...' 会被解析成 D:\vendor\...，所以这里用属性拦截把该赋值
  // 重定向到真实的 node_modules/onnxruntime-web/dist/，其余行为与浏览器保持一致。
  const wasmCfg = ort.env.wasm;
  try {
    Object.defineProperty(wasmCfg, 'wasmPaths', {
      configurable: true,
      get: () => wasmDir,
      set: () => { /* 忽略 worker 的 /vendor/... 赋值 */ },
    });
    Object.defineProperty(wasmCfg, 'numThreads', {
      configurable: true,
      get: () => 1,
      set: () => { /* 固定单线程，避免 Node 下 worker_threads 差异 */ },
    });
  } catch (e) {
    process.stderr.write(`[official] wasm cfg override skipped: ${e.message}\n`);
  }

  sandboxSelf.importScripts = () => {
    sandboxSelf.ort = ort;
  };

  // performance 在 Node 18+ 已是全局，兜底一下
  if (typeof sandboxSelf.performance === 'undefined') {
    sandboxSelf.performance = { now: () => Number(process.hrtime.bigint() / 1000000n) };
  }

  const src = fs.readFileSync(workerPath, 'utf8');
  // 原样执行（IIFE，内部 "use strict"），仅注入宿主能力，不改一行逻辑
  // eslint-disable-next-line no-eval
  (0, eval)(src);

  if (typeof sandboxSelf.onmessage !== 'function') {
    throw new Error('worker did not register self.onmessage');
  }

  return {
    send(msg, timeoutMs = 180000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker timeout')), timeoutMs);
        onPosted = (m) => {
          if (m && m.id === msg.id) {
            clearTimeout(timer);
            onPosted = null;
            resolve(m);
          }
        };
        try {
          sandboxSelf.onmessage({ data: msg });
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      });
    },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.job) throw new Error('missing --job');
  const job = JSON.parse(fs.readFileSync(args.job, 'utf8'));

  const outDir = path.resolve(job.outDir);
  fs.mkdirSync(outDir, { recursive: true });

  // 与爱印 worker 相同的 ort 加载方式，但直接用本地 node_modules 的同一版本
  const ort = require('onnxruntime-web');
  // ort 在 Node 下用动态 import() 加载 .mjs，必须是 file:// URL 前缀（Windows 绝对路径不行）
  const wasmDir = require('url').pathToFileURL(
    path.resolve('node_modules/onnxruntime-web/dist') + path.sep,
  ).href;

  const w = bootWorker(path.resolve(job.workerPath), ort, wasmDir);
  const modelBytes = new Uint8Array(fs.readFileSync(path.resolve(job.modelPath)));

  const manifest = { workerPath: job.workerPath, modelPath: job.modelPath, clips: [], errors: [] };
  const t0 = Date.now();

  for (const item of job.items) {
    const raw = fs.readFileSync(item.rawPath);
    const data = new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength);
    const expected = item.width * item.height * 4;
    if (data.length !== expected) {
      throw new Error(`${item.key}: raw size ${data.length} != ${expected}`);
    }
    const msg = {
      id: item.key,
      modelId: 'card-correction-fp32',
      maxPages: job.maxPages,
      minAreaFrac: job.minAreaFrac,
      imageData: { data, width: item.width, height: item.height },
      modelBytes,
    };
    const started = Date.now();
    let res;
    try {
      res = await w.send(msg);
    } catch (e) {
      manifest.errors.push({ key: item.key, error: String(e && e.message || e) });
      continue;
    }
    if (res.type === 'error') {
      manifest.errors.push({ key: item.key, error: res.error });
      continue;
    }
    const pages = res.pages || [];
    for (let i = 0; i < pages.length; i += 1) {
      const pg = pages[i];
      const img = pg.imageData;
      const fn = `${item.key}__p${i}.rgba`;
      fs.writeFileSync(path.join(outDir, fn), Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength));
      manifest.clips.push({
        key: item.key,
        page: i,
        file: fn,
        width: img.width,
        height: img.height,
        angle: pg.angle,
        score: pg.score,
        uprightTurns: pg.uprightTurns,
        corners: pg.corners,
      });
    }
    manifest.clips.push({ key: item.key, page: -1, nPages: pages.length, passes: res.passes, room: res.room });
    process.stderr.write(`[official] ${item.key}: ${pages.length} page(s) in ${Date.now() - started}ms\n`);
  }

  manifest.elapsedMs = Date.now() - t0;
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  process.stdout.write(`OFFICIAL_WORKER_OK clips=${manifest.clips.filter((c) => c.page >= 0).length} errors=${manifest.errors.length} ms=${manifest.elapsedMs}\n`);
}

main().catch((e) => {
  process.stderr.write(`OFFICIAL_WORKER_FAIL ${e && e.stack || e}\n`);
  process.exit(1);
});
