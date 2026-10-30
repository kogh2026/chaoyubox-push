// onnxruntime-web 1.21 的 package.json exports 没把 types 映射出来（tsc bundler 解析不到），
// 这里按我们实际用到的最小 API 面补一份声明，避免引入整包类型导致解析失败。
declare module 'onnxruntime-web' {
  export class Tensor {
    constructor(type: 'float32' | 'uint8' | 'int32', data: Float32Array | Uint8Array | Int32Array, dims: number[]);
    readonly data: Float32Array;
  }

  export interface InferenceSession {
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
    release(): Promise<void>;
  }

  export const InferenceSession: {
    create(model: string | Uint8Array, options?: Record<string, unknown>): Promise<InferenceSession>;
  };

  export const env: {
    wasm: {
      wasmPaths: string | Record<string, string>;
      numThreads: number;
      simd: boolean;
    };
  };
}
