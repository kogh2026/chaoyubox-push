import { describe, expect, it, vi } from 'vitest';
import {
  composeMany,
  composeOne,
  exportLayerKey,
  memoRetouch,
  previewLayerKey,
  type ComposeDeps,
  type ComposeItem,
  type ComposeOneInput,
} from './idphotoCompose';
import type { PersonLayer, RetouchOpts } from './matting';

const RETOUCH: RetouchOpts = {
  bg: { id: 'white', name: '白底', hex: '#FFFFFF' },
  whiten: 0.15,
  brightness: 0,
  edgeThreshold: 30,
  defringe: 0.7,
  beauty: 0,
};

const ADV_OFF = { active: false, key: '0.000,0.000,0.000', opts: {}, fallbackBeauty: 0.35 };
const ADV_ON = { active: true, key: '0.400,0.200,0.100', opts: { smoothing: 0.4 }, fallbackBeauty: 0.35 };

function matte(id: string): Blob {
  return new Blob([`matte:${id}`], { type: 'image/png' });
}

function item(id: string, placement?: { dx: number; dy: number; zoom?: number }): ComposeItem {
  return { id, name: `${id}.jpg`, matte: matte(id), placement };
}

/** 默认桩：记录每次调用的参数，方便做「调用参数级」断言 */
function makeDeps(over: Partial<ComposeDeps<unknown, { blob: Blob }>> = {}) {
  let seq = 0;
  const calls = {
    build: [] as { base: Blob; opt: RetouchOpts; w: number; h: number; pl?: unknown }[],
    composite: [] as { opt: RetouchOpts; mime: string }[],
    keys: [] as string[],
  };
  const deps: ComposeDeps<unknown, { blob: Blob }> = {
    buildPersonLayer: vi.fn(async (base, opt, w, h, pl) => {
      calls.build.push({ base, opt, w, h, pl });
      return { layer: calls.build.length } as unknown as PersonLayer;
    }),
    compositeLayer: vi.fn(async (_layer, opt, mime) => {
      calls.composite.push({ opt, mime });
      return new Blob([`out:${calls.composite.length}`], { type: 'image/jpeg' });
    }),
    keyOf: (id, opt, w, h, _pl, sig) => {
      const k = `${id}|${sig}|${w}x${h}|${opt.beauty ?? ''}`;
      calls.keys.push(k);
      return k;
    },
    layerCache: new Map(),
    createObjectURL: () => `blob:fake-${++seq}`,
    revokeObjectURL: vi.fn(),
    ...over,
  };
  return { deps, calls };
}

function input(over: Partial<ComposeOneInput<unknown>> = {}): ComposeOneInput<unknown> {
  return { w: 295, h: 413, retouch: RETOUCH, mono: false, adv: ADV_OFF, ...over };
}

describe('composeOne：基本链路', () => {
  it('按输出分辨率建人物层，再按 mono 合层，返回 blob + url', async () => {
    const { deps, calls } = makeDeps();
    const out = await composeOne(item('a', { dx: 5, dy: -3, zoom: 1.2 }), input({ mono: true }), deps);

    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.result.id).toBe('a');
    expect(out.result.name).toBe('a.jpg');
    expect(out.result.blob.type).toBe('image/jpeg');
    expect(out.result.url).toMatch(/^blob:fake-/);
    // 建层参数：输出分辨率而不是原图分辨率；取景原样传下去
    expect(calls.build).toHaveLength(1);
    expect(calls.build[0]).toMatchObject({ w: 295, h: 413, pl: { dx: 5, dy: -3, zoom: 1.2 } });
    // 合层参数：mono 由入参决定，mime 固定 jpeg
    expect(calls.composite[0]).toMatchObject({ mime: 'image/jpeg', opt: { mono: true } });
  });

  it('未开启匀肤时不调用匀肤，且缓存键不含匀肤指纹', async () => {
    const retouchPhoto = vi.fn();
    const { deps, calls } = makeDeps({ retouchPhoto });
    await composeOne(item('a'), input(), deps);

    expect(retouchPhoto).not.toHaveBeenCalled();
    expect(calls.keys[0].startsWith('a||')).toBe(true);
  });
});

