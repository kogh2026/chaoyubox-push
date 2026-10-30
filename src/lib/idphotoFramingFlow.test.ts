import { describe, it, expect } from 'vitest';
import {
  ensureFrames,
  measureFrame,
  personBottomFrac,
  placementForFrame,
  planPlacements,
  FRAME_YIELD_EVERY,
  type FramingDeps,
  type FramingFrame,
  type FramingTarget,
} from './idphotoFramingFlow';
import {
  computeMetrics,
  specAutoPlacement,
  verifyFraming,
  BOTTOM_FILL_NOMINAL,
  HEAD_RATIO_TOL,
  type FramingSpec,
} from './specFraming';
import type { HeadGeometry } from './faceFrame';
import type { PersonLowerBody } from './selfieMulticlassMask';

// 一寸 @300DPI：25×35mm → 295×413px（爱印 topRatio 0.08 / headRatio 0.64）
const ONE_INCH: FramingSpec = {
  mmW: 25,
  mmH: 35,
  pxW: 295,
  pxH: 413,
  topRatio: 0.08,
  headRatio: 0.64,
  safeRatio: 0.035,
};

const head = (top: number, height: number, cx = 0.5): HeadGeometry => ({ cx, top, height });
const lower = (bottomFrac: number, found = true): PersonLowerBody => ({
  bottomFrac,
  topFrac: Math.min(0.2, bottomFrac),
  reachedBottom: bottomFrac > 0.99,
  found,
});

// 1000×1500 原图，发顶 20%、头高 20%（与 specFraming.test.ts 的实测夹具一致）
const IMG_W = 1000;
const IMG_H = 1500;
const H = head(0.2, 0.2);

const target = (id: string): FramingTarget => ({ id, url: `${id}.jpg` });

/** 直接造一个「已测量」的 frame，省掉跑 deps 的流程（阶段③测试用） */
const frameOf = (f: {
  head?: HeadGeometry;
  lower?: PersonLowerBody;
  w?: number;
  h?: number;
}): FramingFrame => ({ w: IMG_W, h: IMG_H, ...f });

interface FakePhoto {
  head?: HeadGeometry;
  lower?: PersonLowerBody;
  /** loadSource 抛错（模拟读不出来的图） */
  loadFail?: boolean;
  /** segmentLower 抛错（模拟无模型/离线） */
  segFail?: boolean;
  w?: number;
  h?: number;
}

interface CallLog {
  load: string[];
  head: string[];
  seg: string[];
}

/** 桩 deps：把「每张照片测出什么」写成表，顺便记录调用顺序 */
function depsFor(photos: Record<string, FakePhoto>, calls: CallLog = { load: [], head: [], seg: [] }): FramingDeps<string> {
  return {
    loadSource: async (t) => {
      calls.load.push(t.id);
      const p = photos[t.id];
      if (p?.loadFail) throw new Error('图像加载失败');
      return { src: t.id, w: p?.w ?? IMG_W, h: p?.h ?? IMG_H };
    },
    detectHead: async (src) => {
      calls.head.push(src);
      return photos[src]?.head;
    },
    segmentLower: async (src) => {
      calls.seg.push(src);
      if (photos[src]?.segFail) throw new Error('分割模型不可用');
      return photos[src]?.lower;
    },
  };
}

