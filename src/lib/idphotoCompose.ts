/**
 * 证件照合成编排：把「一张抠图结果 → 一份可导出的 JPEG」的固定步骤收敛到一处。
 *
 * 为什么单拎出来：预览 effect 与多尺寸导出**曾经**各自实现了一遍同样的管线
 * （匀肤 → 失败回退经典美颜 → 构缓存键 → 取/建人物层 → 合层 → 收错误），
 * 只差分辨率与取消标志。两份实现漂移过一次（placements 丢 zoom 导致缓存命中上一档），
 * 这里把它变成**一份** —— 现在预览与导出都调 `composeMany`，差异全部走参数。
 *
 * 本模块不 import 任何 DOM 或 canvas 实现（只 import type），因此能在 node 下用桩直接测。
 * 调用方（`IdPhoto.tsx`）负责：把 `matteCache` / `layerCache` 传进来、
 * 用 `previewLayerKey` / `exportLayerKey` 决定缓存键（两条路径的键不同，不能统一）、以及 setState。
 */

import type { PersonLayer, Placement, RetouchOpts } from './matting';

/** 参与合成的一张照片 */
export interface ComposeItem {
  id: string;
  /** 结果文件名（含扩展名），仅用于回传给组件 */
  name: string;
  /** 抠图结果（透明底 PNG blob） */
  matte: Blob;
  /** 取景微调；有则按 cover 放大并位移 */
  placement?: Placement;
}

/** 合成结果（与组件里的 ComposeResult 同形） */
export interface ComposeOneResult {
  id: string;
  name: string;
  blob: Blob;
  /** 组件负责在替换结果集时 revoke 旧 URL；导出路径不需要预览 URL，此时为空串 */
  url: string;
  /** 本次匀肤的提示文案（未做匀肤为空串） */
  retouchMsg: string;
}

export type ComposeOneOutcome =
  | { status: 'ok'; result: ComposeOneResult }
  /** 已被取消：不得再写任何 state */
  | { status: 'cancelled' };

/** 专业匀肤设置（opts 对编排层不透明，原样转交给 deps.retouchPhoto） */
export interface ComposeAdv<A> {
  /** 三档是否至少有 >0 的参数 */
  active: boolean;
  /** 参数指纹，参与人物层缓存键 */
  key: string;
  opts: A;
  /** 匀肤失败回退经典美颜时用的强度（BEAUTY_LEVELS[档位]） */
  fallbackBeauty: number;
}

export interface ComposeOneInput<A> {
  w: number;
  h: number;
  retouch: RetouchOpts;
  mono: boolean;
  adv: ComposeAdv<A>;
}

export interface ComposeDeps<A, R extends { blob: Blob }> {
  /** 专业匀肤；adv.active 为真时必调（组件传 retouchPhotoBlob） */
  retouchPhoto?: (matte: Blob, opts: A) => Promise<R>;
  /** 匀肤结果 → 一行提示（组件传 summarizeRetouch） */
  summarizeRetouch?: (r: R) => string;
  buildPersonLayer: (
    base: Blob,
    opt: RetouchOpts,
    w: number,
    h: number,
    placement?: Placement,
  ) => Promise<PersonLayer>;
  compositeLayer: (
    layer: PersonLayer,
    opt: RetouchOpts,
    mime: 'image/png' | 'image/jpeg',
  ) => Promise<Blob>;
  /**
   * 人物层缓存键。**由调用方决定格式**：预览与导出的键现在不同
   * （导出键带规格 id），本轮维持原样，避免改变跨路径的缓存命中行为。
   * 两种现网格式见 `previewLayerKey` / `exportLayerKey`。
   */
  keyOf: (
    id: string,
    opt: RetouchOpts,
    w: number,
    h: number,
    placement: Placement | undefined,
    retouchSig: string,
  ) => string;
  /** 人物层缓存（组件持有 ref，跨调用复用） */
  layerCache: Map<string, PersonLayer>;
  /** 缓存条数上限，默认 120 */
  maxLayers?: number;
  /**
   * 预览用：产出 blob URL。**导出路径不需要**（它要的是字节），
   * 不传则结果里的 `url` 为空串，不会产生无人回收的 URL。
   */
  createObjectURL?: (b: Blob) => string;
  /** 取消时回收已产出的 URL；不传则不回收 */
  revokeObjectURL?: (u: string) => void;
  /** 取消探测：每次 await 之后都会重新问一次 */
  isCancelled?: () => boolean;
  /** 每处理 N 张让出一帧（默认 8），0 表示不让帧 */
  yieldEvery?: number;
  /** 让帧实现，默认 setTimeout(0) */
  schedule?: () => Promise<void>;
  /** 单张失败回调：组件在这里 setErrors（保持「逐张报错」的时机不变） */
  onError?: (id: string, message: string) => void;
  /**
   * 每张**开始前**回调，done 从 1 起。导出用它刷「正在导出 规格：n/N」，
   * 预览不用（预览没有进度条）。
   */
  onProgress?: (done: number, item: ComposeItem) => void;
}

