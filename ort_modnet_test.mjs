import * as ort from 'onnxruntime-web';
import { readFileSync } from 'node:fs';

const modelPath = 'D:/Downloads/2026-10-23-08-38-11/aiyinbox-clone/resources/matting-model/modnet/modnet.onnx';
const buf = readFileSync(modelPath);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
console.log('ORT', ort.env.versions?.web);

const t0 = Date.now();
const session = await ort.InferenceSession.create(ab, {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all',
  executionMode: 'sequential',
});
console.log('session ms', Date.now() - t0);

// dummy 512x512
const input = new Float32Array(1 * 3 * 512 * 512).fill(0.5);
const feeds = { input: new ort.Tensor('float32', input, [1, 3, 512, 512]) };
const t1 = Date.now();
let out;
try {
  out = await session.run(feeds);
  console.log('infer ms', Date.now() - t1);
} catch (err) {
  console.log('RUN ERROR after', Date.now() - t1, 'ms, err=', String(err?.message || err));
  process.exit(2);
}
const key = Object.keys(out)[0];
const t = out[key];
console.log('out', key, JSON.stringify(t.dims), t.type);
let min = 1, max = 0, sum = 0, n = 0;
for (let i = 0; i < t.data.length; i++) { const v = t.data[i]; if (v < min) min = v; if (v > max) max = v; sum += v; n++; }
console.log('range min', min.toFixed(4), 'max', max.toFixed(4), 'mean', (sum / n).toFixed(4));