// ---------- 阶段 ③：按规格算 placement（纯同步） ----------
describe('placementForFrame：分割结果 → placement 的唯一入口', () => {
  it('有分割结果时与直接调用 specAutoPlacement 完全一致（参数级）', () => {
    const frame: FramingFrame = { head: H, lower: lower(0.4), w: IMG_W, h: IMG_H };
    expect(placementForFrame(frame, ONE_INCH)).toEqual(
      specAutoPlacement(H, IMG_W, IMG_H, ONE_INCH, 'default', 1, 0.4),
    );
  });

  it('分割未命中（found=false）→ 回退整图近似，与不传 bottomFrac 一致', () => {
    const frame: FramingFrame = { head: H, lower: lower(1, false), w: IMG_W, h: IMG_H };
    const r = placementForFrame(frame, ONE_INCH)!;
    expect(r).toEqual(specAutoPlacement(H, IMG_W, IMG_H, ONE_INCH, 'default', 1));
    // 关键差异：脏（found=false）的分割结果不得被当成「人物就到这里」而触发放大
    expect(r.bottomInsufficient).toBe(false);
    expect(r.bottomAnchorScale).toBe(1);
  });

  it('无脸 / 缺尺寸 / frame 缺失 → undefined（调用方走「无脸」分支）', () => {
    expect(placementForFrame(undefined, ONE_INCH)).toBeUndefined();
    expect(placementForFrame(null, ONE_INCH)).toBeUndefined();
    expect(placementForFrame({ w: IMG_W, h: IMG_H }, ONE_INCH)).toBeUndefined();
    expect(placementForFrame({ head: H, h: IMG_H }, ONE_INCH)).toBeUndefined();
    expect(placementForFrame({ head: H, w: IMG_W }, ONE_INCH)).toBeUndefined();
    expect(placementForFrame({ head: H, w: 0, h: IMG_H }, ONE_INCH)).toBeUndefined();
  });

  it('mode 与 fillScale 原样透传（自定义构图）', () => {
    const frame: FramingFrame = { head: H, lower: lower(0.4), w: IMG_W, h: IMG_H };
    expect(placementForFrame(frame, ONE_INCH, 'custom', 1.3)!.bottomAnchorScale).toBeCloseTo(1.3, 4);
    expect(placementForFrame(frame, ONE_INCH, 'spec')!.bottomAnchorScale).toBe(1);
  });
});

// ---------- 阶段 ①②：取人脸 → 判下半身 ----------
describe('measureFrame：单张测出构图输入', () => {
  it('有脸 + 分割命中 → head/lower/尺寸齐全，顺序为 加载 → 人脸 → 分割', async () => {
    const calls: CallLog = { load: [], head: [], seg: [] };
    const deps = depsFor({ a: { head: H, lower: lower(0.4) } }, calls);
    const frame = await measureFrame(target('a'), deps);
    expect(frame).toEqual({ head: H, lower: lower(0.4), w: IMG_W, h: IMG_H });
    expect(calls).toEqual({ load: ['a'], head: ['a'], seg: ['a'] });
  });

  it('未检出人脸 → 只记尺寸，不跑分割（省一次推理）', async () => {
    const calls: CallLog = { load: [], head: [], seg: [] };
    const deps = depsFor({ a: {} }, calls);
    expect(await measureFrame(target('a'), deps)).toEqual({ w: IMG_W, h: IMG_H });
    expect(calls.seg).toEqual([]);
  });

  it('分割抛错 → 保留 head，lower 留空（下游回退整图近似）', async () => {
    const deps = depsFor({ a: { head: H, segFail: true } });
    const frame = await measureFrame(target('a'), deps);
    expect(frame.head).toEqual(H);
    expect(frame.lower).toBeUndefined();
    expect(frame.w).toBe(IMG_W);
  });

  it('分割返回 undefined（模型未就绪）→ 同样留空，不抛错', async () => {
    const deps = depsFor({ a: { head: H } });
    expect((await measureFrame(target('a'), deps)).lower).toBeUndefined();
  });

  it('加载失败 → 抛出，由 ensureFrames 兜成空帧', async () => {
    const deps = depsFor({ a: { loadFail: true, head: H } });
    await expect(measureFrame(target('a'), deps)).rejects.toThrow('图像加载失败');
  });
});

