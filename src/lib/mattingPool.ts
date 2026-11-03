// 抠图 Worker 池（P1 批量加速）：把 N 张照片的推理派发给一组常驻 Worker 并发执行。
// 设计要点：
// - 主线程只负责投递与回收，WASM 推理全部在 Worker，UI 不再卡顿；
// - 任意环境（测试 / 老旧浏览器 / Electron 无法建 Worker）自动回退到主线程 matte，零功能回归；
// - Worker 启动失败或运行报错 → 标记 failed 并把剩余队列排空到主线程，保证任务最终完成。
import { matte, mattingPublicPath, mattingOrtPath, modnetModelUrl, type MatteInput, type ProgressFn } from './matting';
// 显式 ?worker 入口：强制 Vite 将抠图推理拆为独立 chunk（matting.worker 也 import @imgly，
// 若走 new URL 写法会被并入主包；用 ?worker 保证独立 Worker 产物）。
import MattingWorker from './matting.worker.ts?worker';

/** 抠图引擎类型与默认值都在 `matteEngine.ts`（那边不依赖 @imgly，谁都能安全引）；这里 re-export 保持旧导入路径可用 */
import {
  DEFAULT_MATTE_ENGINE,
  engineNeedsRefine,
  engineWorkerName,
  type MatteEngine,
} from './matteEngine';
export type { MatteEngine };
export { DEFAULT_MATTE_ENGINE };

let currentEngine: MatteEngine = DEFAULT_MATTE_ENGINE;
export function setMatteEngine(e: MatteEngine): void {
  currentEngine = e;
  // 引擎决定是否做边缘精修：`modnet-refine` 开，其余关。
  // 这样「开关」与「引擎」永远一致，不会出现面板显示精修、实际没跑的错位。
  edgeRefineStrength = engineNeedsRefine(e) ? EDGE_REFINE_DEFAULT_STRENGTH : 0;
}
export function getMatteEngine(): MatteEngine {
  return currentEngine;
}
/** 引擎可用性：MODNet 依赖桌面端预装模型（appres://），浏览器预览环境回退 ISNet */
export function matteEngineUsable(e: MatteEngine): boolean {
  if (e === 'isnet') return true;
  return !!modnetModelUrl();
}

/**
 * 并发 Worker 数上限 —— 批量吞吐的主要杠杆。
 *
 * 依据（2026-10-27 实测，tools/matting.bench.cjs，4 核）：
 * - 单张 21.3s 里 20.4s 是 ORT 推理，且 @imgly 恒把输入 resize 到 1024×1024，
 *   所以降输入分辨率几乎没用（4000×3000 → 1024×768 只省 7%）；
 * - 没开跨源隔离时 ORT 退化成单线程（numThreads 配了也用不上），
 *   因此「一张图一个 Worker」是唯一能线性吃满多核的办法：并行度 = Worker 数。
 *   故不再一刀切封顶 4（8 核机器上白丢一半算力），改为按核数 + 内存共同决定。
 * - 每个 Worker 常驻一份模型 + wasm（≈300MB），按可用内存再收一道，兜底封顶 8。
 */
export const MAX_MATTE = (() => {
  const cores =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  // deviceMemory：Chromium 提供的粗略可用内存（GiB），拿不到就按 8G 算
  const memGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const byMem = Math.floor((memGB * 1024 * 0.5) / 300); // 抠图最多占用一半内存
  return Math.max(1, Math.min(cores, byMem, 8));
})();

function cores(): number {
  return typeof navigator !== 'undefined' && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : 4;
}

/**
 * 每个 Worker 分到的 ORT 线程数：让「并发 Worker 数 × 线程数 ≈ 物理核数」。
 *
 * 背景：@imgly 写死 `ort.env.wasm.numThreads = navigator.hardwareConcurrency`，于是 4 个 Worker
 * 在 4 核机器上各开 4 线程 = 16 线程抢 4 个核 —— 实测单张从 8.3s 退化到 34s（吞吐 0.117 张/秒）。
 * 改成按并发度均分后（批量 4 Worker × 1 线程）单张回到 ~21s，吞吐 0.188 张/秒（1.6 倍）；
 * 单张导入时并发度为 1，仍可吃满 4 线程，不牺牲单张响应。
 */
export function matteThreads(parallel: number): number {
  return Math.max(1, Math.floor(cores() / Math.max(1, parallel)));
}

const workerUrl = MattingWorker;

