// 下载 @imgly 预装模型资源到 resources/matting-model/。
// 运行：node tools/fetch-matting-model.mjs
// 说明：@imgly 的资源格式是 resources.json + 按 hash 命名的块文件，
// 下载后 publicPath 指向本目录即可完全离线使用（不再访问 staticimgly.com）。
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/';
const OUT = path.resolve('resources/matting-model');
// 可选模型：isnet_fp16(84MB, 默认) / isnet_quint8(42MB, int8 量化，CPU 上更快) / isnet(168MB, fp32)
// 用法：node tools/fetch-matting-model.mjs --model=isnet_fp16,isnet_quint8
const arg = process.argv.slice(2).find((a) => a.startsWith('--model='));
const MODELS = arg ? arg.slice('--model='.length).split(',') : ['isnet_fp16'];
const NEEDED = [
  '/onnxruntime-web/ort-wasm-simd-threaded.wasm',
  '/onnxruntime-web/ort-wasm-simd-threaded.mjs',
  ...MODELS.map((m) => `/models/${m}`),
];

fs.mkdirSync(OUT, { recursive: true });

const res = await fetch(new URL('resources.json', BASE));
if (!res.ok) throw new Error(`resources.json ${res.status}`);
const map = await res.json();
fs.writeFileSync(path.join(OUT, 'resources.json'), JSON.stringify(map));

// 只保留需要的条目（其余模型不下载，避免安装包无谓增大）
const chunks = new Map();
for (const key of NEEDED) {
  const entry = map[key];
  if (!entry) throw new Error(`资源缺失: ${key}`);
  for (const c of entry.chunks) chunks.set(c.name, c.offsets[1] - c.offsets[0]);
}

const names = [...chunks.keys()];
let done = 0;
let bytes = 0;

async function one(name, size) {
  const dst = path.join(OUT, name);
  if (fs.existsSync(dst) && fs.statSync(dst).size === size) {
    done++;
    bytes += size;
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(new URL(name, BASE));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length !== size) throw new Error(`size ${buf.length} != ${size}`);
      fs.writeFileSync(dst, buf);
      done++;
      bytes += size;
      console.log(`[${done}/${names.length}] ${name} ${(size / 1048576).toFixed(1)}MB`);
      return;
    } catch (e) {
      if (attempt === 3) throw e;
      console.warn(`重试 ${attempt} ${name}: ${e.message}`);
    }
  }
}

const CONC = 3;
let i = 0;
await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (i < names.length) {
      const idx = i++;
      await one(names[idx], chunks.get(names[idx]));
    }
  }),
);
console.log(`完成：${names.length} 个块，共 ${(bytes / 1048576).toFixed(1)}MB → ${OUT}`);
