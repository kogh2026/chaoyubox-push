// 透视矫正 Worker（B4）：在后台线程做逐像素双线性重采样，主线程只负责投递与回显。
import { warpPixels, type Pt } from './cardDetect';

interface WarpRequest {
  id: number;
  data: Uint8ClampedArray;
  sw: number;
  sh: number;
  quadPx: Pt[];
  outW: number;
  outH: number;
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WarpRequest>) => void) | null;
  postMessage: (msg: unknown, transfer?: Transferable[]) => void;
};

scope.onmessage = (e) => {
  const { id, data, sw, sh, quadPx, outW, outH } = e.data;
  const out = warpPixels(data, sw, sh, quadPx, outW, outH);
  scope.postMessage({ id, out }, [out.buffer]);
};
