// 本地证件边缘自动检测 + 透视矫正（经典 CV：Sobel 梯度 + 单应映射，无端侧模型）

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

export interface DetectResult {
  quad: Quad;
  /** 0..1 边界梯度支持率，低于 ~0.6 视为「需检查」 */
  confidence: number;
}

/** 全图微内缩（用于已矫正图片再次编辑） */
export const FULL_QUAD: Quad = {
  p0: { x: 0.015, y: 0.015 },
  p1: { x: 0.985, y: 0.015 },
  p2: { x: 0.985, y: 0.985 },
  p3: { x: 0.015, y: 0.985 },
};

const FALLBACK: DetectResult = { quad: FULL_QUAD, confidence: 0.4 };

function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

/**
 * 自动检测证件四角。流程：降采样 → 灰度 → Sobel 梯度 → 行/列能量剖面取最长
 * 高能段作为初始包围盒 → 沿四边采样、法向搜索最强梯度位置取中位数精修角点。
 */
export function detectCardQuad(img: HTMLImageElement): DetectResult {
  try {
    if (!img.naturalWidth || !img.naturalHeight) return FALLBACK;
    const W = 240;
    const s = Math.min(1, W / img.naturalWidth, W / img.naturalHeight);
    const w = Math.max(48, Math.round(img.naturalWidth * s));
    const h = Math.max(48, Math.round(img.naturalHeight * s));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return FALLBACK;
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;

    const gray = new Float32Array(w * h);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4)
      gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];

    const mag = new Float32Array(w * h);
    let sum = 0;
    let sum2 = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx =
          gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] -
          gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1];
        const gy =
          gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] -
          gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1];
        const m = Math.hypot(gx, gy);
        mag[i] = m;
        sum += m;
        sum2 += m * m;
      }
    }
    const n = (w - 2) * (h - 2);
    const mean = sum / n;
    const std = Math.sqrt(Math.max(1, sum2 / n - mean * mean));
    const th = mean + 0.5 * std; // 长直边（卡边界）阈值

    // 行/列强梯度计数：卡的左右边缘是「整列高计数」的峰值列，
    // 上下边缘同理，远高于背景噪声行，也高于只有零散文字的列。
    const colP = new Float32Array(w);
    const rowP = new Float32Array(h);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++)
        if (mag[y * w + x] > th) {
          colP[x]++;
          rowP[y]++;
        }
    const argmax = (prof: Float32Array, from: number, to: number): number => {
      let bi = from;
      for (let i = from + 1; i < to; i++) if (prof[i] > prof[bi]) bi = i;
      return bi;
    };
    const minSpan = 0.3;
    let xl = argmax(colP, 1, Math.floor(w * (1 - minSpan)));
    let xr = argmax(colP, Math.min(w - 2, xl + Math.floor(w * minSpan)), w - 1);
    let yt = argmax(rowP, 1, Math.floor(h * (1 - minSpan)));
    let yb = argmax(rowP, Math.min(h - 2, yt + Math.floor(h * minSpan)), h - 1);
    // 边缘峰值必须显著（覆盖足够长度才像一条直边）
    if (colP[xl] < h * 0.25 || colP[xr] < h * 0.25 || rowP[yt] < w * 0.25 || rowP[yb] < w * 0.25)
      return FALLBACK;

    // 沿边采样精修：返回 {偏移, 支持率}
    const refine = (
      ax: number, ay: number, bx: number, by: number,
      nx: number, ny: number,
    ): { off: number; sup: number } => {
      const K = 24;
      const offs: number[] = [];
      let sup = 0;
      const range = Math.max(6, ((xr - xl) + (yb - yt)) * 0.035);
      for (let k = 0; k < K; k++) {
        const t = (k + 0.5) / K;
        const px = ax + (bx - ax) * t;
        const py = ay + (by - ay) * t;
        let bestO = 0;
        let bestM = 0;
        for (let o = -range; o <= range; o += 1) {
          const sx = Math.round(px + nx * o);
          const sy = Math.round(py + ny * o);
          if (sx < 1 || sy < 1 || sx >= w - 1 || sy >= h - 1) continue;
          const m = mag[sy * w + sx];
          if (m > bestM) {
            bestM = m;
            bestO = o;
          }
        }
        if (bestM > th) {
          offs.push(bestO);
          sup++;
        }
      }
      return { off: median(offs), sup: sup / K };
    };

    const top = refine(xl, yt, xr, yt, 0, -1);
    const bottom = refine(xl, yb, xr, yb, 0, 1);
    const left = refine(xl, yt, xl, yb, -1, 0);
    const right = refine(xr, yt, xr, yb, 1, 0);

    const qx0 = Math.max(0, Math.min(w - 2, xl + left.off));
    const qx1 = Math.max(2, Math.min(w - 1, xr + right.off));
    const qy0 = Math.max(0, Math.min(h - 2, yt + top.off));
    const qy1 = Math.max(2, Math.min(h - 1, yb + bottom.off));
    if (qx1 - qx0 < w * 0.2 || qy1 - qy0 < h * 0.2) return FALLBACK;

    const quad: Quad = {
      p0: { x: qx0 / w, y: qy0 / h },
      p1: { x: qx1 / w, y: qy0 / h },
      p2: { x: qx1 / w, y: qy1 / h },
      p3: { x: qx0 / w, y: qy1 / h },
    };
    const confidence = Math.min(1, (top.sup + bottom.sup + left.sup + right.sup) / 4);
    return { quad, confidence };
  } catch {
    return FALLBACK;
  }
}

