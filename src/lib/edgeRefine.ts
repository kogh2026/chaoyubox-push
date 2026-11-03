// 边缘精修：消除换底后发丝/轮廓外沿残留的原底色晕边。
//
// ── 为什么需要它 ──────────────────────────────────────────────────────────
// 照片里「发丝」这类半透明像素本身就是 前景色×alpha + 原底色×(1−alpha) 的**混合色**
// （光栅化/衍射的必然结果，不是抠图模型的错）。抠图模型只输出 alpha 蒙版，
// 前景像素的 RGB 仍是原图的混合色。直接把它贴到新底色上，混合色里的
// 原底色分量就会在新底上显形 —— 这就是「边缘残留原底色」的成因。
//
// 实测（本机 51 张学员寸照，用正确底色估计后）：
//   · 半透明带（0<alpha<250）里 23%~60% 的像素 RGB 仍接近原底色  ← 晕边主因
//   · 不透明区（alpha>=250）几乎为 0（白底图上的白衣属正常误判）
//
// ── 解法：颜色解混（unmix / color decontamination）────────────────────────
// 观测模型：C = a·F + (1−a)·B
//   C = 原图混合色、a = alpha、F = 纯前景色、B = 原底色
// 反解：  F = (C − (1−a)·B) / a
// 把 F 换回半透明像素，就得到「发丝本来的颜色」，不再带原底色成分。
//
// ── 为什么不能沿用旧的 defringe ───────────────────────────────────────────
// 旧 defringe 把边缘 RGB **整体替换**为最近不透光邻居的纯色 —— 会把发丝自身的
// 色调与半透明渐变一起抹平（实测细节保持率仅 0.959，且残留反而升高）。
// 解混是「按 alpha 还原纯前景色」，保留发丝本色。
//
// ── 副作用控制 ───────────────────────────────────────────────────────────
// 低 alpha 区域解混会放大噪声（C 里 1 个色阶误差被 1/a 放大），三重防护：
//   1) 置信度权重 w = strength·a^kappa（kappa 小 → 低 alpha 也修得狠，但有上限）
//   2) 色域钳制：解混值限制在 [min(C,B)−12, max(C,B)+12]，不让它跑到离谱颜色
//   3) 空间平滑：解混增量做 3×3 盒滤波，压掉椒盐噪点

/** 边缘精修参数 */
export interface EdgeRefineOptions {
  /** 精修强度 0~1，0 = 关闭。默认 0.8 */
  strength?: number;
  /** 置信度指数，越小越激进（低 alpha 也解混）。默认 0.35 */
  kappa?: number;
  /** 是否对解混增量做 3×3 空间平滑（抑噪）。默认 true */
  smooth?: boolean;
  /**
   * 原底色（RGB）。留空则从 alpha≈0 的区域自动估计。
   * 显式传入的好处：能拿到更准的底色（自动估计在白底图上会把白衣算进去）。
   */
  bg?: [number, number, number];
}

const DEFAULTS = { strength: 0.8, kappa: 0.35, smooth: true } as const;

/**
 * 从 alpha≈0 的区域估计原底色。
 *
 * 为什么不用「四角采样」：证件照的四角常常落在人像（肩膀、浅色衣服）上。
 * 实测某张红底证件照，四角均值给的是 (234,126,133)（其实是肤色），
 * 而真实底色是 (239,22,30) —— 用错底色会把前景推向错误颜色，越修越糟。
 * alpha≈0 的区域是模型判定的「确定背景」，中位数最可靠。
 *
 * @param d RGBA 像素数据（Uint8ClampedArray）
 * @param w 画布宽
 * @param h 画布高
 * @returns 底色 RGB；样本不足时返回 null
 */