describe('ensureFrames：批量补测 + 缓存 + 让帧', () => {
  it('命中缓存的跳过：重复调用零加载', async () => {
    const calls: CallLog = { load: [], head: [], seg: [] };
    const deps = depsFor({ a: { head: H, lower: lower(0.4) }, b: { head: H } }, calls);
    const cache = new Map<string, FramingFrame>();

    const first = await ensureFrames([target('a'), target('b')], cache, deps);
    expect(first).toEqual({ measured: 2, skipped: 0 });
    const second = await ensureFrames([target('a'), target('b')], cache, deps);
    expect(second).toEqual({ measured: 0, skipped: 2 });
    expect(calls.load).toEqual(['a', 'b']); // 只加载过一次
  });

  it('加载失败记成空帧，不影响同一批的其它张', async () => {
    const deps = depsFor({ a: { loadFail: true }, b: { head: H, lower: lower(1) } });
    const cache = new Map<string, FramingFrame>();
    await ensureFrames([target('a'), target('b')], cache, deps);
    expect(cache.get('a')).toEqual({});
    expect(cache.get('b')).toEqual({ head: H, lower: lower(1), w: IMG_W, h: IMG_H });
  });

  it('每 FRAME_YIELD_EVERY 张让出一帧', async () => {
    const photos: Record<string, FakePhoto> = {};
    const targets = Array.from({ length: FRAME_YIELD_EVERY * 2 }, (_, i) => target(`p${i}`));
    for (const t of targets) photos[t.id] = { head: H };
    let yielded = 0;
    await ensureFrames(targets, new Map(), depsFor(photos), {
      schedule: async () => {
        yielded += 1;
      },
    });
    expect(yielded).toBe(2);
  });

  it('让帧发生在「第 N 张测完之后」，且命中缓存不产生让帧', async () => {
    const photos: Record<string, FakePhoto> = {
      a: { head: H },
      b: { head: H },
      c: { head: H },
      d: { head: H },
    };
    const cache = new Map<string, FramingFrame>([['a', { w: IMG_W, h: IMG_H }]]);
    const marks: string[] = [];
    const deps = depsFor(photos);
    const wrapped: FramingDeps<string> = {
      ...deps,
      detectHead: async (src, w, h) => {
        marks.push(src);
        return deps.detectHead(src, w, h);
      },
    };
    await ensureFrames([target('a'), target('b'), target('c'), target('d')], cache, wrapped, {
      yieldEvery: 2,
      schedule: async () => {
        marks.push('yield');
      },
    });
    // 索引 0 命中缓存直接 continue（不计数、不让帧）；索引 1 测完让帧；索引 3 测完让帧
    expect(marks).toEqual(['b', 'yield', 'c', 'd', 'yield']);
  });

  it('yieldEvery=0 关闭让帧', async () => {
    let yielded = 0;
    await ensureFrames([target('a')], new Map(), depsFor({ a: { head: H } }), {
      yieldEvery: 0,
      schedule: async () => {
        yielded += 1;
      },
    });
    expect(yielded).toBe(0);
  });
});

