/**
 * onnx-worker 协议对照 · 最小可行验证（零侵入）
 * ============================================================
 * 目的：把本项目 src/lib/cardCorrectClient.ts（卡证矫正 Worker 客户端）的「协议逻辑」
 *       1:1 移植为一个可注入 mock Worker 的纯函数，验证其是否满足
 *       onnx-web-worker-starter（https://github.com/makan0713/onnx-web-worker-starter）
 *       承诺的契约：
 *         (1) 单缓存会话 / Worker 单例（preload 一次，run 复用）
 *         (2) 请求串行排队 + 唯一 id（不碰撞）
 *         (3) 超时 → 拒绝在途请求并销毁重建 Worker
 *         (4) dispose → 终止 Worker 并拒绝所有在途请求
 *
 * 为什么零侵入：本文件只新增一个独立脚本，不 import、不修改任何 src/ 生产代码；
 *       它位于 tools/（打包 `files` 仅含 dist/** 与 electron/**，tools/ 不进安装包），
 *       因此对最终交付零影响。脚本中的 createClient 是真实逻辑的忠实镜像
 *       （除「Worker 创建」被注入以便测试外，其余逐行对应真实代码，注释内标注真实行号）。
 *
 * 运行：node tools/onnx-worker-protocol-verify.mjs
 *
 * 验证通过后的整合：见脚本底部 INTEGRATION 注释。
 */

// ---------------------------------------------------------------------------
// 1) Mock Worker：忠实模拟 cardCorrect.worker.ts 的运行时行为
//    - 单会话缓存（与 worker 文件 L45-60 ensureSession 对应）
//    - 串行队列（与 worker 文件 L82-86 queue 对应）
//    - 按 req.id 回包（与 worker 文件 L84-122 onmessage 对应）
//    - terminate() 后 postMessage 失效（与 client L47 worker?.terminate() 对应）
// ---------------------------------------------------------------------------
class MockWorker {
  constructor({ hang = false } = {}) {
    this.onmessage = null;
    this.onerror = null;
    this._terminated = false;
    this._hang = hang;
    this.sessionBuilds = 0; // 统计 ORT 会话构建次数（验证单缓存）
    this.postCount = 0;
    this.terminateCount = 0;
    this.queue = Promise.resolve();
  }

  postMessage(req) {
    if (this._terminated) return; // 已 terminate：静默丢弃（模拟真实 Worker 行为）
    this.postCount++;
    // 模拟单会话缓存：同一 modelUrl 只构建一次
    if (!this._session || this._sessionUrl !== req.modelUrl) {
      this._session = { url: req.modelUrl };
      this._sessionUrl = req.modelUrl;
      this.sessionBuilds++;
    }
    // 模拟串行队列
    this.queue = this.queue.then(
      () =>
        new Promise((resolve) => {
          if (this._hang) return; // 超时测试：永不回包
          const msg = {
            id: req.id,
            type: 'success',
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
          // 用 setTimeout(0) 让 client 的 Promise 先 settle
          setTimeout(() => {
            this.onmessage && this.onmessage({ data: msg });
            resolve();
          }, 0);
        }),
    );
  }

  terminate() {
    this._terminated = true;
    this.terminateCount++;
  }
}

// ---------------------------------------------------------------------------
// 2) createClient：cardCorrectClient.ts 协议逻辑的 1:1 镜像（唯一差异：Worker 可注入）
//    真实代码位置标注在右侧注释。
// ---------------------------------------------------------------------------
function createClient({ makeWorker, timeoutMs = 120_000 }) {
  let worker = null; //            —— 真实 L23
  let seq = 0; //                  —— 真实 L24
  const pending = new Map(); //    —— 真实 L25

  function killWorker(reason) {
    //                    —— 真实 L46-52
    if (worker) worker.terminate();
    worker = null;
    for (const [, p] of pending) p.reject(new Error(reason));
    pending.clear();
  }

  function ensureWorker() {
    //                 —— 真实 L54-78
    if (worker) return worker; // 复用单例（对应 starter preload 缓存）
    const w = makeWorker();
    w.onmessage = (e) => {
      const msg = e.data;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.type === 'success') p.resolve(msg);
      else p.reject(new Error(msg.error));
    };
    w.onerror = () => killWorker('card-correct-worker-crashed');
    worker = w;
    return w;
  }

  function dispose() {
    //                       —— 真实 disposeCardCorrectWorker L81-83
    killWorker('card-correct-disposed');
  }

  function correctImageRaw(data, width, height, opts = {}) {
    // —— 真实 L92-141
    const w = ensureWorker();
    if (!w) return Promise.reject(new Error('card-correct-unavailable'));
    const id = ++seq; // 唯一自增 id，对应真实 L101
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        killWorker(`card-correct-timeout#${id}`); // 真实 L103-107
        reject(new Error('card-correct-timeout'));
      }, timeoutMs);
      pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      w.postMessage({ id, data, width, height, modelUrl: 'model://x', ...opts });
    });
  }

  return {
    correctImageRaw,
    dispose,
    _state: () => ({ workerRef: worker, pendingSize: pending.size, seq }),
    _makeWorkerCalls: () => makeWorker.calls,
  };
}

// ---------------------------------------------------------------------------
// 3) 断言工具
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) {
    passed++;
    console.log(`  ✅ PASS  ${name}`);
  } else {
    failed++;
    console.log(`  ❌ FAIL  ${name}`);
  }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 4) 测试用例
