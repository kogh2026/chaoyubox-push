// 证件照「按规格自动构图 + 放大填满 + 逐项核查」纯逻辑层（复刻爱印 v0.5.0 渲染层）。
//
// 来源：对爱印解密渲染层（export-DCg5OXfg.js 构图引擎、id-photo-batch-demo 偏差核查、
//       ai-id-photo-workspace 右侧面板）的只读静态分析。本文件为原创实现，
//       复刻的是其交互事实参数与几何算法，不复制任何加密资产。
//
// 爱印真实参数（已锚定到原代码）：
//   - 尺寸规格模板含 topRatio / headRatio / safeRatio（如 一寸 0.08 / 0.64 / 0.035，
//     小二寸 0.08 / 0.62 / 0.035，护照 0.08 / 30.5/48≈0.635 / 0.03）。
//   - 默认构图：人物下方不足时自动放大最多 20% 填满。
//   - 放大填满硬上限 bottomAnchorScale = clamp(ratio, 1, 1.35)（自定义构图由滑杆控制，仍受此上限约束）。
//   - 逐项核查偏差判定 Ti(v, target, tol)：v>target+tol→high，v<target−tol→low，否则 match。
//     容差 yh=0.02（头高）、vh=0.015（留白）。
//   - 告警文案：头高偏大/偏小、留白偏多/偏少、头顶为估算、头顶出框。
//
// 全部为纯函数（无 DOM），可在 Node 环境回归；真正绘制仍走 matting.composeGeometry/composePhoto。

import type { HeadGeometry } from './faceFrame';

/** 规格构图比例（归一化，占画幅比例） */
interface FramingRatios {
  /** 发顶距上边占画幅高比例（头顶留白），如 0.08 */
  topRatio: number;
  /** 头部（发顶到下巴）占画幅高比例（头部占比），如 0.64 */
  headRatio: number;
  /** 安全边距占画幅高比例（衣物/发梢不贴边），如 0.035 */
  safeRatio: number;
}

/** 完整构图规格：毫米尺寸 + 像素尺寸 + 比例 */
export interface FramingSpec extends FramingRatios {
  /** 物理宽（mm） */
  mmW: number;
  /** 物理高（mm） */
  mmH: number;
  /** 输出宽（px，@dpi） */
  pxW: number;
  /** 输出高（px，@dpi） */
  pxH: number;
}

/** 构图模式（对应爱印右侧「人像构图」下拉 + 目标描述优先级） */
export type FramingMode =
  | 'keep' // 保持原图：不自动构图，整图居中（cover）
  | 'spec' // 按规格要求：严格落到规格比例，不做放大填满
  | 'custom' // 自定义构图：规格比例 + 用户「放大填满」滑杆控制
  | 'default'; // 默认构图：规格比例 + 人物下方不足时自动放大最多 20% 填满

/** 放大填满相关常量（源自爱印） */
export const BOTTOM_FILL_HARD_MAX = 1.35; // Lt(…, 1, 1.35) 硬上限
export const BOTTOM_FILL_NOMINAL = 1.2; // 默认构图「最多 20%」

/** 逐项核查容差（源自爱印 yh/vh） */
export const HEAD_RATIO_TOL = 0.02;
export const TOP_RATIO_TOL = 0.015;

/** 默认构图比例（行业通行默认值，未逐尺寸标定的规格回退到此） */
export const DEFAULT_RATIOS: FramingRatios = { topRatio: 0.08, headRatio: 0.64, safeRatio: 0.035 };

/**
 * 偏差判定（精确复刻爱印 Ti(t,s,o)）：
 *   t > s + o → 'high'；t < s − o → 'low'；否则 'match'。
 */
export function classifyDeviation(value: number, target: number, tol: number): 'match' | 'high' | 'low' {
  if (value > target + tol) return 'high';
  if (value < target - tol) return 'low';
  return 'match';
}

/** cover 基准缩放：图以不变形方式铺满画布所需的最小缩放 */
export function coverScale(imgW: number, imgH: number, pxW: number, pxH: number): number {
  return Math.max(pxW / Math.max(1, imgW), pxH / Math.max(1, imgH));
}

export interface SpecPlacementResult {
  /** 直接喂给 matting.composeGeometry 的取景参数 */
  placement: { dx: number; dy: number; zoom: number; rotation?: number };
  /** 人物下方放大填满系数（相对 cover 基准的额外缩放，≥1） */
  bottomAnchorScale: number;
  /**
   * 是否确因「下方不足」而触发放大填满（scaleForBottom > baseScale）。
   * 仅当人物下半身真实偏短、构图下方留有背景空隙时才为 true —— 即爱印「确有必要时」触发。
   */
  bottomInsufficient: boolean;
  /** 回传实际使用的「发顶→人物底部」归一化距离（便于面板/调试展示） */
  personBelowFrac: number;
}

