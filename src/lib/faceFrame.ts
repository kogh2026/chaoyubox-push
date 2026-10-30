// 证件照自动构图（P1-A）：由人脸框/关键点推算「头部几何」，再换算成合成时的缩放与偏移。
// 目标规格取行业通行值（可按需微调）：头部（含发顶）高度约占画幅 60%，发顶距上边约 9%。
// 全部为纯函数，便于单测；真正绘制在 matting.composePhoto 里完成。
import type { DetectedFace } from './faceDetect';

export interface HeadGeometry {
  /** 头部中心横坐标（归一化 0..1） */
  cx: number;
  /** 发顶纵坐标（归一化 0..1） */
  top: number;
  /** 头部高度（含发顶到下巴，归一化 0..1） */
  height: number;
}

export interface HeadSpec {
  /** 头部高度占画幅比例，默认 0.6 */
  heightFrac?: number;
  /** 发顶距上边比例，默认 0.09 */
  topFrac?: number;
}

/**
 * 由人脸框与关键点估计头部几何（含头发）。
 * BlazeFace 的框大致覆盖「额头→下巴」，发顶在框上方约 0.12 个框高；
 * 有关键点时用眼睛/嘴的纵向关系推算下巴，比纯框更稳。
 */
export function headFromFace(face: DetectedFace): HeadGeometry {
  const { box, kp } = face;
  const validKp = kp && kp.length >= 6 && kp.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  const cx = box.x + box.w / 2;
  if (!validKp) {
    const top = box.y - box.h * 0.12;
    return { cx, top, height: box.y + box.h - top };
  }
  const eyeY = (kp[0].y + kp[1].y) / 2;
  const mouthY = kp[3].y;
  // 嘴到下巴约为「眼-嘴距离」的 0.55 倍；眼到发顶约为「眼-下巴」的 0.51 倍
  const chin = mouthY + Math.max(0, mouthY - eyeY) * 0.55;
  const top = eyeY - (chin - eyeY) * 1.04;
  const height = Math.max(0.02, chin - top);
  // 眼睛中点比框中心更贴近真实头部中线
  const eyeCx = (kp[0].x + kp[1].x) / 2;
  return { cx: Number.isFinite(eyeCx) ? eyeCx : cx, top, height };
}

export interface AutoPlacement {
  dx: number;
  dy: number;
  /** 相对 cover 基准的额外缩放（≥1，保证永不露白） */
  zoom: number;
}

/**
 * 把人脸摆在规格要求的位置上，反推合成参数。
 * 坐标沿用 matting.composePhoto 的语义：先 cover 缩放，再叠加 dx/dy 平移（目标像素）。
 */
export function autoPlacement(
  head: HeadGeometry,
  imgW: number,
  imgH: number,
  targetW: number,
  targetH: number,
  spec: HeadSpec = {},
): AutoPlacement {
  const heightFrac = spec.heightFrac ?? 0.6;
  const topFrac = spec.topFrac ?? 0.09;
  const cover = Math.max(targetW / imgW, targetH / imgH);
  const wantHeadPx = Math.max(1, heightFrac * targetH);
  const headPx = Math.max(1e-6, head.height * imgH);
  const wantScale = wantHeadPx / headPx;
  // 不允许缩到 cover 以下（否则画面边缘会露白）
  const zoom = Math.max(1, wantScale / cover);
  const scale = cover * zoom;
  const dw = imgW * scale;
  const dh = imgH * scale;
  // 目标：头部中心对齐画幅中线；发顶落在 topFrac 处
  const ox = targetW / 2 - head.cx * imgW * scale;
  const oy = topFrac * targetH - head.top * imgH * scale;
  const dx = ox - (targetW - dw) / 2;
  const dy = oy - (targetH - dh) / 2;
  return { dx: Math.round(dx), dy: Math.round(dy), zoom: Number(zoom.toFixed(4)) };
}

/** 眼睛连线相对水平的倾角（度）：正值代表头向右歪 */
export function faceRollDeg(face: DetectedFace): number {
  const [re, le] = face.kp;
  if (!re || !le) return 0;
  const dx = le.x - re.x;
  const dy = le.y - re.y;
  if (dx === 0 && dy === 0) return 0;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/**
 * 偏头程度（-1..1）：鼻子相对双眼中点的水平偏移比例，0 为正脸。
 * 这是轻量代理指标（没有 yaw 标注模型），±0.35 以上视为明显偏头。
 */
export function faceYawRatio(face: DetectedFace): number {
  const [re, le, nose] = face.kp;
  if (!re || !le || !nose) return 0;
  const mid = (re.x + le.x) / 2;
  const half = Math.abs(le.x - re.x) / 2;
  if (half < 1e-6) return 0;
  return Math.max(-1, Math.min(1, (nose.x - mid) / half));
}
