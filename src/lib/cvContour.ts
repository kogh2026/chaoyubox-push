// 轮廓层：连通域 → 边界点 → 凸包 → 多边形简化(≈approxPolyDP) → 最小外接旋转矩形(≈minAreaRect)。
//
// 与 OpenCV 的对应关系：
//   connectedComponents  ≈  findContours(RETR_EXTERNAL) 的「取外轮廓」这一步
//   convexHull + approx  ≈  approxPolyDP（只对凸包做简化，证卡是凸四边形，够用且更抗噪）
//   minAreaRect          ≈  minAreaRect（旋转卡壳）
// 纯 TS、无 wasm；所有函数只吃 typed array，Node 里可直接单测。

import type { MaskImage } from './cvImage';
import { dist, polyArea, type Pt } from './cvGeometry';

export interface Component {
  label: number;
  pixels: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LabeledMask {
  width: number;
  height: number;
  labels: Int32Array;
  comps: Component[];
  /** 按 label 分组连续存放的像素索引（顺序即入栈序） */
  order: Int32Array;
  /** comps[i] 的像素在 order 里的 [起, 止) 区间 */
  spans: { start: number; end: number }[];
}

/** 8 邻域连通域标记（一次扫描 + 显式栈，避免递归爆栈） */
export function connectedComponents(mask: MaskImage, minPixels = 24): LabeledMask {
  const { width: w, height: h, data } = mask;
  const labels = new Int32Array(w * h);
  const comps: Component[] = [];
  const spans: { start: number; end: number }[] = [];
  const orderBuf: number[] = [];
  const stack = new Int32Array(w * h);
  let next = 0;

  for (let i = 0; i < data.length; i++) {
    if (!data[i] || labels[i]) continue;
    const label = ++next;
    const startIdx = orderBuf.length;
    let sp = 0;
    stack[sp++] = i;
    labels[i] = label;
    let px = 0;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    while (sp > 0) {
      const j = stack[--sp];
      orderBuf.push(j);
      const x = j % w;
      const y = (j - x) / w;
      px++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const k = ny * w + nx;
          if (!data[k] || labels[k]) continue;
          labels[k] = label;
          stack[sp++] = k;
        }
      }
    }
    comps.push({ label, pixels: px, x0, y0, x1, y1 });
    spans.push({ start: startIdx, end: orderBuf.length });
  }
  // 太小的连通域（噪点）直接丢，省掉后面的排序/凸包开销；order/spans 保持下标对齐
  const keepIdx: number[] = [];
  for (let i = 0; i < comps.length; i++) if (comps[i].pixels >= minPixels) keepIdx.push(i);
  return {
    width: w,
    height: h,
    labels,
    comps: keepIdx.map((i) => comps[i]),
    spans: keepIdx.map((i) => spans[i]),
    order: Int32Array.from(orderBuf),
  };
}

/** 取某个连通域的边界像素（4 邻域里有背景者） */
export function boundaryPoints(
  lm: LabeledMask,
  compIdx: number,
  maxPoints = 20000,
): Pt[] {
  const { width: w, height: h, labels } = lm;
  const comp = lm.comps[compIdx];
  const span = lm.spans[compIdx];
  const pts: Pt[] = [];
  for (let k = span.start; k < span.end; k++) {
    const i = lm.order[k];
    const x = i % w;
    const y = (i - x) / w;
    const up = y === 0 ? 0 : labels[i - w];
    const dn = y === h - 1 ? 0 : labels[i + w];
    const lf = x === 0 ? 0 : labels[i - 1];
    const rt = x === w - 1 ? 0 : labels[i + 1];
    if (up === comp.label && dn === comp.label && lf === comp.label && rt === comp.label) continue;
    pts.push({ x, y });
    if (pts.length >= maxPoints) break;
  }
  return pts;
}