/**
 * 按规格自动构图（复刻爱印默认/自定义构图引擎）。
 *
 * 几何：先 cover 铺满，再按 headRatio 把「发顶→下巴」高度摆到 headRatio×画幅高；
 * 发顶落在 topRatio×画幅高处；水平方向头部中心对齐画幅中线。
 * 放大填满：爱印真实算法 `E=(height+M−f)/w`（`w`=发顶→人物真实底部的归一化距离），
 * 再 `_=clamp(N, m, m×1.2)`（默认最多放大 20%）。仅在人物下半身真实偏短、下方留有背景
 * 空隙时 `scaleForBottom > baseScale` 才放大多填；人物已到达图底（下半身充足）则不放大。
 * 这替代了旧版「用整图底部区域(1−head.top)近似」的判断，使放大填满仅在确有必要时触发。
 *
 * @param head       由人脸框/关键点估计的头部几何（归一化 0..1）
 * @param imgW/imgH  原图像素尺寸
 * @param spec       尺寸规格（mm/px/比例）
 * @param mode       构图模式，默认 'default'
 * @param fillScale  自定义构图的放大填满系数（1.0..1.35），仅 mode==='custom' 生效
 * @param personBottomFrac  人物真实底部归一化 Y（0..1），来自下半身分割；缺省回退旧近似
 */
export function specAutoPlacement(
  head: HeadGeometry,
  imgW: number,
  imgH: number,
  spec: FramingSpec,
  mode: FramingMode = 'default',
  fillScale = 1,
  personBottomFrac?: number,
): SpecPlacementResult {
  const { pxW, pxH, topRatio, headRatio } = spec;
  const cover = coverScale(imgW, imgH, pxW, pxH);

  // 目标头部高度（px）与发顶位置（px）
  const wantHeadPx = Math.max(1, headRatio * pxH);
  const headPxImg = Math.max(1e-6, head.height * imgH);
  // 让「发顶→下巴」达到 wantHeadPx 所需的缩放
  const scaleForHead = wantHeadPx / headPxImg;
  // 不允许缩到 cover 以下（否则画面边缘会露白）
  const baseScale = Math.max(cover, scaleForHead);

  // 放大填满基准：发顶→人物底部 要填满「发顶→画布底(留小边距)」所需的缩放 E。
  // 爱印 E=(height+M−f)/w，其中 w = 人物真实底部 − 发顶（归一化），f=topRatio·height。
  //   - 有分割(personBottomFrac)：w = personBottomFrac − head.top（真实下半身长度）；
  //     人物下半身越短 → w 越小 → E 越大 → 越需要放大填满（消除人物下方的背景空隙）。
  //   - 无分割(回退)：w = 1 − head.top（旧近似，把整图底部当作人物底部），保持旧行为。
  const hasPersonBottom = typeof personBottomFrac === 'number' && Number.isFinite(personBottomFrac);
  const personBelowFrac = hasPersonBottom
    ? Math.max(1e-3, Math.min(1 - head.top, personBottomFrac! - head.top))
    : Math.max(1e-6, 1 - head.top);
  // 底部留约 0.4% 画幅高度的边距，避免人物底部贴边（仅在有真实分割时生效，回退路径保持旧公式）
  const marginPx = hasPersonBottom ? Math.max(0, Math.min(8, Math.round(pxH * 0.004))) : 0;
  const scaleForBottom = ((1 - topRatio) * pxH + marginPx) / (personBelowFrac * imgH);

  let finalScale = baseScale;
  let bottomAnchorScale = 1;

  if (mode === 'custom') {
    // 自定义：用户「放大填满」滑杆直接控制，受硬上限约束
    const clamped = Math.min(Math.max(1, fillScale), BOTTOM_FILL_HARD_MAX);
    finalScale = baseScale * clamped;
    bottomAnchorScale = clamped;
  } else if (mode === 'default') {
    // 默认：仅当人物下方不足(scaleForBottom>baseScale)才放大，且最多 20%
    const want = Math.max(baseScale, scaleForBottom);
    const capped = Math.min(want, baseScale * BOTTOM_FILL_NOMINAL);
    finalScale = capped;
    bottomAnchorScale = capped / baseScale;
  }
  // 'keep' / 'spec'：不放大填满（bottomAnchorScale=1）

  const bottomInsufficient = scaleForBottom > baseScale + 1e-9;

  const zoom = finalScale / cover;
  const scale = cover * zoom;

  const dw = imgW * scale;
  const dh = imgH * scale;
  // 发顶落在 topRatio·pxH；头部中心水平对齐画幅中线（沿用 autoPlacement 语义）
  const ox = pxW / 2 - head.cx * imgW * scale;
  const oy = topRatio * pxH - head.top * imgH * scale;
  // dx/dy = 相对 cover 居中位置的偏移（composeGeometry 的语义）
  const dx = Math.round(ox - (pxW - dw) / 2);
  const dy = Math.round(oy - (pxH - dh) / 2);

  return {
    placement: { dx, dy, zoom: Number(zoom.toFixed(4)), rotation: 0 },
    bottomAnchorScale: Number(bottomAnchorScale.toFixed(4)),
    bottomInsufficient,
    personBelowFrac,
  };
}

