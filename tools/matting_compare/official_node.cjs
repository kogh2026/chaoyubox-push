/**
 * 抠图对比：爱印官方 matting-v1 vs 我们现有引擎（MODNet / ISNet）。
 *
 * 目的：回答「A/B/C/D 四方案最终效果能不能超越爱印」——先要有一条**爱印真值基线**，
 * 否则任何"超越"的说法都是空谈。
 *
 * 口径（照抄爱印 id-photo-matting-worker.js，不做任何移植）：
 *   - 输入 512×512（必须是 32 的倍数），短边不保长宽比 → 直接 resize 到 512×512
 *   - 归一化 normalization="half" → (x/255 − 0.5)/0.5
 *   - 输出 [1,1,512,512] 已是 sigmoid 后的 alpha
 *   - 官方 worker 内部 512→原图尺寸由调用方 resize（我们这里只比 512 尺度上的 alpha）
 *
 * 我们侧：
 *   - MODNet：本地 resources/matting-model/modnet/modnet.onnx，归一化 (x/255)*2−1，
 *     最短边 512、32 倍数（见 src/lib/matting.worker.ts modnetSize/runModnet）
 *   - ISNet ：MIT 权重 @imgly 口径，1024×1024、mean128/std256（见 src/lib/matting.ts）
 *
 * 输出：.tmp/matting-compare/<engine>/*.npy + report.json
 *
 * 运行：
 *   node tools/matting_compare/official_node.cjs --job job.json
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

/** 极简 ImageData 垫片：爱印 worker 只用到 data/width/height */
class ImageDataShim {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

/**
 * 托管爱印官方抠图 worker。
 * worker 协议：{ id, modelId, modelBytes, rgba:Uint8ClampedArray, width, height }
 * 返回 { id, ok, output: Float32Array(alpha 0..1), inferenceMs, threads }
 */
function bootAiyinWorker(workerPath, ort, wasmDir) {
  const sandboxSelf = globalThis;
  sandboxSelf.self = sandboxSelf;
  sandboxSelf.ImageData = ImageDataShim;

  let onPosted = null;
  sandboxSelf.postMessage = (msg) => {
    if (onPosted) onPosted(msg);
  };

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
      set: () => { /* Node 下固定单线程，避免 worker_threads 差异 */ },
    });
  } catch (e) {
    process.stderr.write(`[aiyin] wasm cfg override skipped: ${e.message}\n`);
  }

  sandboxSelf.importScripts = () => {
    sandboxSelf.ort = ort;
  };

  // 爱印 worker 用 self.location.search 判断是否强制单线程（"threads=1"）。
  // Node 里没有 location，这里补一个空的 search（等价于不强制，走默认线程数逻辑）。
  if (!sandboxSelf.location) {
    sandboxSelf.location = { search: '', href: '' };
  }

  if (typeof sandboxSelf.performance === 'undefined') {
    sandboxSelf.performance = { now: () => Number(process.hrtime.bigint() / 1000000n) };
  }

  const src = fs.readFileSync(workerPath, 'utf8');
  // eslint-disable-next-line no-eval
  (0, eval)(src);

  if (typeof sandboxSelf.onmessage !== 'function') {
    throw new Error('worker did not register self.onmessage');
  }

  return {
    send(msg, timeoutMs = 300000) {
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

/** 把 <canvas> 之外无法在 Node 直接用的部分交给调用方传入 raw RGBA */
function main() {
  const args = parseArgs(process.argv);
  if (!args.job) throw new Error('missing --job');
  const job = JSON.parse(fs.readFileSync(args.job, 'utf8'));

  const outDir = path.resolve(job.outDir);
  fs.mkdirSync(outDir, { recursive: true });

  const ort = require('onnxruntime-web');
  const wasmDir = url.pathToFileURL(
    path.resolve('node_modules/onnxruntime-web/dist') + path.sep,
  ).href;

  const w = bootAiyinWorker(path.resolve(job.workerPath), ort, wasmDir);
  const modelBytes = new Uint8Array(fs.readFileSync(path.resolve(job.modelPath)));

  const manifest = { workerPath: job.workerPath, modelPath: job.modelPath, items: [], errors: [] };

  const worker = (async () => {
    for (const item of job.items) {
      try {
        const raw = new Uint8Array(fs.readFileSync(path.resolve(item.rawPath)));
        const rgba = new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength);
        const t0 = Date.now();
        const res = await w.send({
          id: item.key,
          modelId: job.modelId || 'matting-v1',
          modelBytes,
          rgba,
          width: item.width,
          height: item.height,
        });
        if (!res.ok) throw new Error(res.error || 'worker failed');
        const alpha = new Float32Array(res.output);
        fs.writeFileSync(path.join(outDir, `${item.key}.f32`), Buffer.from(alpha.buffer));
        manifest.items.push({
          key: item.key,
          inferenceMs: res.inferenceMs,
          wallMs: Date.now() - t0,
          threads: res.threads,
          alphaLen: alpha.length,
          width: item.width,
          height: item.height,
        });
      } catch (e) {
        manifest.errors.push({ key: item.key, error: e instanceof Error ? e.message : String(e) });
      }
    }
  })();

  const done = worker.then(() => {
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`[official] done: ${manifest.items.length} ok, ${manifest.errors.length} err -> ${outDir}`);
  });

  // 硬超时保护：到点强制退出（不留 setTimeout 常驻，否则 Node 事件循环不空转、进程不退出）
  const hardTimer = setTimeout(() => {
    process.stderr.write('[official] hard timeout\n');
    process.exit(2);
  }, 1800000);
  hardTimer.unref();

  return done;
}

main().then(() => {
  // 显式退出：爱印 worker 会重定向 console.error，Node 侧可能残留句柄导致进程不退出，
  // 在 Python subprocess 里表现为"命令永不返回"。这里主动 exit 避免挂起。
  process.exit(0);
}).catch((e) => {
  process.stderr.write(`[official] fatal: ${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