/** Andrew monotone chain 凸包（逆时针） */
export function convexHull(points: Pt[]): Pt[] {
  if (points.length < 3) return points.slice();
  const pts = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: Pt, a: Pt, b: Pt): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function dpOpen(pts: Pt[], eps: number): Pt[] {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const e = stack.pop() as number;
    const s = stack.pop() as number;
    if (e - s < 2) continue;
    const a = pts[s];
    const b = pts[e];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1e-9;
    let bestI = -1;
    let bestD = 0;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs((pts[i].x - a.x) * dy - (pts[i].y - a.y) * dx) / len;
      if (d > bestD) {
        bestD = d;
        bestI = i;
      }
    }
    if (bestD > eps && bestI > 0) {
      keep[bestI] = 1;
      stack.push(s, bestI, bestI, e);
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/**
 * 闭合多边形简化（Douglas–Peucker）。做法：先取「离首点最远点」把环切成两条开链，
 * 各自 DP 后再拼回，避免闭合曲线首尾相接处被误简化。
 */
export function approxClosed(pts: Pt[], eps: number): Pt[] {
  const n = pts.length;
  if (n < 5) return pts.slice();
  let a = 0;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const d = dist(pts[0], pts[i]);
    if (d > best) {
      best = d;
      a = i;
    }
  }
  let b = a;
  best = -1;
  for (let i = 0; i < n; i++) {
    const d = dist(pts[a], pts[i]);
    if (d > best) {
      best = d;
      b = i;
    }
  }
  let s = Math.min(a, b);
  let e = Math.max(a, b);
  if (e - s < 2) return pts.slice();
  const c1 = pts.slice(s, e + 1);
  const c2 = pts.slice(e).concat(pts.slice(0, s + 1));
  const d1 = dpOpen(c1, eps);
  const d2 = dpOpen(c2, eps);
  const out = d1.concat(d2.slice(1, -1));
  return out.length >= 3 ? out : pts.slice();
}

/** 多边形是否凸（允许极小抖动） */
export function isConvexPoly(pts: Pt[]): boolean {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const c = pts[(i + 2) % pts.length];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) < 1e-6) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** 最小面积外接旋转矩形（旋转卡壳）：返回 4 个角点（未排序） */
export function minAreaRect(hull: Pt[]): Pt[] {
  const n = hull.length;
  if (n < 3) {
    const x0 = Math.min(...hull.map((p) => p.x));
    const x1 = Math.max(...hull.map((p) => p.x));
    const y0 = Math.min(...hull.map((p) => p.y));
    const y1 = Math.max(...hull.map((p) => p.y));
    return [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
  }
  let bestArea = Infinity;
  let bestU = { x: 1, y: 0 };
  let bestS = 0;
  let bestT = 0;
  let bestLen = 0;
  let bestHei = 0;
  for (let i = 0; i < n; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-6) continue;
    const ux = ex / len;
    const uy = ey / len;
    let minS = Infinity;
    let maxS = -Infinity;
    let minT = Infinity;
    let maxT = -Infinity;
    for (const p of hull) {
      const s = p.x * ux + p.y * uy;
      const t = -p.x * uy + p.y * ux;
      if (s < minS) minS = s;
      if (s > maxS) maxS = s;
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
    const area = (maxS - minS) * (maxT - minT);
    if (area < bestArea) {
      bestArea = area;
      bestU = { x: ux, y: uy };
      bestS = minS;
      bestT = minT;
      bestLen = maxS - minS;
      bestHei = maxT - minT;
    }
  }
  const { x: ux, y: uy } = bestU;
  const vx = -uy;
  const vy = ux;
  const pt = (s: number, t: number): Pt => ({ x: ux * s + vx * t, y: uy * s + vy * t });
  return [
    pt(bestS, bestT),
    pt(bestS + bestLen, bestT),
    pt(bestS + bestLen, bestT + bestHei),
    pt(bestS, bestT + bestHei),
  ];
}

/** 凸多边形面积（鞋带） */
export function hullArea(hull: Pt[]): number {
  return polyArea(hull);
}
