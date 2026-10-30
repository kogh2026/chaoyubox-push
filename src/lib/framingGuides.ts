// 取景微调「居中参考线 + 吸附」纯逻辑层。
// 规格来源：2026-10-28 对爱印 v0.5.0 解密渲染层（id-photo-batch-demo chunk）的只读静态分析，
// 本文件为原创实现，复刻的是交互事实参数：
//
//   - 吸附半径：6 屏幕像素（换算到内容坐标系）；
//   - 「居中」判定：|水平偏移| < 0.05 mm；
//   - 水平（摆正）判定：|倾角| < 0.05°，拖转时 0.6° 内吸附回水平；
//   - Shift 旋转按 15° 吸附；Alt 拖动/旋转一律不吸附；
//   - 参考线双描边：底层 rgba(0,0,0,.35) 3px + 上层彩色 1.5px，未命中时虚线 6 4；
//   - 绿色 = rgb(16 185 129)（命中），白色 = 未命中；
//   - 徽标：命中时 emerald 底「居中 · 按住 Alt 不吸附」，未命中黑底「X.X mm 偏右/左」。
//
// 全部为纯函数（无 DOM），可在 Node 环境回归。

/** 拖动时中线吸附半径（屏幕像素，对应原版 zh=6） */
export const SNAP_SCREEN_PX = 6;
/** |水平偏移| 小于该值（mm）即视为「居中」（原版 Vl=.05） */
export const CENTERED_MM = 0.05;
/** 拖转时距水平小于该值（度）吸附回水平（原版 Fh=.6） */
export const LEVEL_DEG = 0.6;
/** 按住 Shift 旋转时的吸附步长（度） */
export const ROTATE_STEP_DEG = 15;
/** A/T 快捷键触发后参考线短暂显示的时长（毫秒） */
export const GUIDE_FLASH_MS = 1200;

/** 300DPI 下目标像素 → 毫米 */
export function pxToMm(px: number, dpi = 300): number {
  return (px * 25.4) / dpi;
}

/**
 * 拖动水平吸附（对应原版 Sh）：距目标 ≤ range 时直接落到目标上；Alt 按下时不吸附。
 */
export function snapOffset(next: number, target: number, range: number, alt: boolean): number {
  if (alt) return next;
  return Math.abs(next - target) <= range ? target : next;
}

/**
 * 「使眼睛中点落在画布水平中心」所需的内容偏移（屏幕/框像素）。
 * 对应原版 Mh：centeredOffsetX = offsetX − (eyeMid.x − width/2)；
 * 本实现里 off.x 为图像左上角在框内的位置，故直接由眼位反推。
 */
export function centeredOffsetX(eyeMidImgX: number, imgScale: number, boxW: number): number {
  return boxW / 2 - eyeMidImgX * imgScale;
}

/** 眼中点的框内 X 坐标（off.x + 图像坐标 × 缩放） */
export function eyeMidBoxX(offX: number, eyeMidImgX: number, imgScale: number): number {
  return offX + eyeMidImgX * imgScale;
}

/**
 * 当前水平偏移（毫米，正值 = 人物偏右）。
 * box 内像素差 → 目标像素（×pxW/boxW）→ mm。
 */
export function centerOffsetMm(
  eyeMidBoxX: number,
  boxW: number,
  pxW: number,
  dpi = 300,
): number {
  const px = (eyeMidBoxX - boxW / 2) * (pxW / boxW);
  return pxToMm(px, dpi);
}

/** 徽标文案：居中 / X.X mm 偏右|左（原版 xc） */
export function centerLabel(mm: number): string {
  return Math.abs(mm) < CENTERED_MM ? '居中' : `${Math.abs(mm).toFixed(1)} mm 偏${mm > 0 ? '右' : '左'}`;
}

