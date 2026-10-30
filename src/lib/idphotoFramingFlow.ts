/**
 * 证件照「自动构图流」：把原先内联在 `IdPhoto.tsx` 里的四段串起来 ——
 *
 *   ① 取人脸       faceDetect.detectFaces → faceFrame.headFromFace
 *   ② 判下半身     selfieMulticlassMask.segmentPersonLowerBody（预缩到 ≤512 再跑）
 *   ③ 算 placement specFraming.specAutoPlacement（按尺寸规格 + 真实人物底部长度）
 *   ④ 写 state     setPlacements / setFrameMode / setSaveMsg …… **留在组件**，state 是组件的事
 *
 * 为什么单拎出来：同样的「模型 → 构图参数」链路原先在组件里有三个调用点
 * （自动构图、实时核查 effect、多尺寸导出），各自手写
 * `fd.lower?.found ? fd.lower.bottomFrac : undefined` 这类分支 —— 改一处漏一处的风险实打实存在。
 * 现在「分割结果怎么转成 placement」只有 `placementForFrame` 一处实现。
 *
 * 本模块只 import type 与纯函数，不碰 DOM / canvas / React：
 * 图像加载、人脸检测、下半身分割全部由调用方以 `deps` 注入（组件传真实实现，单测传桩），
 * 因此 `node` 环境下可全量回归 —— 与 `idphotoCompose.ts` 同一套依赖注入约定。
 *
 * 行为约定（与抽离前逐条对齐，改动需同步改测试）：
 * - 缓存命中直接跳过，**连让帧都跳过**（原实现 `continue` 在让帧之前）；
 * - 未检出人脸 → 只记 `{ w, h }`，不跑分割；
 * - 分割失败/不可用 → 保留 head，`lower` 留空，下游回退「整图底部」近似；
 * - 加载失败 → 记 `{}`，该张在 `planPlacements` 里计入「未检出人脸」；
 * - 每处理 8 张让出一帧（让帧位置与原实现一致）。
 */

import type { HeadGeometry } from './faceFrame';
import type { PersonLowerBody } from './selfieMulticlassMask';
import {
  specAutoPlacement,
  type FramingMode,
  type FramingSpec,
  type SpecPlacementResult,
} from './specFraming';

/** 让帧间隔（张）。与原 `ensureFrameData` 的 `(i + 1) % 8` 一致。 */
export const FRAME_YIELD_EVERY = 8;

/**
 * 一张照片的「构图输入」：人脸几何 + 下半身分割结果 + 原图像素尺寸。
 * 三个字段都可缺 —— 分别对应「没检出脸」「分割不可用」「加载失败」三种降级态。
 */
export interface FramingFrame {
  head?: HeadGeometry;
  lower?: PersonLowerBody;
  w?: number;
  h?: number;
}

/** 参与构图计算的输入项：只需要 id（缓存键）与 url（加载原图） */
export interface FramingTarget {
  id: string;
  url: string;
}

/**
 * 阶段 ①② 的环境适配层。三个函数都只做「一件 I/O 事」，不做任何判断：
 * 判断（无脸跳过、分割失败容忍）全在本模块里，这样换实现不会改行为。
 */
export interface FramingDeps<S> {
  /** 加载原图，回传解码后的源对象与像素尺寸 */
  loadSource: (target: FramingTarget) => Promise<{ src: S; w: number; h: number }>;
  /** 人脸 → 头部几何；未检出返回 undefined。抛错由本模块兜成「加载失败」 */
  detectHead: (src: S, w: number, h: number) => Promise<HeadGeometry | undefined>;
  /** 下半身分割；不可用时返回 undefined 或抛错（两者都降级为「无分割」） */
  segmentLower: (src: S, w: number, h: number) => Promise<PersonLowerBody | undefined>;
}

export interface EnsureFramesOptions {
  /** 每处理 N 张让出一帧（默认 8），0 表示不让帧 */
  yieldEvery?: number;
  /** 让帧实现，默认 setTimeout(0)；单测注入计数器即可断言让帧时机 */
  schedule?: () => Promise<void>;
}

export interface EnsureFramesOutcome {
  /** 本次真正跑了模型（未命中缓存）的张数 */
  measured: number;
  /** 命中缓存直接跳过的张数 */
  skipped: number;
}

/**
 * 阶段 ①②：为一张照片测出构图输入。**不做缓存** —— 由 `ensureFrames` 决定要不要调。
 * 抛错说明「连源图都读不出来」，交给 `ensureFrames` 记成 `{}`。
 */
export async function measureFrame<S>(
  target: FramingTarget,
  deps: FramingDeps<S>,
): Promise<FramingFrame> {
  const { src, w, h } = await deps.loadSource(target);
  const head = await deps.detectHead(src, w, h);
  if (!head) return { w, h }; // 没脸就不用跑分割（省一次 256×256 推理）
  let lower: PersonLowerBody | undefined;
  try {
    lower = await deps.segmentLower(src, w, h);
  } catch {
    // 分割不可用（无模型/离线）：lower 留空，下游回退「整图底部」近似
  }
  return { head, lower, w, h };
}

/**
 * 阶段 ①②（批量 + 缓存）：逐张补测，写进调用方持有的 `cache`（in/out 参数，非组件状态）。
 * 已缓存的跳过；每 `yieldEvery` 张让一帧，避免长批把主线程占死。
 */