/**
 * 合成一张。抛错交给调用方兜（保持「一张失败不影响其余」的原有语义）。
 */
export async function composeOne<A, R extends { blob: Blob }>(
  item: ComposeItem,
  input: ComposeOneInput<A>,
  deps: ComposeDeps<A, R>,
): Promise<ComposeOneOutcome> {
  const cancelled = () => deps.isCancelled?.() === true;
  // 复制一份：调用方的 placements 是 state，合成期间可能被下一轮改写
  const pl = item.placement ? { ...item.placement } : undefined;

  let base: Blob = item.matte;
  let opt: RetouchOpts = input.retouch;
  let retouchSig = '';
  let retouchMsg = '';

  if (input.adv.active) {
    try {
      const r = await deps.retouchPhoto!(item.matte, input.adv.opts);
      if (cancelled()) return { status: 'cancelled' }; // 不得用旧参数覆盖新一轮文案
      base = r.blob;
      retouchSig = input.adv.key;
      // 导出路径不看提示，允许不传 summarizeRetouch（缺省空串，别让它掉进下面的回退分支）
      retouchMsg = deps.summarizeRetouch ? deps.summarizeRetouch(r) : '';
    } catch (e) {
      if (cancelled()) return { status: 'cancelled' };
      // 匀肤失败退回经典美颜，保证「开关打开也一定出片」
      opt = { ...input.retouch, beauty: input.adv.fallbackBeauty };
      retouchMsg = `专业匀肤失败，已回退经典美颜：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  const key = deps.keyOf(item.id, opt, input.w, input.h, pl, retouchSig);
  let layer = deps.layerCache.get(key);
  if (!layer) {
    layer = await deps.buildPersonLayer(base, opt, input.w, input.h, pl);
    if (cancelled()) return { status: 'cancelled' };
    deps.layerCache.set(key, layer);
    // FIFO 淘汰：50 张 × 数百 KB 人物层，封顶避免规格反复切换时无限增长
    const max = deps.maxLayers ?? 120;
    if (deps.layerCache.size > max) {
      const oldest = deps.layerCache.keys().next().value;
      if (oldest !== undefined) deps.layerCache.delete(oldest);
    }
  }

  const blob = await deps.compositeLayer(layer, { ...opt, mono: input.mono }, 'image/jpeg');
  if (cancelled()) return { status: 'cancelled' };
  return {
    status: 'ok',
    result: {
      id: item.id,
      name: item.name,
      blob,
      url: deps.createObjectURL ? deps.createObjectURL(blob) : '',
      retouchMsg,
    },
  };
}

export interface ComposeManyInput<A> extends ComposeOneInput<A> {
  items: readonly ComposeItem[];
}

export interface ComposeManyOutcome {
  cancelled: boolean;
  /** 已产出的结果（保持入参顺序）；取消时为空 */
  results: ComposeOneResult[];
  /** 最后一张的匀肤提示（组件用它 setAdvMsg） */
  retouchMsg: string;
}

/**
 * 批量合成：逐张 composeOne，每 N 张让一帧，单张失败只报错不中断。
 * 取消时回收已产出的 URL —— 这些结果从未交给组件渲染，回收对用户不可见，
 * 原实现会泄漏（旧 effect 取消后 setResults 不执行，URL 无人 revoke）。
 */
export async function composeMany<A, R extends { blob: Blob }>(
  input: ComposeManyInput<A>,
  deps: ComposeDeps<A, R>,
): Promise<ComposeManyOutcome> {
  const cancelled = () => deps.isCancelled?.() === true;
  const yieldEvery = deps.yieldEvery ?? 8;
  const schedule = deps.schedule ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  const results: ComposeOneResult[] = [];
  let retouchMsg = '';

  const abort = (): ComposeManyOutcome => {
    if (deps.revokeObjectURL) results.forEach((r) => deps.revokeObjectURL!(r.url));
    return { cancelled: true, results: [], retouchMsg };
  };

  for (let i = 0; i < input.items.length; i++) {
    if (cancelled()) return abort();
    const item = input.items[i];
    deps.onProgress?.(i + 1, item);
    try {
      const out = await composeOne(item, input, deps);
      if (out.status === 'cancelled') return abort();
      results.push(out.result);
      if (out.result.retouchMsg) retouchMsg = out.result.retouchMsg;
    } catch {
      deps.onError?.(item.id, '合成失败');
    }
    // 让帧放在 try/catch 之外：失败的那一张也要让帧，否则连续失败会长时间占住主线程
    if (yieldEvery > 0 && (i + 1) % yieldEvery === 0) await schedule();
  }

  return { cancelled: false, results, retouchMsg };
}

/**
 * 预览的人物层缓存键：`id|匀肤签名|层指纹`。
 * 匀肤签名在「未开匀肤」和「匀肤失败回退」时都为空串 —— 这两种情况建出的层同样，
 * 共用一个键是有意的。
 */
export function previewLayerKey(id: string, retouchSig: string, layerKey: string): string {
  return `${id}|${retouchSig}|${layerKey}`;
}

/**
 * 导出的人物层缓存键：`id|规格id|匀肤指纹|层指纹`。
 *
 * 与预览键**格式不同**，别顺手统一：
 * - 多一段规格 id，否则同一张图的两个规格会互相命中（历史缺陷：导出比预览少一档尺寸）；
 * - 匀肤段按「开关是否打开」而非「实际是否成功」填 —— 导出路径的既有行为。
 *
 * 两者一旦合并，跨路径的缓存命中关系会变，等于引入新 bug。格式由单测钉住。
 */
export function exportLayerKey(id: string, specId: string, advKey: string, layerKey: string): string {
  return `${id}|${specId}|${advKey}|${layerKey}`;
}

/**
 * 按抠图 blob 记忆匀肤结果：专业匀肤与输出尺寸无关，多尺寸导出时同一张只算一次。
 *
 * 失败的 promise 也记忆 —— 第二个尺寸直接拿到同一个 rejection，走同一条回退分支，
 * 不会把一次注定失败（wasm 崩了之类）的匀肤按尺寸数重跑。
 */
export function memoRetouch<A, R extends { blob: Blob }>(
  retouch: (matte: Blob, opts: A) => Promise<R>,
): (matte: Blob, opts: A) => Promise<R> {
  const cache = new Map<Blob, Promise<R>>();
  return (matte, opts) => {
    const hit = cache.get(matte);
    if (hit) return hit;
    const p = retouch(matte, opts);
    cache.set(matte, p);
    return p;
  };
}