// ---------- 阶段 ①②③：自动构图的完整决策 ----------
describe('planPlacements：下方充足不放大 / 下方不足按上限放大 / 无脸跳过', () => {
  const photos: Record<string, FakePhoto> = {
    full: { head: H, lower: lower(1) }, // 人物抵达图底：下半身充足
    short: { head: H, lower: lower(0.4) }, // 下半身只到 40%：下方有大片背景
    noface: {}, // 未检出人脸
  };
  const targets = [target('full'), target('short'), target('noface')];

  it('统计项与 placements 集合正确', async () => {
    const plan = await planPlacements(targets, new Map(), { spec: ONE_INCH }, depsFor(photos));
    expect(plan.framed).toBe(2);
    expect(plan.noFace).toBe(1);
    expect(plan.filled).toBe(1);
    expect(plan.measured).toBe(3);
    expect(Object.keys(plan.placements).sort()).toEqual(['full', 'short']);
  });

  it('下方充足不放大，下方不足放大且不超过 20% 名义上限', async () => {
    const plan = await planPlacements(targets, new Map(), { spec: ONE_INCH }, depsFor(photos));
    const full = specAutoPlacement(H, IMG_W, IMG_H, ONE_INCH, 'default', 1, 1);
    const short = specAutoPlacement(H, IMG_W, IMG_H, ONE_INCH, 'default', 1, 0.4);
    expect(plan.placements.full).toEqual(full.placement); // 与「无放大填满」完全一致
    expect(plan.placements.short).toEqual(short.placement);
    expect((plan.placements.short.zoom ?? 0)).toBeGreaterThan(plan.placements.full.zoom ?? 0);
    expect(short.bottomAnchorScale).toBeLessThanOrEqual(BOTTOM_FILL_NOMINAL + 1e-9);
  });

  it('每张的 placement 与逐张调用 placementForFrame 一致', async () => {
    const cache = new Map<string, FramingFrame>();
    const plan = await planPlacements(targets, cache, { spec: ONE_INCH }, depsFor(photos));
    for (const t of targets) {
      const one = placementForFrame(cache.get(t.id), ONE_INCH);
      if (!one) continue;
      expect(plan.placements[t.id]).toEqual(one.placement);
    }
  });

  it('行为级复核：下方充足时头高/留白落在规格容差内，下方不足时头高被放大判 high', async () => {
    const plan = await planPlacements(targets, new Map(), { spec: ONE_INCH }, depsFor(photos));
    // 充足：正好落到 0.64 / 0.08，逐项核查无告警
    const full = computeMetrics(H, IMG_W, IMG_H, plan.placements.full, ONE_INCH);
    expect(full.headRatio).toBeCloseTo(ONE_INCH.headRatio, 2);
    expect(full.topRatio).toBeCloseTo(ONE_INCH.topRatio, 2);
    expect(verifyFraming(full, ONE_INCH).warnings).toHaveLength(0);
    // 不足：发顶仍锚在 topRatio，但头高被放大到超出容差 —— 正是「已放大填满」的可见证据
    const short = computeMetrics(H, IMG_W, IMG_H, plan.placements.short, ONE_INCH);
    expect(short.topRatio).toBeCloseTo(ONE_INCH.topRatio, 2);
    expect(short.headRatio).toBeGreaterThan(ONE_INCH.headRatio + HEAD_RATIO_TOL);
  });

  it('复用一个缓存 → 第二次规划零测量，结果不变', async () => {
    const cache = new Map<string, FramingFrame>();
    const deps = depsFor(photos);
    const first = await planPlacements(targets, cache, { spec: ONE_INCH }, deps);
    const second = await planPlacements(targets, cache, { spec: ONE_INCH }, deps);
    expect(first.placements).toEqual(second.placements);
    expect(second.measured).toBe(0);
  });

  it('分割整体不可用 → 仍按整图近似出 placement（回退路径不崩）', async () => {
    const broken: Record<string, FakePhoto> = {
      a: { head: H, segFail: true },
    };
    const plan = await planPlacements([target('a')], new Map(), { spec: ONE_INCH }, depsFor(broken));
    expect(plan.framed).toBe(1);
    expect(plan.filled).toBe(0);
    expect(plan.placements.a).toEqual(specAutoPlacement(H, IMG_W, IMG_H, ONE_INCH, 'default', 1).placement);
  });

  it('空目标 → 空计划，且完全不碰 deps', async () => {
    const calls: CallLog = { load: [], head: [], seg: [] };
    const plan = await planPlacements([], new Map(), { spec: ONE_INCH }, depsFor({}, calls));
    expect(plan).toEqual({ placements: {}, framed: 0, noFace: 0, filled: 0, measured: 0 });
    expect(calls).toEqual({ load: [], head: [], seg: [] });
  });

  it('custom 模式：fillScale 决定放大倍数（自动构图走 default，不受影响）', async () => {
    const plan = await planPlacements(
      [target('full')],
      new Map(),
      { spec: ONE_INCH, mode: 'custom', fillScale: 1.3 },
      depsFor({ full: { head: H, lower: lower(1) } }),
    );
    const base = specAutoPlacement(H, IMG_W, IMG_H, ONE_INCH, 'custom', 1.3, 1);
    expect(plan.placements.full).toEqual(base.placement);
  });
});

describe('personBottomFrac：底部位置的唯一提取口', () => {
  it('分割成功 → 回传归一化底部位置', () => {
    expect(personBottomFrac(frameOf({ head: H, lower: lower(0.62) }))).toBe(0.62);
  });

  it('分割失败 / 未检出人物 / frame 缺失 → undefined（调用方据此回退整图近似）', () => {
    expect(personBottomFrac(frameOf({ head: H }))).toBeUndefined();
    expect(personBottomFrac(frameOf({ head: H, lower: lower(0.9, false) }))).toBeUndefined();
    expect(personBottomFrac(undefined)).toBeUndefined();
    expect(personBottomFrac(null)).toBeUndefined();
  });

  it('右栏核查面板与自动构图走同一份参数装配：default 档下两者 placement 完全一致', () => {
    // 面板（IdPhoto.tsx 核查 effect）用 placementForFrame(fd, spec, specMode, fillScale)，
    // 自动构图（planPlacements）固定 mode='default'/fillScale=1 —— 同一 frame 必须同果。
    const frame = frameOf({ head: H, lower: lower(0.45) });
    const panelSide = placementForFrame(frame, ONE_INCH, 'default', 1);
    const autoSide = specAutoPlacement(
      H,
      IMG_W,
      IMG_H,
      ONE_INCH,
      'default',
      1,
      personBottomFrac(frame),
    );
    expect(panelSide?.placement).toEqual(autoSide.placement);
    expect(panelSide?.bottomAnchorScale).toBe(autoSide.bottomAnchorScale);
  });
});