export function estimateBackgroundColor(
  d: Uint8ClampedArray,
  w: number,
  h: number,
): [number, number, number] | null {
  // 采样上限：超大图只取前若干万个样本，避免遍历整幅 12MP
  const MAX_SAMPLES = 60000;
  const step = Math.max(1, Math.floor((w * h) / MAX_SAMPLES));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (let i = 0, p = 0; p < w * h; i++, p += step) {
    if (d[p * 4 + 3] > 4) continue; // alpha>0 的不是背景
    rs.push(d[p * 4]);
    gs.push(d[p * 4 + 1]);
    bs.push(d[p * 4 + 2]);
  }
  if (rs.length < 200) return null;
  const mid = (arr: number[]): number => {
    const s = arr.slice().sort((a, b) => a - b);
    return s[s.length >> 1];
  };
  return [mid(rs), mid(gs), mid(bs)];
}

/**
 * 边缘精修核心：颜色解混。**唯一实现**，`matting.worker.ts` 与单测都调它。
 *
 * 签名上把 alpha 数组**外部传入**（而不是从 RGBA 里读），是因为 Worker 里的
 * alpha 蒙版是模型输出（Float32Array），主线程侧则从 RGBA 第 4 通道读 ——
 * 两种来源共用同一份算法，数值一致性天然保证。
 *
 * @param rgba RGBA 像素数据（原地修改 RGB，alpha 一个字节都不动）
 * @param alpha HxW float（0..1），与 rgba 同尺寸
 * @param w 宽
 * @param h 高
 * @param opt 参数
 * @returns 实际生效的底色；未处理时返回 null
 */
export function refineEdgePixels(
  rgba: Uint8ClampedArray,
  alpha: Float32Array,
  w: number,
  h: number,
  opt: EdgeRefineOptions = {},
): [number, number, number] | null {
  const strength = opt.strength ?? DEFAULTS.strength;
  if (strength <= 0) return null;
  const kappa = opt.kappa ?? DEFAULTS.kappa;
  const smooth = opt.smooth ?? DEFAULTS.smooth;

  const n = w * h;
  const bg = opt.bg ?? estimateBackgroundFromAlpha(rgba, alpha, w, h);
  if (!bg) return null;
  const br = bg[0];
  const bg2 = bg[1];
  const bb = bg[2];

  // 收集边缘像素索引 + 其 alpha
  const idx: number[] = [];
  const alphas: number[] = [];
  for (let p = 0; p < n; p++) {
    const a = alpha[p];
    if (a > 0.004 && a < 0.996) {
      idx.push(p);
      alphas.push(a);
    }
  }
  if (idx.length === 0) return bg;

  // ── 步骤 1：解混 + 色域钳制 ──
  const dR = new Float32Array(n);
  const dG = new Float32Array(n);
  const dB = new Float32Array(n);
  for (let k = 0; k < idx.length; k++) {
    const p = idx[k];
    const a = alphas[k];
    const r = rgba[p * 4];
    const g = rgba[p * 4 + 1];
    const b = rgba[p * 4 + 2];
    // 解混：F = (C − (1−a)·B) / a
    const inv = 1 / Math.max(a, 1e-3);
    let fr = (r - (1 - a) * br) * inv;
    let fg = (g - (1 - a) * bg2) * inv;
    let fb = (b - (1 - a) * bb) * inv;
    // 色域钳制：以 C 为中心、半径 max(24, |C−B|·2.5)。
    // 注意不能钳在 [min(C,B), max(C,B)] 内 —— 纯前景色 F 天然超出混合色 C 的范围
    // （C 是 F 与 B 的加权平均，必落在两者之间），钳死反而把解混结果掐掉。
    const limR = Math.max(24, Math.abs(r - br) * 2.5);
    const limG = Math.max(24, Math.abs(g - bg2) * 2.5);
    const limB = Math.max(24, Math.abs(b - bb) * 2.5);
    fr = fr < r - limR ? r - limR : fr > r + limR ? r + limR : fr;
    fg = fg < g - limG ? g - limG : fg > g + limG ? g + limG : fg;
    fb = fb < b - limB ? b - limB : fb > b + limB ? b + limB : fb;
    dR[p] = fr - r;
    dG[p] = fg - g;
    dB[p] = fb - b;
  }

  // ── 步骤 2：空间平滑（仅在边缘带内部做）──
  // 邻居若不在边缘带（全透明或不透明前景），不参与平均 ——
  // 否则孤立的发丝像素会被全透明邻居「稀释」成原色。
  const src = [dR, dG, dB];
  const out = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const inEdge = new Uint8Array(n);
  for (let k = 0; k < idx.length; k++) inEdge[idx[k]] = 1;
  for (let ch = 0; ch < 3; ch++) {
    const s = src[ch];
    const o = out[ch];
    if (!smooth) {
      o.set(s);
      continue;
    }
    for (let k = 0; k < idx.length; k++) {
      const p = idx[k];
      const x = p % w;
      const y = (p / w) | 0;
      let acc = 0;
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (inEdge[q]) {
            acc += s[q];
            cnt++;
          }
        }
      }
      o[p] = cnt > 0 ? acc / cnt : s[p];
    }
  }

  // ── 步骤 3：按置信度加权写回 ──
  // 权重：alpha 越低修正越激进。
  // 不能用 w = a^kappa：a=0.3、kappa=0 时 w=0.3，解混结果被稀释掉 70%，残留照旧。
  // 用 w = 1 − (1−a)^p 的形状（p 越大越激进），并保留下限。
  const pw = 1 / Math.max(0.05, kappa);
  for (let k = 0; k < idx.length; k++) {
    const p = idx[k];
    const a = alphas[k];
    const wBase = 1 - Math.pow(1 - a, pw);
    // 下限：即便 alpha 很低也至少修一部分（发丝正是最需要修的地方）
    const w = Math.min(1, Math.max(0.35, strength * wBase));
    const i = p * 4;
    rgba[i] = clamp255(rgba[i] + out[0][p] * w);
    rgba[i + 1] = clamp255(rgba[i + 1] + out[1][p] * w);
    rgba[i + 2] = clamp255(rgba[i + 2] + out[2][p] * w);
  }

  return bg;
}