/** 旋转徽标文案：水平 / X.X° 右低|左低（原版语义：正值 = 右低） */
export function tiltLabel(deg: number): string {
  return Math.abs(deg) < 0.05 ? '水平' : `${Math.abs(deg).toFixed(1)}° ${deg > 0 ? '右低' : '左低'}`;
}

/** 是否居中 / 是否水平 */
export const isCentered = (mm: number): boolean => Math.abs(mm) < CENTERED_MM;
export const isLevel = (deg: number): boolean => Math.abs(deg) < 0.05;

/**
 * 旋转拖动的角度决策（对应原版 rotate 分支）：
 *   Shift → 15° 步进；Alt → 不吸附（保留 0.1° 精度）；
 *   其余 → 距水平 ≤ 0.6° 时吸附到水平角，否则保留 0.1° 精度。
 * levelAngle：本张照片「眼睛水平」所需的旋转角（= −眼线自然倾角）。
 */
export function snapRotation(angle: number, levelAngle: number, alt: boolean, shift: boolean): number {
  if (shift) return Math.round(angle / ROTATE_STEP_DEG) * ROTATE_STEP_DEG;
  if (!alt && Math.abs(angle - levelAngle) <= LEVEL_DEG) return levelAngle;
  return Math.round(angle * 10) / 10;
}

export interface AxisBox {
  /** 脸中轴线（框内坐标） */
  x: number;
  topY: number;
  bottomY: number;
}

/**
 * 脸中轴线：从头顶到下巴，沿眼睛中点垂下。
 * BlazeFace 只有 6 点，无头顶/下巴关键点，按人脸比例近似：
 *   头顶 ≈ 眼线上方 0.70×脸宽，下巴 ≈ 眼线下方 0.95×脸宽；
 * 结果 clamp 到图像范围内（框内坐标）。
 */
export function faceAxis(
  eyeMidImg: { x: number; y: number },
  faceWidthImg: number,
  imgScale: number,
  offX: number,
  offY: number,
  boxH: number,
): AxisBox {
  const x = eyeMidBoxX(offX, eyeMidImg.x, imgScale);
  const eyeY = offY + eyeMidImg.y * imgScale;
  const fw = faceWidthImg * imgScale;
  return {
    x,
    topY: Math.max(0, eyeY - fw * 0.7),
    bottomY: Math.min(boxH, eyeY + fw * 0.95),
  };
}

/** 沿单位向量取半长 L 的线段端点（旋转模式的眼轴线，原版半长 = 0.36×宽） */
export function alongUnit(
  cx: number,
  cy: number,
  ux: number,
  uy: number,
  half: number,
): { x1: number; y1: number; x2: number; y2: number } {
  return { x1: cx - ux * half, y1: cy - uy * half, x2: cx + ux * half, y2: cy + uy * half };
}

/** 眼线自然倾角（度）：右眼比左眼低为正（= 顺时针 = 右低，与 tiltLabel 语义一致） */
export function eyeRollDeg(right: { x: number; y: number }, left: { x: number; y: number }): number {
  const dx = left.x - right.x;
  const dy = right.y - left.y;
  if (dx === 0 && dy === 0) return 0;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

export interface FaceInfo {
  /** 眼睛中点（原图像素坐标） */
  eyeMid: { x: number; y: number };
  /** 脸宽（原图像素） */
  faceWidth: number;
  /** 眼线自然倾角（度，右低为正） */
  rollDeg: number;
}

/**
 * 无脸回退：BlazeFace 检测不到人脸（动物/背影/侧脸过大等）时，
 * 用图像几何中心当「眼位」、图宽 40% 当「脸宽」（仅用于画中轴线长度），
 * 保证参考线与吸附在任何照片上都可用（中线吸附即几何居中，水平线即图像中线）。
 */
export function fallbackFaceInfo(nw: number, nh: number): FaceInfo {
  return { eyeMid: { x: nw / 2, y: nh / 2 }, faceWidth: nw * 0.4, rollDeg: 0 };
}
