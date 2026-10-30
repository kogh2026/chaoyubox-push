/** 抠图结果缓存（F14）测试：注入 runner 桩，不触发真实模型推理。 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cachedMatte, clearMatteCache } from './matting';

beforeEach(() => clearMatteCache());

function makeRunner() {
  const state = { calls: 0 };
  const runner = async () => {
    state.calls++;
    return new Blob([new Uint8Array([1])], { type: 'image/png' });
  };
  return { state, runner };
}

describe('cachedMatte', () => {
  it('同一对象输入：多次调用只跑一次推理（多规格复用）', async () => {
    const { state, runner } = makeRunner();
    const input = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });
    const [b1, b2, b3] = await Promise.all([
      cachedMatte(input, undefined, runner),
      cachedMatte(input, undefined, runner),
      cachedMatte(input, undefined, runner),
    ]);
    expect(state.calls).toBe(1);
    expect(b1).toBe(b2);
    expect(b2).toBe(b3);
  });

  it('不同对象输入：各自推理一次', async () => {
    const { state, runner } = makeRunner();
    const a = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
    const b = new File([new Uint8Array([2])], 'b.png', { type: 'image/png' });
    await cachedMatte(a, undefined, runner);
    await cachedMatte(b, undefined, runner);
    expect(state.calls).toBe(2);
  });

  it('字符串输入：按值缓存', async () => {
    const { state, runner } = makeRunner();
    await cachedMatte('blob:same', undefined, runner);
    await cachedMatte('blob:same', undefined, runner);
    expect(state.calls).toBe(1);
  });

  it('失败不写入缓存，允许重试', async () => {
    let attempt = 0;
    const runner = async () => {
      attempt++;
      if (attempt === 1) throw new Error('boom');
      return new Blob([new Uint8Array([9])], { type: 'image/png' });
    };
    const input = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
    await expect(cachedMatte(input, undefined, runner)).rejects.toThrow('boom');
    const ok = await cachedMatte(input, undefined, runner); // 第二次应重新执行并成功
    expect(ok.size).toBeGreaterThan(0);
    expect(attempt).toBe(2);
  });
});
