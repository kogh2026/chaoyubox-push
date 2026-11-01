/**
 * onnx-worker 协议对照 · 单元测试（针对真实代码）
 * ============================================================
 * 本文件把 tools/onnx-worker-protocol-verify.mjs 的「镜像」升级为对真实代码的回归测试：
 *   - 通过 __setWorkerFactoryForTest 注入 mock Worker（不改动任何生产协议逻辑）；
 *   - 直接调用真实 exported 函数 correctImageRaw / disposeCardCorrectWorker，
 *     从而真实驱动 ensureWorker / killWorker / 超时 / dispose 路径。
 *
 * 生产改动范围：仅 cardCorrectClient.ts 新增「可覆盖 Worker 工厂 + __setWorkerFactoryForTest」
 *               （对应升级方案的「第 1 步」），本文件为「第 2 步」。除此之外零重构。
 *
 * 运行：npx vitest run src/lib/cardCorrectClient.protocol.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  correctImageRaw,
  disposeCardCorrectWorker,
  __setWorkerFactoryForTest,
} from './cardCorrectClient';

// ---------------------------------------------------------------------------
// Mock Worker：忠实模拟 cardCorrect.worker.ts 的运行时行为
//   - 单会话缓存（同一 modelUrl 只“构建”一次 ORT 会话）
//   - 按 req.id 回包（onmessage）
//   - terminate() 后 postMessage 静默失效
//   - hang：永不回包（触发超时）；crash：构造后触发 onerror（触发复位）
// ---------------------------------------------------------------------------
class MockWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  sessionBuilds = 0;
  terminateCount = 0;
  postCount = 0;
  idsSeen: number[] = [];
  private sessionUrl: string | null = null;
  private terminated = false;
  constructor(private opts: { hang?: boolean; crash?: boolean } = {}) {
    if (opts.crash) {
      // 模拟 Worker 启动即崩溃：等客户端装好 onerror 后再触发
      setTimeout(() => this.onerror?.(new Error('crash') as unknown as ErrorEvent), 0);
    }
  }
  postMessage(req: { id: number; modelUrl?: string }): void {
    if (this.terminated) return; // 已 terminate：静默丢弃（模拟真实 Worker 行为）
    this.postCount++;
    this.idsSeen.push(req.id);
    // 模拟单会话缓存：同一 modelUrl 只“构建”一次
    if (!this.sessionUrl || this.sessionUrl !== (req.modelUrl ?? null)) {
      this.sessionUrl = req.modelUrl ?? null;
      this.sessionBuilds++;
    }
    if (this.opts.hang || this.opts.crash) return; // 挂起 / 崩溃：不回包
    setTimeout(() => {
      const msg = {
        id: req.id,
        type: 'success' as const,
        pages: [
          {
            angle: 0,
            corners: [],
            uprightCorners: [],
            uprightTurns: 0,
            score: 0.9,
            data: new Uint8ClampedArray(4),
            width: 1,
            height: 1,
          },
        ],
        passes: 1,
        room: 0.1,
        inferMs: 1,
      };
      this.onmessage?.({ data: msg } as MessageEvent);
    }, 0);
  }
  terminate(): void {
    this.terminated = true;
    this.terminateCount++;
  }
}

/** 构造一个「记录所创建实例」的 mock 工厂，便于断言 Worker 创建次数与内部状态 */
function makeFactory(opts: { hang?: boolean; crash?: boolean } = {}) {
  const created: MockWorker[] = [];
  const factory = (): Worker => {
    const w = new MockWorker(opts);
    created.push(w);
    return w as unknown as Worker;
  };
  return { factory, created };
}

beforeEach(() => {
  // 让 resBase() 返回真值，真实 correctImageRaw 才会进入 Worker 创建分支（而非直接 reject unavailable）
  (globalThis as unknown as { window?: unknown }).window = {
    electronAPI: { appResBase: 'appres://res/' },
  };
  // 清空模块级单例与在途请求，保证用例间隔离（同时取消空闲卸载计时器）
  disposeCardCorrectWorker();
});

afterEach(() => {
  disposeCardCorrectWorker();
  vi.useRealTimers();
});