export async function ensureFrames<S>(
  targets: readonly FramingTarget[],
  cache: Map<string, FramingFrame>,
  deps: FramingDeps<S>,
  options: EnsureFramesOptions = {},
): Promise<EnsureFramesOutcome> {
  const yieldEvery = options.yieldEvery ?? FRAME_YIELD_EVERY;
  const schedule = options.schedule ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  let measured = 0;
  let skipped = 0;

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    if (cache.has(target.id)) {
      // continue 在让帧之前 —— 与抽离前一致：命中缓存不产生额外让帧
      skipped += 1;
      continue;
    }
    try {
      cache.set(target.id, await measureFrame(target, deps));
    } catch {
      cache.set(target.id, {});
    }
    measured += 1;
    if (yieldEvery > 0 && (i + 1) % yieldEvery === 0) await schedule();
  }

  return { measured, skipped };
}

/**
 * 「人物底部在图中位置」的唯一提取口：分割不可用 / 未检出时返回 undefined，
 * 由 `specAutoPlacement` 回退「整图底部」近似（旧行为）。
 *
 * 之所以单独导出：构图参数装配（`placementForFrame`）与右栏核查面板的读数
 * 都要问「下半身测出来没有」，两处各写一遍 `lower?.found ? … : undefined`
 * 就是两份真相 —— 改了一处另一处不跟，面板会跟实际构图说不一样的话。
 */
export function personBottomFrac(
  frame: FramingFrame | undefined | null,
): number | undefined {
  return frame?.lower?.found ? frame.lower.bottomFrac : undefined;
}

/**
 * 阶段 ③：按规格把「构图输入」算成 placement。纯同步、无 I/O。
 *
 * 这是「分割结果 → placement」的**唯一**入口：
 * `lower.found` 为真才把真实人物底部交给 `specAutoPlacement`，否则传 undefined
 * 让它回退「整图底部」近似（旧行为）。frame 缺失/null 或没有脸/尺寸 → undefined，
 * 调用方据此走「无脸」分支（多尺寸导出里是「按比例换算手动微调」）。
 */
export function placementForFrame(
  frame: FramingFrame | undefined | null,
  spec: FramingSpec,
  mode: FramingMode = 'default',
  fillScale = 1,
): SpecPlacementResult | undefined {
  if (!frame?.head || !frame.w || !frame.h) return undefined;
  return specAutoPlacement(
    frame.head,
    frame.w,
    frame.h,
    spec,
    mode,
    fillScale,
    personBottomFrac(frame),
  );
}

export interface FramingPlanInput {
  spec: FramingSpec;
  /** 构图模式，默认 'default'（自动构图固定用默认档） */
  mode?: FramingMode;
  /** 自定义构图的放大填满系数，仅 mode==='custom' 生效 */
  fillScale?: number;
  /** 让帧间隔，默认 8 */
  yieldEvery?: number;
  /** 让帧实现，默认 setTimeout(0) */
  schedule?: () => Promise<void>;
}

/** 阶段 ①②③ 的产物：组件拿去写 state（阶段 ④）的原始数据 */
export interface FramingPlan {
  /**
   * id → 取景参数；无脸/加载失败的 id 不出现在这里（保持原构图）。
   * 用 `SpecPlacementResult['placement']` 而非 `matting.Placement`：
   * 自动构图产出的 `zoom` 一定存在（`specAutoPlacement` 恒算出来），
   * 比可选的 `Placement.zoom` 更精确，也才能直接喂给 `computeMetrics`。
   */
  placements: Record<string, SpecPlacementResult['placement']>;
  /** 算出 placement 的张数（原提示文案里的 ok） */
  framed: number;
  /** 未检出人脸（含加载失败）的张数（原提示文案里的 noface） */
  noFace: number;
  /** 其中因「人物下方不足」而触发放大填满的张数（提示/诊断用，不参与文案） */
  filled: number;
  /** 补测（未命中缓存）的张数 */
  measured: number;
}

/**
 * 阶段 ①②③ 一体：给一批照片算出各自 placement，**不写任何 state**。
 *
 * 调用方（`applyAutoFraming`）负责筛选目标、置 busy/progress、把 `placements` 合进 state、
 * 切构图模式、拼提示文案 —— 即阶段 ④ 全部留在组件里，本函数只保证「算得对」。
 */
export async function planPlacements<S>(
  targets: readonly FramingTarget[],
  cache: Map<string, FramingFrame>,
  input: FramingPlanInput,
  deps: FramingDeps<S>,
): Promise<FramingPlan> {
  const { measured } = await ensureFrames(targets, cache, deps, {
    yieldEvery: input.yieldEvery,
    schedule: input.schedule,
  });

  const placements: Record<string, SpecPlacementResult['placement']> = {};
  let framed = 0;
  let noFace = 0;
  let filled = 0;

  for (const target of targets) {
    const r = placementForFrame(cache.get(target.id), input.spec, input.mode, input.fillScale);
    if (!r) {
      noFace += 1;
      continue;
    }
    placements[target.id] = r.placement;
    framed += 1;
    if (r.bottomInsufficient) filled += 1;
  }

  return { placements, framed, noFace, filled, measured };
}