/** 归一化角点 → 像素角点数组（p0..p3 顺序） */
export function quadToPx(q: Quad, w: number, h: number): Pt[] {
  return [
    { x: q.p0.x * w, y: q.p0.y * h },
    { x: q.p1.x * w, y: q.p1.y * h },
    { x: q.p2.x * w, y: q.p2.y * h },
    { x: q.p3.x * w, y: q.p3.y * h },
  ];
}

/** 图像顺时针转 90° 后角点坐标变换：原 (x,y) → 显示 (1-y, x) */
export function rotateQuadCW(q: Quad): Quad {
  const f = (p: Pt): Pt => ({ x: 1 - p.y, y: p.x });
  return { p0: f(q.p0), p1: f(q.p1), p2: f(q.p2), p3: f(q.p3) };
}

/** 解 8 参数单应矩阵 h：dst -> src（高斯消元） */
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
    for (let r = c + 1; r < 8; r++)
      if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
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

/**
 * 透视矫正：把 src 中 quadPx（像素角点 p0..p3）围成的四边形，
 * 重采样为 outW×outH 矩形。四边形外为透明。
 */
export function warpImageData(
  sd: ImageData,
  quadPx: Pt[],
  outW: number,
  outH: number,
): HTMLCanvasElement {
  const sw = sd.width;
  const sh = sd.height;
  const H = solveH(
    [
      { x: 0, y: 0 },
      { x: outW, y: 0 },
      { x: outW, y: outH },
      { x: 0, y: outH },
    ],
    quadPx,
  );
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const octx = out.getContext('2d');
  if (!octx) return out;
  const od = octx.createImageData(outW, outH);
  const o8 = od.data;
  const d = sd.data;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const den = H[6] * x + H[7] * y + 1;
      if (Math.abs(den) < 1e-9) continue;
      const u = (H[0] * x + H[1] * y + H[2]) / den;
      const v = (H[3] * x + H[4] * y + H[5]) / den;
      if (u < 0 || v < 0 || u >= sw - 1 || v >= sh - 1) continue;
      const di = (y * outW + x) * 4;
      const x0 = u | 0;
      const y0 = v | 0;
      const fx = u - x0;
      const fy = v - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      for (let ch = 0; ch < 3; ch++) {
        const a = d[i00 + ch] + (d[i10 + ch] - d[i00 + ch]) * fx;
        const b = d[i01 + ch] + (d[i11 + ch] - d[i01 + ch]) * fx;
        o8[di + ch] = a + (b - a) * fy;
      }
      o8[di + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}
