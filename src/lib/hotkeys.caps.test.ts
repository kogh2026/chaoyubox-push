// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { loadToolCaps } from './hotkeys';

/* 能力登记的存储层：localStorage 往返与脏数据防护。
   Hook 本身（React + 事件）由 E2E 在真浏览器覆盖。 */

const KEY = 'chaoyu.hotkeys.toolcaps.v1';

describe('loadToolCaps', () => {
  beforeEach(() => localStorage.clear());

  it('无记录返回 null', () => {
    expect(loadToolCaps()).toBeNull();
  });

  it('完整记录原样读回', () => {
    const caps = { toolId: 'batch-print', toolName: '批量打印', actions: ['import', 'print'], at: 123 };
    localStorage.setItem(KEY, JSON.stringify(caps));
    expect(loadToolCaps()).toEqual(caps);
  });

  it('JSON 坏掉返回 null 不抛', () => {
    localStorage.setItem(KEY, '{oops');
    expect(loadToolCaps()).toBeNull();
  });

  it('结构不完整（缺 toolId / actions 非数组）返回 null', () => {
    localStorage.setItem(KEY, JSON.stringify({ actions: ['import'] }));
    expect(loadToolCaps()).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ toolId: 'x', actions: 'no' }));
    expect(loadToolCaps()).toBeNull();
  });

  it('非对象 JSON 返回 null', () => {
    localStorage.setItem(KEY, '"just a string"');
    expect(loadToolCaps()).toBeNull();
  });
});
