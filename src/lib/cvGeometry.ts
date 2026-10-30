// 检测用几何工具：角点排序、四边形面积/边长/宽高比、包围盒 IoU、单应矩阵。
// 全部纯函数，方便在 Node 里单测（不碰 canvas / DOM）。

export interface Pt {
  x: number;
  y: number;
}

/** 四角点（归一化 0..1）：p0 左上 / p1 右上 / p2 右下 / p3 左下 */
export interface Quad {
  p0: Pt;
  p1: Pt;
  p2: Pt;
  p3: Pt;
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 依据 x+y / x−y 把任意四点排序为 左上/右上/右下/左下（对旋转、透视都成立） */
export function orderQuad(pts: Pt[]): [Pt, Pt, Pt, Pt] {
  const bySum = pts.map((p) => p.x + p.y);
  const byDiff = pts.map((p) => p.x - p.y);
  const tl = pts[bySum.indexOf(Math.min(...bySum))];
  const br = pts[bySum.indexOf(Math.max(...bySum))];
  const tr = pts[byDiff.indexOf(Math.max(...byDiff))];
  const bl = pts[byDiff.indexOf(Math.min(...byDiff))];
  return [tl, tr, br, bl];
}

/** 鞋带公式面积（绝对值） */
export function polyArea(pts: Pt[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

export function polyPerimeter(pts: Pt[], closed = true): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (!closed && i === pts.length - 1) break;
    s += dist(a, b);
  }
  return s;
}

/** 四边形平均宽/高（对边取均值，透视下更稳） */
export function quadSize(q: Quad): { w: number; h: number } {
  const w = (dist(q.p0, q.p1) + dist(q.p3, q.p2)) / 2;
  const h = (dist(q.p0, q.p3) + dist(q.p1, q.p2)) / 2;
  return { w, h };
}

/** 宽高比，恒 ≥1（正方形为 1）；用长边/短边，横竖卡都能用同一套阈值 */
export function quadAspect(q: Quad): number {
  const { w, h } = quadSize(q);
  const mx = Math.max(w, h);
  const mn = Math.min(w, h);
  return mn < 1 ? 0 : mx / mn;
}

/** 轴对齐包围盒 */
export function quadBBox(q: Quad): { x0: number; y0: number; x1: number; y1: number } {
  const xs = [q.p0.x, q.p1.x, q.p2.x, q.p3.x];
  const ys = [q.p0.y, q.p1.y, q.p2.y, q.p3.y];
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

/** 包围盒 IoU（NMS 用；比多边形 IoU 便宜，且对近似同一张卡的候选足够） */
export function bboxIoU(a: Quad, b: Quad): number {
  const A = quadBBox(a);
  const B = quadBBox(b);
  const ix = Math.max(0, Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0));
  const iy = Math.max(0, Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const ua = (A.x1 - A.x0) * (A.y1 - A.y0);
  const ub = (B.x1 - B.x0) * (B.y1 - B.y0);
  const union = ua + ub - inter;
  return union <= 0 ? 0 : inter / union;
}

/** 内层框被外层框覆盖的面积占比（相对内层框）——用来剔除「卡面文字框套在卡里」这类嵌套候选 */
export function bboxOverlapInner(inner: Quad, outer: Quad): number {
  const A = quadBBox(inner);
  const B = quadBBox(outer);
  const ix = Math.max(0, Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0));
  const iy = Math.max(0, Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0));
  const area = (A.x1 - A.x0) * (A.y1 - A.y0);
  return area <= 0 ? 0 : (ix * iy) / area;
}

export function quadCenter(q: Quad): Pt {
  return {
    x: (q.p0.x + q.p1.x + q.p2.x + q.p3.x) / 4,
    y: (q.p0.y + q.p1.y + q.p2.y + q.p3.y) / 4,
  };
}

/** 点在四边形内（射线法，任意简单多边形可用） */
export function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-9) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** 归一化 Quad → 像素角点（p0..p3 顺序） */
export function quadToPx(q: Quad, w: number, h: number): Pt[] {
  return [
    { x: q.p0.x * w, y: q.p0.y * h },
    { x: q.p1.x * w, y: q.p1.y * h },
    { x: q.p2.x * w, y: q.p2.y * h },
    { x: q.p3.x * w, y: q.p3.y * h },
  ];
}

/** 像素角点 → 归一化 Quad（自动排序为 p0 左上 … p3 左下） */
export function pxToQuad(pts: Pt[], w: number, h: number): Quad {
  const [p0, p1, p2, p3] = orderQuad(pts);
  return {
    p0: { x: p0.x / w, y: p0.y / h },
    p1: { x: p1.x / w, y: p1.y / h },
    p2: { x: p2.x / w, y: p2.y / h },
    p3: { x: p3.x / w, y: p3.y / h },
  };
}

/** 顺时针转 90° 后角点变换：原 (x,y) → 显示 (1-y, x) */
export function rotateQuadCW(q: Quad): Quad {
  const f = (p: Pt): Pt => ({ x: 1 - p.y, y: p.x });
  return { p0: f(q.p0), p1: f(q.p1), p2: f(q.p2), p3: f(q.p3) };
}

/**
 * 按目标输出方向重排角点：让 p0→p1 落在期望的长边/短边方向。
 *
 * 必须在**像素空间**做：归一化坐标里 x/y 量纲被画幅比例缩放，16:9 的手机照片下
 * 一张 1.585 的横版卡归一化后会被算成「竖版」，误转 90° 把卡拍扁。
 */
export function orientPoints(pts: Pt[], wantLandscape: boolean): Pt[] {
  const w = (dist(pts[0], pts[1]) + dist(pts[3], pts[2])) / 2;
  const h = (dist(pts[0], pts[3]) + dist(pts[1], pts[2])) / 2;
  if (w >= h === wantLandscape) return pts;
  // 顺序轮转一位（等价原地转 90°），并保持 p0 仍是「新的左上」
  return [pts[3], pts[0], pts[1], pts[2]];
}

/** 解 8 参数单应矩阵 H：把 dst 四点映射到 src 四点（高斯消元，返回 h00..h21） */
export function solveH(dst: Pt[], src: Pt[]): number[] {
  const M: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = dst[i];
    const { x: u, y: v } = src[i];
    M.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    M.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) {
      if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    }
    const tmp = M[c];
    M[c] = M[piv];
    M[piv] = tmp;
    const d = M[c][c] || 1e-12;
    for (let j = c; j <= 8; j++) M[c][j] /= d;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (!f) continue;
      for (let j = c; j <= 8; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row) => row[8]);
}

/** 用单应矩阵把 (x,y) 映射回去 */
export function applyH(H: number[], x: number, y: number): Pt {
  const den = H[6] * x + H[7] * y + 1;
  const d = Math.abs(den) < 1e-9 ? 1e-9 : den;
  return { x: (H[0] * x + H[1] * y + H[2]) / d, y: (H[3] * x + H[4] * y + H[5]) / d };
}
