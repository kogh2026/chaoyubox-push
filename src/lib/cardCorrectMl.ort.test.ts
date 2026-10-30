// 真实权重协议测试：爱印「卡证矫正 FP32」模型（本地解密取证，仅用于研发验证）。
// 验证点：输入名 image、输出张量 scores/quads/angle/ftype 存在且形状正确、无 NaN、
//         decodeModelOutput 能正常消费其输出（数量级/范围检查）。
// 注意：卡面检测**质量**不在本文件验证——模型针对真实证件照片训练，
//       纯合成图不构成有效样本（实测最高分仅 ~0.15 且定位到文字块）。
//       质量基准走真机照片回归（tools/bench_card_model.py + D:\50 实拍）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ort from 'onnxruntime-web';
import { decodeModelOutput, frameParams, preprocessModelInput } from './cardCorrectMl';

const MODEL = resolve(process.cwd(), 'resources/card-model/card-correction-fp32.onnx');

const MODEL_EXISTS = (() => {
  try {
    readFileSync(MODEL);
    return true;
  } catch {
    return false;
  }
})();

/** 640×480 灰阶渐变 + 中心亮块（只为喂合法输入，不构成"卡面"样本） */
function simpleImage() {
  const w = 640;
  const h = 480;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inCard = x > 160 && x < 480 && y > 150 && y < 330;
      const v = inCard ? 235 : 60 + ((x / w) * 30) | 0;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v + 4;
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/** 本版本 ort d.ts 缺 inputNames/outputNames，运行时存在 */
type SessionWithNames = ort.InferenceSession & { inputNames: readonly string[]; outputNames: readonly string[] };

describe.skipIf(!MODEL_EXISTS)('卡证矫正 FP32 真实权重协议（慢：768² wasm 推理）', () => {
  it(
    '输入/输出协议与张量形状符合爱印 worker 假设',
    async () => {
      const buf = readFileSync(MODEL);
      const session = (await ort.InferenceSession.create(
        new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        { executionProviders: ['wasm'], graphOptimizationLevel: 'all' },
      )) as SessionWithNames;
      expect(session.inputNames).toContain('image');
      for (const n of ['scores', 'quads', 'angle', 'ftype']) {
        expect(session.outputNames).toContain(n);
      }
      const img = simpleImage();
      const input = preprocessModelInput(img, frameParams(img.width, img.height));
      expect(input.length).toBe(3 * 768 * 768);
      const out = await session.run({
        [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, 768, 768]),
      });
      const scores = out['scores']!.data as Float32Array;
      const quads = out['quads']!.data as Float32Array;
      const angle = out['angle']!.data as Float32Array;
      const ftype = out['ftype']!.data as Float32Array;
      // 候选数一致且坐标对齐（每候选 8 个数）
      expect(scores.length).toBeGreaterThan(0);
      expect(quads.length).toBe(scores.length * 8);
      expect(angle.length).toBe(scores.length);
      expect(ftype.length).toBe(scores.length);
      for (const arr of [scores, quads, angle, ftype]) {
        for (let i = 0; i < arr.length; i++) expect(Number.isNaN(arr[i])).toBe(false);
      }
      // scores ∈ [0,1]（sigmoid 类），angle ∈ [0,3]
      for (let i = 0; i < scores.length; i++) {
        expect(scores[i]).toBeGreaterThanOrEqual(0);
        expect(scores[i]).toBeLessThanOrEqual(1);
      }
      // decode 消费无损（阈值拉到 0 → 候选数 = scores.length，除非包含去重裁掉）
      const decoded = decodeModelOutput({ scores, quads, angle, ftype }, frameParams(img.width, img.height), 0.001);
      expect(decoded.length).toBeLessThanOrEqual(scores.length);
    },
    300_000,
  );
});