interface Pending {
  input: MatteInput;
  onProgress?: ProgressFn;
  resolve: (b: Blob) => void;
  reject: (e: unknown) => void;
}

interface WorkerMsg {
  id: number;
  ok?: boolean;
  blob?: ArrayBuffer;
  error?: string;
  progress?: { key: string; current: number; total: number };
}

class MattePool {
  private workers: Worker[] = [];
  private busy = new Set<Worker>();
  private workerJob = new Map<Worker, number>();
  private queue: Pending[] = [];
  private map = new Map<number, Pending>();
  private failed = false;
  private seq = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  /** 当前这批 Worker 的 ORT 线程配额（null = 还没建） */
  private threads: number | null = null;

  /**
   * 线程配额变了就退休旧 Worker 重开 —— @imgly 的推理会话按 config 记忆化，
   * 线程数只在会话创建时生效，所以「单张（4 线程）→ 批量（1 线程）」必须换会话。
   * 只退休空闲 Worker；有任务在跑时等它们释放后由 pump 收尾，避免丢任务。
   */
  private retune(desired: number): boolean {
    if (this.threads === desired) return true;
    if (this.busy.size > 0) return false; // 等当前批次跑完再换
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.workerJob.clear();
    this.threads = desired;
    return true;
  }

  private spawn(): Worker | null {
    try {
      const w = new (workerUrl as new () => Worker)();
      w.onmessage = (e: MessageEvent<WorkerMsg>) => this.onMessage(w, e.data);
      w.onerror = () => this.onWorkerError(w);
      return w;
    } catch {
      return null;
    }
  }

  private onMessage(w: Worker, data: WorkerMsg): void {
    if (data.progress && data.id) {
      this.map.get(data.id)?.onProgress?.(data.progress.key, data.progress.current, data.progress.total);
      return;
    }
    const p = this.map.get(data.id);
    if (p) {
      this.map.delete(data.id);
      if (data.ok && data.blob) p.resolve(new Blob([data.blob], { type: 'image/png' }));
      else p.reject(new Error(data.error || 'worker 抠图失败'));
    }
    this.workerJob.delete(w);
    this.release(w);
  }

  private onWorkerError(w: Worker): void {
    this.failed = true;
    const id = this.workerJob.get(w);
    if (id != null) {
      this.map.get(id)?.reject(new Error('worker 抠图异常'));
      this.map.delete(id);
      this.workerJob.delete(w);
    }
    this.release(w);
  }

  private release(w: Worker): void {
    this.busy.delete(w);
    this.pump();
  }

  /** 把队列里能并发的就派发给空闲/新 Worker；实在跑不了就排空到主线程 */
  private pump(): void {
    if (this.queue.length === 0) return;
    // 按「当前实际并发度」分配 ORT 线程：单张时吃满全核，批量时均分，总数不超过物理核数
    // （否则 N 个 Worker 各开满核数 → 线程互相抢核，实测吞吐反而掉 40%）。
    const parallel = Math.min(MAX_MATTE, Math.max(1, this.busy.size + this.queue.length));
    // 换配额只对空闲 Worker 生效；有任务在跑时保持原配额继续派发，避免队列空转
    this.retune(matteThreads(parallel));
    while (this.queue.length > 0) {
      let w: Worker | undefined = this.workers.find((x) => !this.busy.has(x));
      if (!w && this.workers.length < MAX_MATTE) {
        const spawned = this.spawn();
        if (spawned) {
          this.workers.push(spawned);
          w = spawned;
        }
      }
      if (!w) break; // 全部 Worker 都在忙，等它们释放后再 pump
      const job = this.queue.shift()!;
      this.busy.add(w);
      const id = ++this.seq;
      this.map.set(id, job);
      this.workerJob.set(w, id);
      w.postMessage({
        id,
        file: job.input,
        publicPath: mattingPublicPath(),
        ortPath: mattingOrtPath(),
        modnetUrl: modnetModelUrl(),
        // `modnet-refine` 在推理阶段就是 MODNet —— 边缘精修是推理之后的像素运算，
        // 不需要另跑一个模型。这样「精修档」既快又无额外模型依赖。
        engine: engineWorkerName(currentEngine),
        // 边缘精修在 Worker 内就地做（颜色解混）。必须在 Worker 里做：
        // 主线程经 canvas 读 PNG 时 alpha=0 区域的 RGB 会被 premultiply 清零，
        // 那片区域恰恰是估计原底色的唯一可靠来源。
        refineStrength: edgeRefineStrength,
        refineKappa: EDGE_REFINE_KAPPA,
        threads: this.threads ?? matteThreads(parallel),
      });
    }
    // 只有「一个 Worker 都拿不到」才回退主线程。
    // 曾经这里写成 `queue.length > 0 → drainToMain`：批量 50 张时第一轮派发 4 个后
    // 队列还剩 46 个，于是剩余任务全部甩回主线程「并发」跑 —— Worker 池形同虚设，
    // 主线程被 ORT 占满（实测整段 428s 全是长任务）、内存涨到 5.6GB、还绕过了引擎选择
    // （主线程 matte() 恒用 ISNet，切「快速」也不生效）。Worker 忙只是排队，等 release 再泵。
    if (this.queue.length > 0 && this.workers.length === 0) this.drainToMain();
  }