describe('composeOne：专业匀肤与回退', () => {
  it('匀肤成功：用匀肤后的 blob 建层，签名进缓存键，提示来自 summarize', async () => {
    const blended = new Blob(['blended']);
    const retouchPhoto = vi.fn(async () => ({ blob: blended }));
    const { deps, calls } = makeDeps({
      retouchPhoto,
      summarizeRetouch: () => '匀肤：平滑 40%',
    });
    const out = await composeOne(item('a'), input({ adv: ADV_ON }), deps);

    expect(retouchPhoto).toHaveBeenCalledWith(expect.any(Blob), { smoothing: 0.4 });
    expect(calls.build[0].base).toBe(blended); // 建层用的是匀肤后的图
    expect(calls.keys[0]).toContain('|0.400,0.200,0.100|'); // 匀肤签名进键
    expect(out.status === 'ok' && out.result.retouchMsg).toBe('匀肤：平滑 40%');
  });

  it('匀肤抛错：回退经典美颜，键不含匀肤签名，仍出片', async () => {
    const retouchPhoto = vi.fn(async () => {
      throw new Error('wasm 崩了');
    });
    const { deps, calls } = makeDeps({ retouchPhoto, summarizeRetouch: () => '不该出现' });
    const src = item('a');
    const out = await composeOne(src, input({ adv: ADV_ON }), deps);

    expect(calls.build[0].base).toBe(src.matte); // 退回原抠图
    expect(calls.build[0].opt.beauty).toBe(0.35); // 回退档位生效
    expect(calls.keys[0].startsWith('a||')).toBe(true); // 签名未写入
    expect(out.status === 'ok' && out.result.retouchMsg).toContain('已回退经典美颜');
    expect(out.status === 'ok' && out.result.retouchMsg).toContain('wasm 崩了');
  });
});

describe('composeOne：人物层缓存', () => {
  it('同一键第二次直接命中，不重复建层', async () => {
    const { deps, calls } = makeDeps();
    await composeOne(item('a'), input(), deps);
    await composeOne(item('a'), input(), deps);
    expect(calls.build).toHaveLength(1);
    expect(calls.composite).toHaveLength(2); // 合层仍然每次都做（换底色要重新合）
  });

  it('不同规格（w/h 变化）不会互相命中', async () => {
    const { deps, calls } = makeDeps();
    await composeOne(item('a'), input({ w: 295, h: 413 }), deps);
    await composeOne(item('a'), input({ w: 413, h: 579 }), deps);
    expect(calls.build).toHaveLength(2);
  });

  it('超过 maxLayers 时按 FIFO 淘汰最早的', async () => {
    const { deps, calls } = makeDeps({ maxLayers: 2 });
    for (const w of [295, 413, 531]) await composeOne(item('a'), input({ w }), deps);
    expect(deps.layerCache.size).toBe(2);
    expect(calls.build).toHaveLength(3);
    // 第一档已被淘汰：再来一次要重建
    await composeOne(item('a'), input({ w: 295 }), deps);
    expect(calls.build).toHaveLength(4);
  });
});

describe('composeOne：取消', () => {
  it('合层结束后发现已取消 → 不产出结果', async () => {
    let cancelled = false;
    const { deps } = makeDeps({
      isCancelled: () => cancelled,
      compositeLayer: async () => {
        cancelled = true; // 模拟 await 期间下一轮 effect 把上一轮取消
        return new Blob(['x']);
      },
    });
    const out = await composeOne(item('a'), input(), deps);
    expect(out.status).toBe('cancelled');
  });
});