/** 构图后实测指标（用于逐项核查） */
export interface FramingMetrics {
  /** 每像素对应毫米（纵向） */
  mmPerPx: number;
  /** 头部高（px） */
  headHeightPx: number;
  /** 实测头部占比（headHeightPx / pxH） */
  headRatio: number;
  /** 发顶距上边（px） */
  topMarginPx: number;
  /** 实测头顶留白（topMarginPx / pxH） */
  topRatio: number;
  /** 下巴目标 Y（px）= (topRatio + headRatio)·pxH */
  targetChinY: number;
  /** 发顶是否出框（被裁切） */
  headTopOutside: boolean;
  /** 头部中心 X（归一化，回传便于 UI） */
  headCx: number;
}

/**
 * 由头部几何 + 原图尺寸 + 取景参数 + 规格，反推实测构图指标。
 * 与 specAutoPlacement 共用同一套 cover/zoom 语义（composeGeometry 的绘制逻辑），
 * 确保「逐项核查」测的是真正要画出来的结果——尤其放大填满后头部占比会超过规格目标，
 * 正是这里被判定为「头高偏大」。
 */
export function computeMetrics(
  head: HeadGeometry,
  imgW: number,
  imgH: number,
  placement: { dx: number; dy: number; zoom: number; rotation?: number },
  spec: FramingSpec,
): FramingMetrics {
  const { pxW, pxH, topRatio, headRatio, mmH } = spec;
  const cover = coverScale(imgW, imgH, pxW, pxH);
  const rotation = placement.rotation ?? 0;
  const noRot = rotation % 360 === 0;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const rotH = noRot ? imgH : imgW * sin + imgH * cos;
  const scale = cover * placement.zoom;
  const dh = rotH * scale;
  // 图像左上角在画布中的位置（含 dx/dy 偏移）
  const imgTopY = (pxH - dh) / 2 + placement.dy;
  // 发顶 / 头部高（px）
  const headTopCanvasY = imgTopY + head.top * imgH * scale;
  const headHeightPx = head.height * imgH * scale;
  const mmPerPx = mmH / pxH;
  return {
    mmPerPx,
    headHeightPx,
    headRatio: headHeightPx / pxH,
    topMarginPx: headTopCanvasY,
    topRatio: headTopCanvasY / pxH,
    targetChinY: (topRatio + headRatio) * pxH,
    headTopOutside: headTopCanvasY < 0,
    headCx: head.cx,
  };
}

export interface FramingVerification {
  headRatioDeviation: 'match' | 'high' | 'low';
  topRatioDeviation: 'match' | 'high' | 'low';
  headTopOutside: boolean;
  headTopEstimated: boolean;
  warnings: string[];
}

/**
 * 逐项核查（复刻爱印 id-photo-batch-demo 告警逻辑）：
 *   头高偏大/偏小、留白偏多/偏少、头顶出框、头顶为估算。
 * 对照规格模板的目标比例与容差（HEAD_RATIO_TOL / TOP_RATIO_TOL）。
 */
export function verifyFraming(
  metrics: FramingMetrics,
  spec: FramingSpec,
  headTopEstimated = false,
): FramingVerification {
  const headRatioDeviation = classifyDeviation(metrics.headRatio, spec.headRatio, HEAD_RATIO_TOL);
  const topRatioDeviation = classifyDeviation(metrics.topRatio, spec.topRatio, TOP_RATIO_TOL);
  const warnings: string[] = [];
  if (headRatioDeviation !== 'match') {
    warnings.push(headRatioDeviation === 'high' ? '头高偏大' : '头高偏小');
  }
  if (topRatioDeviation !== 'match') {
    warnings.push(topRatioDeviation === 'high' ? '留白偏多' : '留白偏少');
  }
  if (metrics.headTopOutside) warnings.push('头顶出框');
  if (headTopEstimated) warnings.push('头顶为估算');
  return {
    headRatioDeviation,
    topRatioDeviation,
    headTopOutside: metrics.headTopOutside,
    headTopEstimated,
    warnings,
  };
}

/** 把「头部占比 X%（Y mm）」「头顶留白 X%（Y mm）」格式化为爱印同款读数 */
export function formatRatioReadout(ratio: number, mmFull: number): string {
  const pct = (ratio * 100).toFixed(1);
  const mm = (ratio * mmFull).toFixed(1);
  return `${pct}%（${mm} mm）`;
}
