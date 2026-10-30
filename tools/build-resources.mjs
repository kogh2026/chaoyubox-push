// 组装 resources/ 下的预装运行时资源（该目录被 .gitignore 忽略，需要能一键重建）。
// 运行：node tools/build-resources.mjs        只装 ort / tesseract（离线，全部来自 node_modules）
//       node tools/build-resources.mjs --all  额外下载 @imgly 抠图模型（95MB，需联网）
//
// 产物布局（打包后位于安装目录 resources/res/）：
//   resources/ort/          onnxruntime-web wasm 运行时（人脸检测用）
//   resources/tesseract/    tesseract.js worker + 3 个 LSTM core + chi_sim 语言包
//   resources/matting-model/@imgly 抠图模型（由 fetch-matting-model.mjs 下载）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const RES = path.join(ROOT, 'resources');
const NM = path.join(ROOT, 'node_modules');

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  const mb = (fs.statSync(to).size / 1048576).toFixed(1);
  console.log(`  ${path.relative(RES, to)}  ${mb}MB`);
}

/* ---------- 1. ORT wasm 运行时 ---------- */
// vite 把 onnxruntime-web / webgpu 都别名到 wasm-only 构建，
// 因此只需要非 jsep 的 ort-wasm-simd-threaded.{mjs,wasm} 两件套。
console.log('[1/3] ort');
const ortDist = path.join(NM, 'onnxruntime-web', 'dist');
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  copy(path.join(ortDist, f), path.join(RES, 'ort', f));
}

/* ---------- 2. tesseract ---------- */
// corePath 给的是目录，tesseract.js 会按 SIMD 能力挑一个：
//   relaxedsimd-lstm → simd-lstm → lstm（oem=1 即 LSTM_ONLY，只走 -lstm 系列）
// 三个都带上，避免不同 Chromium 版本落到没预装的那一个。
console.log('[2/3] tesseract');
const coreDir = path.join(NM, 'tesseract.js-core');
for (const v of ['relaxedsimd-lstm', 'simd-lstm', 'lstm']) {
  for (const ext of ['.wasm.js', '.wasm']) {
    copy(path.join(coreDir, `tesseract-core-${v}${ext}`), path.join(RES, 'tesseract', `tesseract-core-${v}${ext}`));
  }
}
copy(path.join(NM, 'tesseract.js', 'dist', 'worker.min.js'), path.join(RES, 'tesseract', 'worker.min.js'));

// 语言包：oem=1（LSTM_ONLY）时 tesseract.js 官方默认就用 4.0.0_best_int，
// 体积只有 4.0.0 的十分之一，而证件粗分类只需要关键词命中率。
const LANG_URL =
  'https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim@1.0.0/4.0.0_best_int/chi_sim.traineddata.gz';
const langDst = path.join(RES, 'tesseract', 'chi_sim.traineddata');
if (fs.existsSync(langDst) && fs.statSync(langDst).size > 1_000_000) {
  console.log(`  chi_sim.traineddata 已存在 ${(fs.statSync(langDst).size / 1048576).toFixed(1)}MB，跳过下载`);
} else {
  const res = await fetch(LANG_URL);
  if (!res.ok) throw new Error(`语言包下载失败 ${res.status}`);
  const raw = zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));
  fs.writeFileSync(langDst, raw);
  console.log(`  chi_sim.traineddata  ${(raw.length / 1048576).toFixed(1)}MB（已解压）`);
}

/* ---------- 3. 抠图模型（可选，95MB） ---------- */
console.log('[3/3] matting-model');
if (process.argv.includes('--all')) {
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'fetch-matting-model.mjs')], {
    stdio: 'inherit',
    cwd: ROOT,
  });
} else {
  const n = fs.existsSync(path.join(RES, 'matting-model'))
    ? fs.readdirSync(path.join(RES, 'matting-model')).length
    : 0;
  console.log(`  跳过（已有 ${n} 个文件；需要联网重下时加 --all）`);
}

console.log('\nresources 就绪：');
for (const d of fs.readdirSync(RES)) {
  const p = path.join(RES, d);
  if (fs.statSync(p).isDirectory()) console.log(`  ${d}/  ${(dirSize(p) / 1048576).toFixed(1)}MB`);
}

function dirSize(p) {
  let s = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    s += e.isDirectory() ? dirSize(path.join(p, e.name)) : fs.statSync(path.join(p, e.name)).size;
  }
  return s;
}
