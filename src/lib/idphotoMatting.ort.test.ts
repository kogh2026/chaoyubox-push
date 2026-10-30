// 端到端集成测试：真实开源权重（MODNet ONNX）走复刻管线 —— 规范一致性 + 质量 sanity
// 运行条件：resources/matting-model/modnet/modnet.onnx 存在（桌面端预装）。
// 说明：爱印私有权重不可用于产品，故质量验证基准为「合成人像 sanity」，
//       规范一致性由 idphotoMatting.test.ts 逐项保证。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ort from 'onnxruntime-web';
import {
  MATTING_MODELS,
  isValidModelInputSize,
  runMattingInference,
  type SessionLike,
} from './idphotoMatting';

const MODEL = resolve(process.cwd(), 'resources/matting-model/modnet/modnet.onnx');

/** 512×512 合成人像：中央椭圆"头部"（肤色）+ 连体梯形"躯干"（深色衣服），其余为纯色背景 */
function syntheticPortrait(w = 512, h = 512): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  const cx = w / 2, cy = h * 0.32, rx = w * 0.16, ry = h * 0.2;
  const neckTop = h * 0.5;     // 颈部起点（与头部下缘重叠，保证连体）
  for (let y = 0; y < h; y++) {
    // 躯干：颈部向下展宽的梯形
    const t = Math.min(1, Math.max(0, (y - neckTop) / (h * 0.3)));
    const halfW = w * (0.08 + 0.24 * t);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inHead = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
      const inBody = y >= neckTop && Math.abs(x - cx) <= halfW;
      if (inHead) { d[i] = 224; d[i + 1] = 172; d[i + 2] = 150; }
      else if (inBody) { d[i] = 60; d[i + 1] = 70; d[i + 2] = 90; }
      else { d[i] = 30; d[i + 1] = 140; d[i + 2] = 60; } // 绿幕背景
      d[i + 3] = 255;
    }
  }
  return d;
}

describe.skipIf(!(() => { try { readFileSync(MODEL); return true; } catch { return false; } })())(
  'MODNet 真实权重端到端（慢，需 onnx wasm 推理）',
  () => {
    it(
      '复刻管线输出：alpha ∈ [0,1]，人像区域高、背景区域低',
      async () => {
        const buf = readFileSync(MODEL);
        const session = await ort.InferenceSession.create(
          new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
          { executionProviders: ['wasm'], graphOptimizationLevel: 'all' },
        ) as ort.InferenceSession & { inputNames: readonly string[]; outputNames: readonly string[] };
        // 适配 SessionLike：模块喂的是纯对象张量（保持 DOM-free 可桩测），
        // 在此边界把规格张量转成真 ort.Tensor 再交给真实会话。
        const s: SessionLike = {
          inputNames: session.inputNames,
          outputNames: session.outputNames,
          async run(feeds) {
            const name = Object.keys(feeds)[0]!;
            const f = feeds[name]!;
            const t = new ort.Tensor('float32', f.data, f.dims as number[]);
            const out = await session.run({ [name]: t });
            return out as unknown as Record<string, { data: Float32Array; dims: readonly number[]; type: string }>;
          },
        };
        const W = 512, H = 512;
        expect(isValidModelInputSize(W, H)).toBe(true);
        const rgba = syntheticPortrait(W, H);
        const r = await runMattingInference(s, rgba, W, H, MATTING_MODELS['matting-v1'], 1);
        expect(r.output.length).toBe(W * H);

        // 1) 值域 clamp 保证
        let min = 1, max = 0;
        for (let i = 0; i < r.output.length; i++) {
          if (r.output[i] < min) min = r.output[i];
          if (r.output[i] > max) max = r.output[i];
        }
        expect(min).toBeGreaterThanOrEqual(0);
        expect(max).toBeLessThanOrEqual(1);

        // 2) 质量 sanity：头部中心 alpha 应显著高于背景角落
        const at = (x: number, y: number) => r.output[y * W + x];
        const head = at(256, 195);          // 椭圆中心
        const bgCorner = at(10, 10);        // 背景
        const body = at(256, 460);          // 肩部
        expect(head).toBeGreaterThan(0.6);
        expect(bgCorner).toBeLessThan(0.4);
        expect(body).toBeGreaterThan(0.5);

        // 3) 阶段计时齐备
        expect(r.timing.prepareMs).toBeGreaterThanOrEqual(0);
        expect(r.inferenceMs).toBeGreaterThanOrEqual(0);
        expect(r.timing.decodeMs).toBeGreaterThanOrEqual(0);
      },
      120_000,
    );
  },
);