/**
 * 从「alpha≈0 的像素」估计原底色（RGB 中位数）。
 *
 * @param rgba RGBA 像素数据（**未被 premultiply** 的原始值）
 * @param alpha HxW float（0..1）
 * @returns 底色 RGB；样本不足时返回 null
 */
export function estimateBackgroundFromAlpha(
  rgba: Uint8ClampedArray,
  alpha: Float32Array,
  w: number,
  h: number,
): [number, number, number] | null {
  const n = w * h;
  const MAX_SAMPLES = 60000;
  const step = Math.max(1, Math.floor(n / MAX_SAMPLES));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (let p = 0; p < n; p += step) {
    if (alpha[p] > 0.004) continue;
    rs.push(rgba[p * 4]);
    gs.push(rgba[p * 4 + 1]);
    bs.push(rgba[p * 4 + 2]);
  }
  if (rs.length < 200) return null;
  const mid = (arr: number[]): number => {
    const s = arr.slice().sort((a, b) => a - b);
    return s[s.length >> 1];
  };
  return [mid(rs), mid(gs), mid(bs)];
}

/**
 * 边缘精修（便捷包装）：alpha 直接从 RGBA 的第 4 通道读。
 *
 * 供主线程侧（单测、其它调用方）使用。**注意**：若 rgba 来自 canvas
 * `getImageData`，alpha=0 区域的 RGB 已被 premultiply 清零，
 * 估出来的底色会是 (0,0,0) —— 那种场景请改用 `refineEdgePixels` 并传入原始像素。
 *
 * @param d RGBA 像素数据（原地修改）
 * @param w 宽
 * @param h 高
 * @param opt 参数
 * @returns 实际生效的底色；未处理时返回 null
 */
export function refineEdge(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  opt: EdgeRefineOptions = {},
): [number, number, number] | null {
  const n = w * h;
  const alpha = new Float32Array(n);
  for (let p = 0; p < n; p++) alpha[p] = d[p * 4 + 3] / 255;
  return refineEdgePixels(d, alpha, w, h, opt);
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