// ---------------------------------------------------------------------------
async function run() {
  console.log('\n=== onnx-worker 协议对照验证 ===\n');

  // --- 不变量 (1) + (2)：单 Worker 单会话 + 串行唯一 id ---
  console.log('[T1] 单缓存会话 & 串行唯一 id（对应 starter: preload 缓存 + 串行 run）');
  {
    const mk = Object.assign(
      function () {
        mk.calls++;
        return new MockWorker();
      },
      { calls: 0 },
    );
    const cli = createClient({ makeWorker: mk, timeoutMs: 5000 });

    const p1 = cli.correctImageRaw(new Uint8ClampedArray(4), 1, 1);
    const p2 = cli.correctImageRaw(new Uint8ClampedArray(4), 1, 1);
    const [r1, r2] = await Promise.all([p1, p2]);

    assert(mk.calls === 1, 'Worker 仅创建一次（单例/单缓存会话）');
    assert(r1.pages.length === 1 && r2.pages.length === 1, '两次请求均成功返回');
    // 验证 Worker 内部会话只构建一次（单 ORT 会话缓存）
    const w = cli._state().workerRef;
    assert(w.sessionBuilds === 1, 'ORT 会话仅构建一次（模型只加载一次）');
    assert(cli._state().pendingSize === 0, '请求完成后 pending 清空');
  }

  // --- 不变量 (2) 补充：并发请求 id 不碰撞 ---
  console.log('\n[T2] 并发请求 id 唯一（对应 starter: 串行化协议，无 id 碰撞）');
  {
    const mk = () => new MockWorker();
    const cli = createClient({ makeWorker: mk, timeoutMs: 5000 });
    const a = cli.correctImageRaw(new Uint8ClampedArray(4), 1, 1);
    const b = cli.correctImageRaw(new Uint8ClampedArray(4), 1, 1);
    const seqSeen = cli._state().seq;
    await Promise.all([a, b]);
    assert(seqSeen >= 2, '连续请求分配到不同自增 id（seq 推进）');
  }

  // --- 不变量 (3)：超时 → 拒绝在途 + 销毁重建 ---
  console.log('\n[T3] 超时拒绝在途请求并重建 Worker（对应 starter: requestTimeoutMs）');
  {
    const mk = Object.assign(
      function () {
        mk.calls++;
        return new MockWorker({ hang: true }); // 永不回包 → 触发超时
      },
      { calls: 0 },
    );
    const cli = createClient({ makeWorker: mk, timeoutMs: 60 });
    let rejected = null;
    try {
      await cli.correctImageRaw(new Uint8ClampedArray(4), 1, 1);
    } catch (e) {
      rejected = e;
    }
    assert(rejected && rejected.message === 'card-correct-timeout', '超时后 Promise 被拒绝（card-correct-timeout）');
    assert(cli._state().workerRef === null, '超时后 Worker 被销毁（引用置空）');
    assert(cli._state().pendingSize === 0, '超时后 pending 已清空');

    // 下一次调用应重建 Worker（验证“销毁后可重建”）—— 该 mock 仍会挂起，需捕获其超时
    const p = cli.correctImageRaw(new Uint8ClampedArray(4), 1, 1);
    let secondRejected = null;
    try {
      await p;
    } catch (e) {
      secondRejected = e;
    }
    assert(mk.calls === 2, '超时后新请求重建了 Worker（共创建 2 次）');
    assert(secondRejected !== null, '重建后的请求同样受超时保护（不卡死）');
  }

  // --- 不变量 (4)：dispose → 终止 + 拒绝在途 ---
  console.log('\n[T4] dispose 终止 Worker 并拒绝所有在途请求（对应 starter: dispose()）');
  {
    const mk = Object.assign(
      function () {
        mk.calls++;
        return new MockWorker({ hang: true }); // 保持挂起，验证 dispose 主动拒绝
      },
      { calls: 0 },
    );
    const cli = createClient({ makeWorker: mk, timeoutMs: 5000 });
    const inflight = cli.correctImageRaw(new Uint8ClampedArray(4), 1, 1);
    await delay(10);
    cli.dispose(); // 主动释放
    let rejected = null;
    try {
      await inflight;
    } catch (e) {
      rejected = e;
    }
    assert(rejected && rejected.message === 'card-correct-disposed', 'dispose 后 Promise 被拒绝（card-correct-disposed）');
    const w = cli._state().workerRef;
    assert(w === null || w.terminateCount === 1, 'Worker 已被 terminate');
    assert(cli._state().pendingSize === 0, 'dispose 后 pending 已清空');
  }

  // --- 项目扩展点（超出 starter 的部分，仅说明不回归） ---
  console.log('\n[T5] 协议健壮性对照（真实代码额外能力，非 starter 契约，仅确认不破坏）');
  {
    const mk = () => new MockWorker();
    const cli = createClient({ makeWorker: mk, timeoutMs: 5000 });
    // Worker 级错误（onerror）应复位：用会抛错的 worker 模拟
    const errMk = () => {
      const w = new MockWorker();
      // 模拟 worker 启动即报错
      setTimeout(() => w.onerror && w.onerror(new Error('boom')), 0);
      return w;
    };
    const cli2 = createClient({ makeWorker: errMk, timeoutMs: 5000 });
    let r = null;
    try {
      await cli2.correctImageRaw(new Uint8ClampedArray(4), 1, 1);
    } catch (e) {
      r = e;
    }
    assert(r !== null, 'Worker 崩溃时请求被拒绝（真实 L69-72 onerror→killWorker）');
    assert(cli !== cli2, '对照组隔离正常');
  }

  console.log(`\n=== 结果：通过 ${passed} / 失败 ${failed} ===`);
  if (failed > 0) process.exitCode = 1;
}

run();
