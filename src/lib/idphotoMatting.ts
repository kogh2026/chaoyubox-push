// 证件照「标准抠图」管线模块 —— 按爱印 matting-v1 逆向规格的干净实现
// 规格来源：2026-10-28 对爱印 v0.5.0 加密资产的只读静态分析（详见 aiyin-idphoto-architecture.md）。
// 不含任何爱印代码；权重用开源 MODNet。
//
// 2026-10-28 补充实证（见 aiyin-vs-open-implementation.md）：
//   爱印 matting-v1 的 ONNX 图与开源 MODNet **同构**（算子直方图逐项相同、215 个初始化器逐一对应、
//   参数 6.460M 完全一致），差异仅为其权重被转成 **float16** 并插入 65 个 Cast；
//   同输入下两模型 alpha 的 IoU ≈ 0.9999。即本模块使用 MODNet fp32 权重即与原件数值等价，
//   交接点：fp16 版体积 13.0MB（-50%），但 wasm 单线程推理慢约 19%。
//
// 逆向确认的管线规范：
//   1. 预处理：RGBA → NCHW float32；RGB 各通道 /255；归一化 "half"=(x-127.5)/127.5，
//      或 "imagenet"=（x/255-mean)/std（mean/std 内置常量，当前模型未用，保留兼容）。
//   2. 输入尺寸：边长必须为 32 的倍数（动态分辨率，默认 512）。
//   3. 推理：ort-wasm；numThreads=min(4, cores-1)，需 SharedArrayBuffer，否则单线程；
//      多线程推理失败自动降级单线程重试（retrySingleThread）。
//   4. 后处理：输出支持 float16/float32；"logits" 类型过 sigmoid，"alpha"/"blend" 直出；
//      最终 clamp 到 [0,1]。blend 为 3 通道。
//   5. 阶段打点：tensor-prepare / inference / output-decode。

/** 模型配置（与逆向出的注册表字段一一对应） */
export interface MattingModelConfig {
  id: string;
  label: string;
  /** 模型标称输入边长（实际允许 32 倍数动态分辨率） */
  inputSize: number;
  /** 归一化方式：half=(x-127.5)/127.5；imagenet=逐通道 mean/std */
  normalization: 'half' | 'imagenet';
  /** 输出语义：alpha=单通道直出；logits=单通道需 sigmoid；blend=3 通道直出 */
  output: 'alpha' | 'logits' | 'blend';
  /** 模型是否可选（缺失时跳过而非报错） */
  optional?: boolean;
}

/** 内置注册表：matting-v1 档用开源 MODNet 权重（input/output 张量名与原规格一致） */
export const MATTING_MODELS: Record<string, MattingModelConfig> = {
  'matting-v1': {
    id: 'matting-v1',
    label: '标准抠图模型',
    inputSize: 512,
    normalization: 'half',
    output: 'alpha',
  },
};

/** ImageNet 归一化常量（规格内置，imagenet 档用） */
export const IMAGENET_MEAN = [0.485, 0.456, 0.406];
export const IMAGENET_STD = [0.229, 0.224, 0.225];

/** 尺寸约束：边长必须是 32 的倍数 */
export const SIZE_DIVISIBILITY = 32;
/** 线程上限：min(cap, cores-1) */
export const THREAD_CAP = 4;

/** 输入尺寸校验：非 32 倍数直接报错（与原规格一致，不做静默取整） */
export function isValidModelInputSize(w: number, h: number): boolean {
  return (
    Number.isInteger(w) &&
    Number.isInteger(h) &&
    w >= SIZE_DIVISIBILITY &&
    h >= SIZE_DIVISIBILITY &&
    w % SIZE_DIVISIBILITY === 0 &&
    h % SIZE_DIVISIBILITY === 0
  );
}

/**
 * 线程数策略：无 SharedArrayBuffer → 1；否则 min(4, cores-1)，至少 1。
 * cores<2 或非法值也返回 1。
 */
export function computeThreadCount(cores: unknown, hasSharedArrayBuffer: boolean): number {
  if (!hasSharedArrayBuffer) return 1;
  if (typeof cores !== 'number' || !Number.isFinite(cores) || cores < 2) return 1;
  return Math.max(1, Math.min(THREAD_CAP, Math.floor(cores) - 1));
}

/**
 * RGBA → NCHW float32（平面排布 [R 平面, G 平面, B 平面]）。
 * rgba 长度必须等于 w*h*4，否则报错（原规格行为）。
 */
