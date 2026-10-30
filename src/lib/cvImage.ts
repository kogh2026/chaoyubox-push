// 轻量纯 TS 图像算子（不依赖 canvas / wasm），复刻 OpenCV 中证卡检测用到的那几个算子：
// cvtColor(GRAY) / GaussianBlur / Sobel / Canny / dilate / equalizeHist。
//
// 为什么不用 opencv.js：爱印是把 opencv.js(≈9MB wasm) 塞进 worker 里跑多卡检测；
// 我们只需要「灰度 → 模糊 → 边缘 → 轮廓」这一条链，纯 TS 实现体积为 0、可单测、
// 也能在 Node 里直接跑（打包体积与冷启动都更好）。

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA，长度 width*height*4 */
  data: Uint8ClampedArray | Uint8Array;
}

export interface GrayImage {
  width: number;
  height: number;
  /** 0..255 浮点灰度（保留小数，避免多次整数取整放大误差） */
  data: Float32Array;
}

export interface MaskImage {
  width: number;
  height: number;
  /** 0 或 1 */
  data: Uint8Array;
}

/** RGBA → 灰度（BT.601 权重，与 OpenCV COLOR_RGBA2GRAY 一致） */
export function rgbaToGray(src: RgbaImage): GrayImage {
  const { width: w, height: h, data } = src;
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return { width: w, height: h, data: out };
}

/** O(n) 滑动窗口均值模糊（横竖各一遍），任意半径都只有常数级加法 */
export function boxBlur(src: GrayImage, r: number): GrayImage {
  if (r <= 0) return src;
  const { width: w, height: h, data } = src;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const win = 2 * r + 1;
  const invWin = 1 / win;
  // 横向：标量滑窗
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += data[row + (i < 0 ? 0 : i > w - 1 ? w - 1 : i)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * invWin;
      const addI = x + r + 1 < w ? x + r + 1 : w - 1;
      const subI = x - r > 0 ? x - r : 0;
      acc += data[row + addI] - data[row + subI];
    }
  }
  // 纵向：按行累加（连续内存访问，避免跨行 stride 掉 cache）
  const accRow = new Float32Array(w);
  for (let i = -r; i <= r; i++) {
    const row = (i < 0 ? 0 : i > h - 1 ? h - 1 : i) * w;
    for (let x = 0; x < w; x++) accRow[x] += tmp[row + x];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) out[row + x] = accRow[x] * invWin;
    const addRow = (y + r + 1 < h ? y + r + 1 : h - 1) * w;
    const subRow = (y - r > 0 ? y - r : 0) * w;
    for (let x = 0; x < w; x++) accRow[x] += tmp[addRow + x] - tmp[subRow + x];
  }
  return { width: w, height: h, data: out };
}

/**
 * 高斯模糊（用两次盒式模糊逼近，误差 <2%，但快 5~8 倍）。
 * ksize=5 → 半径 1 两遍（≈σ1.0），与 OpenCV GaussianBlur(5) 的平滑度相当，
 * 对 Canny 的用处只是压噪声，不需要精确的高斯核。
 */
export function gaussianBlur(src: GrayImage, ksize = 5): GrayImage {
  const r = Math.max(1, Math.round((ksize - 1) / 4));
  return boxBlur(boxBlur(src, r), r);
}

/** 4 邻域 box 下采样（先按整数倍面积平均，避免最近邻锯齿影响边缘检测） */
export function downscaleGray(src: GrayImage, longEdge: number): GrayImage {
  const { width: w, height: h, data } = src;
  const s = Math.min(1, longEdge / Math.max(w, h));
  if (s >= 1) return src;
  const ow = Math.max(8, Math.round(w * s));
  const oh = Math.max(8, Math.round(h * s));
  const out = new Float32Array(ow * oh);
  // 逆向映射 + 双线性，比逐点最近邻更平滑（Canny 更稳）
  const rx = w / ow;
  const ry = h / oh;
  for (let y = 0; y < oh; y++) {
    const sy = Math.min(h - 1, (y + 0.5) * ry - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < ow; x++) {
      const sx = Math.min(w - 1, (x + 0.5) * rx - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const a = data[y0 * w + x0] * (1 - fx) + data[y0 * w + x1] * fx;
      const b = data[y1 * w + x0] * (1 - fx) + data[y1 * w + x1] * fx;
      out[y * ow + x] = a * (1 - fy) + b * fy;
    }
  }
  return { width: ow, height: oh, data: out };
}

/** 3×3 Sobel：返回 L1 梯度幅值（与 OpenCV Canny 默认 L2gradient=false 一致）与量化方向(0..3) */
export function sobelL1(src: GrayImage): { mag: Float32Array; dir: Uint8Array } {
  const { width: w, height: h, data } = src;
  const mag = new Float32Array(w * h);
  const dir = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = data[i - w - 1];
      const tc = data[i - w];
      const tr = data[i - w + 1];
      const ml = data[i - 1];
      const mr = data[i + 1];
      const bl = data[i + w - 1];
      const bc = data[i + w];
      const br = data[i + w + 1];
      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl);
      const gy = bl + 2 * bc + br - (tl + 2 * tc + tr);
      mag[i] = Math.abs(gx) + Math.abs(gy);
      // 量化到 0/45/90/135 四个方向（NMS 用）
      const ax = Math.abs(gx);
      const ay = Math.abs(gy);
      if (ax * 0.4142 >= ay) dir[i] = 0; // 水平
      else if (ay * 0.4142 >= ax) dir[i] = 2; // 垂直
      else if (gx * gy > 0) dir[i] = 1; // 45°
      else dir[i] = 3; // 135°
    }
  }
  return { mag, dir };
}