describe('cardCorrectClient 协议（对照 onnx-web-worker-starter 契约）', () => {
  // 不变量 (1) + (2)：单 Worker 单会话 + 串行唯一 id
  it('T1 单缓存会话 & 串行唯一 id（preload 缓存 + 串行 run）', async () => {
    const { factory, created } = makeFactory();
    __setWorkerFactoryForTest(factory);

    const [r1, r2] = await Promise.all([
      correctImageRaw(new Uint8ClampedArray(4), 1, 1),
      correctImageRaw(new Uint8ClampedArray(4), 1, 1),
    ]);

    expect(created.length).toBe(1); // Worker 仅创建一次（单例 / 单缓存会话）
    expect(r1.pages.length).toBe(1);
    expect(r2.pages.length).toBe(1);
    expect(created[0].sessionBuilds).toBe(1); // ORT 会话仅构建一次（模型只加载一次）
    expect(new Set(created[0].idsSeen).size).toBe(2); // 两次请求分配不同 id，无碰撞
  });

  // 不变量 (2) 补充：并发请求 id 不碰撞
  it('T2 并发请求 id 不碰撞（串行排队）', async () => {
    const { factory, created } = makeFactory();
    __setWorkerFactoryForTest(factory);

    const a = correctImageRaw(new Uint8ClampedArray(4), 1, 1);
    const b = correctImageRaw(new Uint8ClampedArray(4), 1, 1);
    await Promise.all([a, b]);

    expect(created.length).toBe(1); // 单个 Worker 串行处理两个请求
    expect(new Set(created[0].idsSeen).size).toBe(2); // 每个请求唯一 id
  });

  // 不变量 (3)：超时 → 拒绝在途 + 销毁重建
  it('T3 超时拒绝在途请求并重建 Worker（requestTimeoutMs）', async () => {
    vi.useFakeTimers();
    const { factory, created } = makeFactory({ hang: true });
    __setWorkerFactoryForTest(factory);

    let rejected: Error | null = null;
    try {
      const p = correctImageRaw(new Uint8ClampedArray(4), 1, 1);
      vi.advanceTimersByTime(121_000); // 越过真实 REQUEST_TIMEOUT_MS(120s)
      await p;
    } catch (e) {
      rejected = e as Error;
    }
    expect(rejected?.message).toBe('card-correct-timeout');

    // 超时后再次调用应重建 Worker（worker 引用被置空 → ensureWorker 重建）
    correctImageRaw(new Uint8ClampedArray(4), 1, 1).catch(() => null);
    expect(created.length).toBe(2); // 重建：共创建 2 个 Worker
    vi.useRealTimers();
  });

  // 不变量 (4)：dispose → 终止 + 拒绝在途
  it('T4 dispose 终止 Worker 并拒绝所有在途请求（dispose()）', async () => {
    const { factory, created } = makeFactory({ hang: true });
    __setWorkerFactoryForTest(factory);

    const inflight = correctImageRaw(new Uint8ClampedArray(4), 1, 1);
    await new Promise((r) => setTimeout(r, 10)); // 让请求进入在途
    disposeCardCorrectWorker(); // 主动释放

    let rejected: Error | null = null;
    try {
      await inflight;
    } catch (e) {
      rejected = e as Error;
    }
    expect(rejected?.message).toBe('card-correct-disposed');
    expect(created[0].terminateCount).toBe(1); // Worker 已被 terminate

    // dispose 后再次调用应重建 Worker（worker 引用已置空 → ensureWorker 重建）。
    // 用新的「非挂起」工厂做重建断言，避免再次 await 挂起请求导致测试挂死。
    const f2 = makeFactory(); // 非挂起
    __setWorkerFactoryForTest(f2.factory);
    await correctImageRaw(new Uint8ClampedArray(4), 1, 1);
    expect(f2.created.length).toBe(1); // 重建出了一个新 Worker（而非复用已被 terminate 的旧 Worker）
    expect(created.length).toBe(1); // 原工厂仍只创建了 1 个
  });

  // 项目扩展点（超出 starter 的能力，确认不破坏真实复位逻辑）
  it('T5 Worker 崩溃应复位并拒绝在途（真实 onerror → killWorker）', async () => {
    const { factory } = makeFactory({ crash: true });
    __setWorkerFactoryForTest(factory);

    let rejected: Error | null = null;
    try {
      await correctImageRaw(new Uint8ClampedArray(4), 1, 1);
    } catch (e) {
      rejected = e as Error;
    }
    expect(rejected).not.toBeNull();
    expect(rejected?.message).toBe('card-correct-worker-crashed');
  });
});