export function rgbaToModelInput(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  normalization: MattingModelConfig['normalization'],
): Float32Array {
  const px = w * h;
  if (rgba.length !== px * 4) {
    throw new Error(`模型输入尺寸错误：收到 ${rgba.length} 个 RGBA 值，期望 ${px * 4}。`);
  }
  const out = new Float32Array(px * 3);
  for (let i = 0; i < px; i++) {
    const j = i * 4;
    const r = rgba[j] / 255;
    const g = rgba[j + 1] / 255;
    const b = rgba[j + 2] / 255;
    if (normalization === 'half') {
      out[i] = (r - 0.5) / 0.5;
      out[px + i] = (g - 0.5) / 0.5;
      out[2 * px + i] = (b - 0.5) / 0.5;
    } else {
      out[i] = (r - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
      out[px + i] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
      out[2 * px + i] = (b - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
    }
  }
  return out;
}

/** float16 位型 → float32（IEEE 754 半精度手动解码，规格行为） */
export function halfBitsToFloat(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 0x1f) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

export interface TensorLike {
  data: Float32Array | Uint16Array | Float64Array;
  dims: readonly number[];
  type: string;
}

/**
 * 模型输出解码：
 * - float16 张量先逐元素转 float32；
 * - "logits" 过 sigmoid，"alpha"/"blend" 直出；
 * - 全部 clamp 到 [0,1]；
 * - blend 取 3 通道，其余 1 通道。
 * 输出元素数不足时报错（与原规格一致）。
 */
export function decodeModelOutput(
  tensor: TensorLike,
  outputKind: MattingModelConfig['output'],
  count: number,
): Float32Array {
  const channels = outputKind === 'blend' ? 3 : 1;
  const r = count * channels;
  if (tensor.data.length < r) {
    throw new Error(`模型输出尺寸错误：${tensor.dims.join(' × ')}。`);
  }
  const isF16 = tensor.type === 'float16';
  const offset = tensor.data.length - r; // 取末尾 r 个（兼容带余量的输出布局）
  const out = new Float32Array(r);
  for (let i = 0; i < r; i++) {
    const raw = tensor.data[offset + i];
    const v = isF16 ? halfBitsToFloat(Number(raw)) : Number(raw);
    const g = outputKind === 'logits' ? 1 / (1 + Math.exp(-v)) : v;
    out[i] = Math.min(1, Math.max(0, g));
  }
  return out;
}

/** 最小会话接口：与 onnxruntime-web InferenceSession 结构兼容，便于注入桩 */
export interface SessionLike {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, { type: string; data: Float32Array; dims: readonly number[] }>): Promise<Record<string, TensorLike>>;
}

export interface MattingRunResult {
  /** 解码后的 alpha（或 blend 的 3 通道），长度 count 或 count*3 */
  output: Float32Array;
  inferenceMs: number;
  timing: { prepareMs: number; decodeMs: number };
  threads: number;
}

/**
 * 单次推理（纯函数，无 DOM，Worker/Node 通用）：
 * 预处理 → run → 解码，含阶段计时。输入尺寸不合规直接抛错。
 */
export async function runMattingInference(
  session: SessionLike,
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  config: MattingModelConfig = MATTING_MODELS['matting-v1'],
  threads = 1,
): Promise<MattingRunResult> {
  if (!isValidModelInputSize(w, h)) {
    throw new Error(`模型输入尺寸错误：${w} × ${h}。边长必须是 ${SIZE_DIVISIBILITY} 的倍数。`);
  }
  const t0 = performance.now();
  const input = rgbaToModelInput(rgba, w, h, config.normalization);
  const t1 = performance.now();
  const feedName = session.inputNames[0];
  if (!feedName) throw new Error('模型没有声明输入。');
  let raw: Record<string, TensorLike>;
  try {
    raw = await session.run({ [feedName]: { type: 'float32', data: input, dims: [1, 3, h, w] } });
  } catch (err) {
    if (threads > 1) {
      // 规格行为：多线程推理失败 → 抛可重试错误，由上层降级单线程
      const e = new Error(err instanceof Error ? err.message : String(err)) as Error & { retrySingleThread?: boolean };
      e.retrySingleThread = true;
      throw e;
    }
    throw err;
  }
  const t2 = performance.now();
  const outName = session.outputNames[0];
  const tensor = outName ? raw[outName] : undefined;
  if (!tensor) throw new Error('模型没有返回输出。');
  const output = decodeModelOutput(tensor, config.output, w * h);
  const t3 = performance.now();
  return {
    output,
    inferenceMs: Math.round(t2 - t1),
    timing: { prepareMs: Math.round(t1 - t0), decodeMs: Math.round(t3 - t2) },
    threads,
  };
}

/** alpha（1 通道）→ 写回 RGBA 的 A 通道（输出 PNG 前的最后一步；RGB 保留原值，抠图即为透明） */
export function applyAlphaToRGBA(rgba: Uint8ClampedArray, alpha: Float32Array): void {
  for (let i = 0; i < alpha.length; i++) {
    rgba[i * 4 + 3] = Math.round(alpha[i] * 255);
  }
}