/**
 * Canny 双阈值自动取值。
 *
 * 爱印原式用**灰度中位数**做基准（low=max(18,0.5m)，high=max(2.2low, min(255,1.2m))）。
 * 这在「卡只占画面一部分」时没问题，但用户把证件拍满全屏时，中位数直接落在卡面的白底上，
 * 阈值被抬到 280+，卡边直接丢掉 —— 表现为「满屏的卡识别不出来」。
 * 因此这里把统计量做成参数：
 *   - 原图那一遍用 p25（更接近背景/桌面亮度），满幅卡也能过；
 *   - 直方图均衡那一遍仍用中位数（均衡后中位数≈128，等价于固定中低阈值，专治低对比）。
 */
export function autoCannyThresholds(src: GrayImage, q = 0.25): { low: number; high: number } {
  const { data } = src;
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < data.length; i += 3) {
    const v = data[i] < 0 ? 0 : data[i] > 255 ? 255 : (data[i] | 0);
    hist[v]++;
    n++;
  }
  const target = Math.max(1, Math.floor(n * q));
  let acc = 0;
  let base = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) {
      base = v;
      break;
    }
  }
  const low = Math.max(18, 0.5 * base);
  const high = Math.max(low * 2.2, Math.min(255, 1.2 * base));
  return { low, high };
}

/** Canny：NMS + 双阈值 + 8 邻域滞后连接（输出 0/1 边缘掩码） */
export function canny(src: GrayImage, low: number, high: number): MaskImage {
  return cannyDetailed(src, low, high).mask;
}

/** 同 canny，但把梯度幅值一起返回（角点精修要用，避免重复算 Sobel） */
export function cannyDetailed(
  src: GrayImage,
  low: number,
  high: number,
): { mask: MaskImage; mag: Float32Array } {
  const { width: w, height: h } = src;
  const { mag, dir } = sobelL1(src);
  const thin = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m <= low) continue;
      let a: number;
      let b: number;
      const d = dir[i];
      if (d === 0) {
        a = mag[i - 1];
        b = mag[i + 1];
      } else if (d === 2) {
        a = mag[i - w];
        b = mag[i + w];
      } else if (d === 1) {
        a = mag[i - w + 1];
        b = mag[i + w - 1];
      } else {
        a = mag[i - w - 1];
        b = mag[i + w + 1];
      }
      if (m >= a && m >= b) thin[i] = m;
    }
  }
  const mask = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let i = 0; i < thin.length; i++) {
    if (thin[i] >= high) {
      mask[i] = 1;
      stack.push(i);
    }
  }
  // 滞后：从强边缘出发把相邻弱边缘拉进来（8 邻域）
  while (stack.length > 0) {
    const i = stack.pop() as number;
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        const j = ny * w + nx;
        if (mask[j] || thin[j] < low) continue;
        mask[j] = 1;
        stack.push(j);
      }
    }
  }
  return { mask: { width: w, height: h, data: mask }, mag };
}

/** 3×3 方形结构元膨胀（把断续的卡边连成一条，便于轮廓稳定）；横竖各一遍 = 可分离 */
export function dilate(src: MaskImage, iter = 1): MaskImage {
  let cur = src;
  for (let it = 0; it < iter; it++) {
    const { width: w, height: h, data } = cur;
    const tmp = new Uint8Array(w * h);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const a = data[row + (x > 0 ? x - 1 : 0)];
        const b = data[row + x];
        const c = data[row + (x + 1 < w ? x + 1 : w - 1)];
        tmp[row + x] = a | b | c;
      }
    }
    for (let y = 0; y < h; y++) {
      const prev = (y > 0 ? y - 1 : 0) * w;
      const row = y * w;
      const next = (y + 1 < h ? y + 1 : h - 1) * w;
      for (let x = 0; x < w; x++) {
        out[row + x] = tmp[prev + x] | tmp[row + x] | tmp[next + x];
      }
    }
    cur = { width: w, height: h, data: out };
  }
  return cur;
}

/** 直方图均衡（复刻爱印第二遍检测：equalize=true 专治低对比/逆光翻拍） */
export function equalizeHist(src: GrayImage): GrayImage {
  const { width: w, height: h, data } = src;
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) {
    const v = data[i] < 0 ? 0 : data[i] > 255 ? 255 : Math.round(data[i]);
    hist[v]++;
  }
  const cdf = new Uint32Array(256);
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    cdf[i] = acc;
  }
  const total = data.length;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i] < 0 ? 0 : data[i] > 255 ? 255 : Math.round(data[i]);
    out[i] = (cdf[v] / total) * 255;
  }
  return { width: w, height: h, data: out };
}

/** 取灰度直方图分位数（校验/阈值用） */
export function percentile(src: GrayImage, q: number): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < src.data.length; i++) {
    const v = src.data[i] < 0 ? 0 : src.data[i] > 255 ? 255 : Math.round(src.data[i]);
    hist[v]++;
  }
  const target = Math.max(1, Math.round(src.data.length * q));
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}
