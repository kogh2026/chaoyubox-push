// 空闲卸载器：最后一次活动后经过 idleMs 毫秒触发回调（用于释放 onnxruntime Worker）。
//
// 作用：card-correct 模型 41MB + wasm 常驻，长任务间歇期白白占内存。
// 复用「活跃工作集上限」思路——一段时间没推理就把 Worker  terminate 掉释放模型，
// 下次需要时 ensureWorker 再懒加载。纯计时逻辑、零 DOM / Worker 依赖，可单测。
//
// 注意：默认用 setTimeout / clearTimeout（Node 与浏览器都可用），测试可注入 scheduler。
export interface Scheduler {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

const DEFAULT_SCHEDULER: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export class IdleUnloader {
  private timer: unknown = null;
  private readonly idleMs: number;
  private readonly scheduler: Scheduler;

  constructor(
    private readonly onIdle: () => void,
    idleMs: number,
    scheduler: Scheduler = DEFAULT_SCHEDULER,
  ) {
    this.idleMs = Math.max(0, idleMs);
    this.scheduler = scheduler;
  }

  /** 记录一次活动：重置空闲计时。 */
  touch(): void {
    this.clear();
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      this.onIdle();
    }, this.idleMs);
  }

  /** 取消待触发的空闲回调（例如任务进行中）。 */
  clear(): void {
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 是否已在倒计时（便于调试/测试）。 */
  get pending(): boolean {
    return this.timer !== null;
  }
}
