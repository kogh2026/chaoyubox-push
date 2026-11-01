import { describe, expect, it, vi } from 'vitest';
import { IdleUnloader, type Scheduler } from './idleUnload';

/** 可控的假调度器：手动 flush 触发到期的回调，避免真实计时器的抖动 */
function fakeScheduler() {
  let seq = 1;
  const heap: { id: number; fn: () => void }[] = [];
  const scheduler: Scheduler = {
    setTimeout: (fn, _ms) => {
      const id = seq++;
      heap.push({ id, fn });
      return id;
    },
    clearTimeout: (id) => {
      const i = heap.findIndex((t) => t.id === id);
      if (i >= 0) heap.splice(i, 1);
    },
  };
  return {
    scheduler,
    /** 触发最近一次排定的回调（模拟空闲到期） */
    flush() {
      const t = heap.shift();
      if (t) t.fn();
    },
    pending: () => heap.length,
  };
}

describe('IdleUnloader', () => {
  it('touch 后到期触发 onIdle，pending 反映倒计时状态', () => {
    const ctrl = fakeScheduler();
    const onIdle = vi.fn();
    const u = new IdleUnloader(onIdle, 90_000, ctrl.scheduler);
    expect(u.pending).toBe(false);
    u.touch();
    expect(u.pending).toBe(true);
    expect(onIdle).not.toHaveBeenCalled();
    ctrl.flush();
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(u.pending).toBe(false);
  });

  it('clear 取消待触发的空闲回调', () => {
    const ctrl = fakeScheduler();
    const onIdle = vi.fn();
    const u = new IdleUnloader(onIdle, 90_000, ctrl.scheduler);
    u.touch();
    u.clear();
    expect(u.pending).toBe(false);
    ctrl.flush(); // 不应有任何回调
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('连续 touch 只保留最后一个计时（不叠加）', () => {
    const ctrl = fakeScheduler();
    const onIdle = vi.fn();
    const u = new IdleUnloader(onIdle, 90_000, ctrl.scheduler);
    u.touch();
    u.touch();
    u.touch();
    expect(ctrl.pending()).toBe(1); // 每次 touch 先 clear 再排新
    ctrl.flush();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('再次 touch 重置空闲（复用期间不释放）', () => {
    const ctrl = fakeScheduler();
    const onIdle = vi.fn();
    const u = new IdleUnloader(onIdle, 90_000, ctrl.scheduler);
    u.touch();
    ctrl.flush(); // 第一次到期 → 释放
    expect(onIdle).toHaveBeenCalledTimes(1);
    u.touch(); // 复用，重新计时
    expect(u.pending).toBe(true);
    expect(ctrl.pending()).toBe(1);
  });
});