  /** 无 Worker 可用时，把剩余任务在主线程跑完，保证不丢任务 */
  private drainToMain(): void {
    const jobs = this.queue.splice(0);
    this.failed = true;
    for (const j of jobs) {
      this.runOnMain(j.input, j.onProgress).then(j.resolve, j.reject);
    }
  }

  /** 主线程回退必须串行：一次一张。否则 N 张同时起 ORT 会话会把 UI 线程彻底锁死。 */
  private mainChain: Promise<unknown> = Promise.resolve();
  private runOnMain(input: MatteInput, onProgress?: ProgressFn): Promise<Blob> {
    const p = this.mainChain.then(() => matte(input, onProgress));
    this.mainChain = p.catch(() => undefined);
    return p;
  }

  run(input: MatteInput, onProgress?: ProgressFn): Promise<Blob> {
    if (this.failed || typeof Worker === 'undefined') {
      return this.runOnMain(input, onProgress);
    }
    return new Promise<Blob>((resolve, reject) => {
      this.queue.push({ input, onProgress, resolve, reject });
      // 延后一拍再派发：批量导入时 React 会在同一轮里连续投递 N 张，
      // 等这一轮排完队再统一决定「并发度 → 每 Worker 线程数」，
      // 否则第一张会按「单张」拿满核数，后面全部跟着超订线程。
      if (this.pumpTimer === null) {
        this.pumpTimer = setTimeout(() => {
          this.pumpTimer = null;
          this.pump();
        }, 0);
      }
    });
  }
}

let pool: MattePool | null = null;

/**
 * 边缘精修强度（0~1），0 = 关闭。
 *
 * 为什么放在池外而不是 Worker 内：精修是纯 CPU 逐像素运算，跑在主线程会卡 UI；
 * 但它的开销远小于模型推理（见 docs/v4-edge-refine.md 的实测），且放在主线程
 * 能复用同一份 canvas，避开 Worker↔主线程的 Blob 传输开销。
 */
let edgeRefineStrength = 0;

/** 边缘精修默认强度（`modnet-refine` 引擎用）。实测 0.8 已能清掉绝大部分晕边且不伤细节。 */
export const EDGE_REFINE_DEFAULT_STRENGTH = 0.8;

/** 边缘精修激进度（越小越激进）。0.35 为实测平衡点：低 alpha 修得够狠、噪点可控。 */
export const EDGE_REFINE_KAPPA = 0.35;

/** 设置边缘精修强度（0~1）。0 = 关闭。 */
export function setEdgeRefineStrength(s: number): void {
  edgeRefineStrength = Math.max(0, Math.min(1, s));
}

/** 读取当前边缘精修强度。 */
export function getEdgeRefineStrength(): number {
  return edgeRefineStrength;
}

/**
 * 抠图入口：自动走 Worker 池；不支持时回退主线程。可直接作为 cachedMatte 的 runner。
 *
 * 边缘精修在 **Worker 内**就地完成（见 `matting.worker.ts` 的 `refineInWorker`）：
 * 主线程若想自己做，必须经 canvas 读 PNG，而 canvas 是 premultiplied 存储 ——
 * alpha=0 区域的 RGB 会被清零，那片区域恰恰是估计原底色的唯一可靠来源，
 * 估出来会是 (0,0,0)，解混全错。
 */
export function poolMatte(input: MatteInput, onProgress?: ProgressFn): Promise<Blob> {
  if (!pool) pool = new MattePool();
  return pool.run(input, onProgress);
}
