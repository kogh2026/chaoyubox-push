/**
 * 界面自适应缩放计算（纯函数，便于单测）。
 *
 * 背景：整套 UI 的间距、字号、控件尺寸都以 CSS px 硬编码，在 1440×820 的设计基准下排布。
 * 窗口变小时这些 px 不会变，于是出现「右侧被挤出 + 横向滚动条 + 按钮被挤成竖排文字」；
 * 窗口变大时又会在两侧留大片空白。
 *
 * 方案：给根元素施加 `zoom`（等价于浏览器页面缩放），把整个界面按窗口相对设计基准的比例
 * 整体放大/缩小 —— 间距、字号、控件、画布一起等比变化，不需要逐条改样式。
 *
 * 两个关键点（已用 Chromium 实测）：
 * 1. 根 zoom **不会** 改变 `window.innerWidth/innerHeight`（仍是未缩放的 CSS px），
 *    所以按窗口尺寸反算缩放系数不会形成"改 zoom → 触发 resize → 再改 zoom"的回环。
 * 2. 根 zoom 会让 `100vh` 这类视口单位被乘上系数（zoom 0.8 时 100vh 实际只有 0.8 屏高），
 *    因此布局里凡是写成 `100vh` 的地方都要改成 `calc(100vh / var(--ui-zoom))` 才真正等于一屏。
 */

import { clamp } from './imageFilters';

/** 设计基准（界面按此尺寸排版）；取 Electron 默认窗口 1440×820 */
export const UI_DESIGN_W = 1440;
export const UI_DESIGN_H = 820;

/** 自动缩放的上下限：下限保证字还看得清，上限避免大屏上控件大得离谱 */
export const FIT_MIN = 0.72;
export const FIT_MAX = 1.2;

/** 最终 zoom 的绝对边界（含用户手动缩放），防止极端值把界面压扁 */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;

export interface ViewportSize {
  width: number;
  height: number;
}

/** 保留 3 位小数，避免浮点抖动导致反复写 DOM */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * 按窗口尺寸算出"适配系数"：取宽、高中更紧张的一边做基准，
 * 保证横向不放大的同时纵向也不会被裁掉。**低于 1 表示需要缩小界面来装下全部内容。**
 */
export function computeFitScale(size: ViewportSize): number {
  const { width, height } = size;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
  const raw = Math.min(width / UI_DESIGN_W, height / UI_DESIGN_H);
  return clamp(round3(raw), FIT_MIN, FIT_MAX);
}

/**
 * 最终作用于根元素的 zoom = 用户手动缩放 × 自动适配系数。
 *
 * @param userZoomPct 设置里的界面缩放百分比（100 = 100%）
 * @param size        当前视口（CSS px，未缩放）
 * @param autoFit     是否启用"跟随窗口自适应"（设置项可关）
 */
export function computeUiZoom(userZoomPct: number, size: ViewportSize, autoFit = true): number {
  const base = Number.isFinite(userZoomPct) && userZoomPct > 0 ? userZoomPct / 100 : 1;
  const fit = autoFit ? computeFitScale(size) : 1;
  return clamp(round3(base * fit), ZOOM_MIN, ZOOM_MAX);
}