describe('composeMany：编排', () => {
  it('保持入参顺序，单张抛错时回调 onError 且继续处理后面的', async () => {
    let n = 0;
    const compositeLayer = vi.fn(async () => {
      n += 1;
      if (n === 2) throw new Error('boom');
      return new Blob(['ok']);
    });
    const { deps } = makeDeps({ compositeLayer });
    const errors: string[] = [];
    const out = await composeMany(
      { items: [item('a'), item('b'), item('c')], ...input() },
      { ...deps, onError: (id) => errors.push(id) },
    );
    expect(out.cancelled).toBe(false);
    expect(out.results.map((r) => r.id)).toEqual(['a', 'c']);
    expect(errors).toEqual(['b']);
  });

  it('每 N 张让一帧（让帧次数 = floor(张数 / N)）', async () => {
    const schedule = vi.fn(async () => {});
    const { deps } = makeDeps();
    const out = await composeMany(
      { items: [item('a'), item('b'), item('c'), item('d'), item('e')], ...input() },
      { ...deps, schedule, yieldEvery: 2 },
    );
    expect(out.results).toHaveLength(5);
    expect(schedule).toHaveBeenCalledTimes(2); // i=1、i=3
  });

  it('失败的那一张也要让帧（不让帧会连续占住主线程）', async () => {
    const schedule = vi.fn(async () => {});
    const { deps } = makeDeps({
      compositeLayer: async () => {
        throw new Error('boom');
      },
    });
    await composeMany(
      { items: [item('a'), item('b')], ...input() },
      { ...deps, schedule, yieldEvery: 2, onError: () => {} },
    );
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('取消：返回空结果并回收已产出的 URL', async () => {
    let cancelled = false;
    let n = 0;
    const revokeObjectURL = vi.fn();
    const { deps } = makeDeps({
      isCancelled: () => cancelled,
      compositeLayer: async () => {
        n += 1;
        if (n === 2) cancelled = true; // 第二张期间被取消，第一张的 URL 已产出
        return new Blob(['ok']);
      },
    });
    const out = await composeMany(
      { items: [item('a'), item('b'), item('c')], ...input() },
      { ...deps, revokeObjectURL },
    );
    expect(out.cancelled).toBe(true);
    expect(out.results).toEqual([]); // 与旧 effect 一致：取消后不交付部分结果
    expect(n).toBe(2); // 第三张不再处理
    // 第一张的 blob 已产出但从未交给组件，必须回收
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('空列表直接返回空结果', async () => {
    const { deps, calls } = makeDeps();
    const out = await composeMany({ items: [], ...input() }, deps);
    expect(out).toEqual({ cancelled: false, results: [], retouchMsg: '' });
    expect(calls.build).toHaveLength(0);
  });
});

describe('导出路径的差异点', () => {
  it('不传 createObjectURL 时 url 为空串（导出要字节，不需要预览 URL）', async () => {
    const { deps } = makeDeps({ createObjectURL: undefined });
    const out = await composeOne(item('a'), input(), deps);
    expect(out.status === 'ok' && out.result.url).toBe('');
  });

  it('onProgress 每张开始前回调一次，done 从 1 起且顺序与入参一致', async () => {
    const seen: string[] = [];
    const builtAt: number[] = [];
    const { deps, calls } = makeDeps();
    const out = await composeMany(
      { items: [item('a'), item('b'), item('c')], ...input() },
      {
        ...deps,
        onProgress: (done, it) => {
          seen.push(`${done}:${it.id}`);
          builtAt.push(calls.build.length); // 回调时这一张还没建层
        },
      },
    );
    expect(seen).toEqual(['1:a', '2:b', '3:c']);
    expect(builtAt).toEqual([0, 1, 2]);
    expect(out.results).toHaveLength(3);
  });

  it('匀肤成功但不传 summarizeRetouch：提示为空串，且不会被误判成回退', async () => {
    const blended = new Blob(['blended']);
    const { deps, calls } = makeDeps({
      retouchPhoto: async () => ({ blob: blended }),
      summarizeRetouch: undefined,
    });
    const out = await composeOne(item('a'), input({ adv: ADV_ON }), deps);
    expect(out.status === 'ok' && out.result.retouchMsg).toBe('');
    expect(calls.build[0].base).toBe(blended); // 用的是匀肤后的图，说明没走回退
    expect(calls.keys[0]).toContain('|0.400,0.200,0.100|');
  });
});

describe('缓存键格式（钉住两条路径，禁止「顺手统一」）', () => {
  const LAYER = 'L147258';

  it('预览键 = id|匀肤签名|层指纹', () => {
    expect(previewLayerKey('p1', '0.400,0.200,0.100', LAYER)).toBe(`p1|0.400,0.200,0.100|${LAYER}`);
    expect(previewLayerKey('p1', '', LAYER)).toBe(`p1||${LAYER}`);
  });

  it('导出键 = id|规格id|匀肤指纹|层指纹', () => {
    expect(exportLayerKey('p1', 'one-inch', '0.400,0.200,0.100', LAYER)).toBe(
      `p1|one-inch|0.400,0.200,0.100|${LAYER}`,
    );
  });

  it('同一张图同规格：两种格式永不相等（跨路径不会互相命中）', () => {
    expect(previewLayerKey('p1', '', LAYER)).not.toBe(exportLayerKey('p1', 'one-inch', '', LAYER));
  });

  it('导出键随规格 id 区分 —— 多尺寸必须建不同人物层', () => {
    const a = exportLayerKey('p1', 'one-inch', '', LAYER);
    const b = exportLayerKey('p1', 'two-inch', '', LAYER);
    expect(a).not.toBe(b);
  });
});

describe('memoRetouch：跨尺寸复用匀肤', () => {
  it('同一张图（同一 blob）多尺寸只算一次', async () => {
    const retouch = vi.fn(async () => ({ blob: new Blob(['r']) }));
    const memo = memoRetouch(retouch);
    const src = matte('a');
    await memo(src, { smoothing: 0.4 });
    await memo(src, { smoothing: 0.4 });
    await memo(src, { smoothing: 0.4 });
    expect(retouch).toHaveBeenCalledTimes(1);
  });

  it('不同图各自计算', async () => {
    const retouch = vi.fn(async () => ({ blob: new Blob(['r']) }));
    const memo = memoRetouch(retouch);
    await memo(matte('a'), {});
    await memo(matte('b'), {});
    expect(retouch).toHaveBeenCalledTimes(2);
  });

  it('失败也被记忆：不按尺寸数重跑一次注定失败的匀肤', async () => {
    const retouch = vi.fn(async () => {
      throw new Error('wasm 崩了');
    });
    const memo = memoRetouch(retouch);
    const src = matte('a');
    await expect(memo(src, {})).rejects.toThrow('wasm 崩了');
    await expect(memo(src, {})).rejects.toThrow('wasm 崩了');
    expect(retouch).toHaveBeenCalledTimes(1);
  });
});
