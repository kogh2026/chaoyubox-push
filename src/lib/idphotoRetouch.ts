// 证件照「人像优化」完整管线 —— retouch-v1 规格等价实现（classic 全档 + 模型通路）
//
// 规格来源：2026-10-28 对爱印 v0.5.0 解密渲染层（export chunk）的只读静态分析。
// 本文件为**原创实现**（不含任何原项目代码），复刻的是算法规范这类事实参数：
//
//   classic 档三参数（对应原管线 smoothing / shine / underEye，量纲 0..1）：
//     smoothing  引导滤波匀肤：radius = clamp(faceW*0.025, 2, 24)
//                              eps    = (0.015 + 0.1·s)²
//                              mix    = 0.3 + 0.6·s
//                              out    = p + (guideFilter(p) − p) · mix · mask
//     shine      高光/油光抑制：局部半径 faceW*0.015、补洞半径 faceW*0.012，
//                              高光软窗 [0.03, 0.10]、暗部软窗 [0.06, 0.22]，
//                              色调回拉 0.7、饱和度回补 0.6（ratio 钳制 1..2.5）
//     underEye   黑眼圈校正：中性灰编码偏差图，offset = (map−128) · 0.4 · alpha · strength
//
//   model 档（retouch-v1, 384², half 归一化, 3 通道输出）：
//     输出不是目标色而是「以 0.5 为中性的曲线控制场」：
//       c = 0.5 + (b − 0.5) · clamp(strength·1.25, 0, 1) · blendAlpha
//       out = (1 − 2c)·a² + 2c·a        （a 为原通道归一值；c=0.5 时恒等）
//
// 与既有 `idphotoSkinRetouch.ts`（保真盒滤版）并存：本文件是补齐后的生产管线，
// 旧实现保留为可回退路径，互不影响。

import { ycbcrSkinMask } from './idphotoSkinRetouch';
import {
  boxBlur,
  clamp,
  clamp01,
  createGuidedFilter,
  maskedMedian,
  resizeChannelBilinear,
  smoothstep,
} from './imageFilters';

export interface Pt {
  x: number;
  y: number;
}

/** 特征保护区域：椭圆或（关键点）多边形；命中区域内不做匀肤/油光处理 */
export interface FeatureRegion {
  /** 语义标签，仅用于调试 */
  type?: 'eye' | 'brow' | 'mouth' | 'nose' | 'other';
  /** 椭圆中心（像素） */
  cx?: number;
  cy?: number;
  rx?: number;
  ry?: number;
  /** 多边形顶点（像素）；与椭圆二选一 */
  points?: Pt[];
  /** 多边形描边宽度（像素），用于把闭合线（如唇线）加粗 */
  strokePx?: number;
}

export interface EyeRegion {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface BlendMapLike {
  /** 3 或 4 通道，0..1（Float32）或 0..255（Uint8/Clamped） */
  data: Float32Array | Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  channels: 3 | 4;
  /** 数据量纲：'unit'（0..1，模型原样输出）或 'byte'（0..255） */
  scale?: 'unit' | 'byte';
}

export interface MaskSource {
  mask?: Float32Array;
}

export interface GuidedSmoothOptions extends MaskSource {
  /** 匀肤强度 0..1 */
  strength: number;
  /** 人脸宽度（像素），决定滤波半径；缺省取图宽 30% */
  faceWidth?: number;
  /** 覆盖半径 / eps / mix（缺省按规格映射） */
  radius?: number;
  eps?: number;
  mix?: number;
  /** 特征保护区（眼/眉/唇），自动羽化并从掩码扣除 */
  protect?: FeatureRegion[];
  /** 仅平滑亮度、保留色度（默认 false：逐通道，与原管线一致） */
  lumaOnly?: boolean;
  /** 单块最大像素数（默认 4M），超过自动分块，内存有界 */
  tilePixels?: number;
}

export interface SmoothStats {
  radius: number;
  eps: number;
  mix: number;
  /** 实际写入的像素数 */
  pixels: number;
  /** 处理块数（>1 表示走了分块路径） */
  tiles: number;
}

/** 规格映射：强度 + 人脸宽度 → 引导滤波参数 */
export function resolveSmoothParams(
  strength: number,
  faceWidth: number,
): { radius: number; eps: number; mix: number } {
  const s = clamp01(strength);
  return {
    radius: Math.round(clamp(faceWidth * 0.025, 2, 24)),
    eps: (0.015 + 0.1 * s) ** 2,
    mix: 0.3 + 0.6 * s,
  };
}

function resolveFaceWidth(faceWidth: number | undefined, w: number): number {
  return Math.max(1, faceWidth && Number.isFinite(faceWidth) ? faceWidth : w * 0.3);
}

function resolveMask(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  src: MaskSource,
  protect: FeatureRegion[] | undefined,
  faceWidth: number,
): Float32Array {
  const n = w * h;
  let mask = src.mask;
  if (!mask) {
    mask = ycbcrSkinMask(rgba, w, h);
  }
  if (mask.length !== n) {
    throw new Error(`皮肤掩码尺寸错误：${mask.length}，期望 ${n}。`);
  }
  if (!protect || protect.length === 0) return mask;
  const keep = buildFeatureProtectMask(w, h, protect, faceWidth);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = mask[i] * keep[i];
  return out;
}

// ---------------------------------------------------------------- 特征保护

function pointInPolygon(px: number, py: number, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y || 1e-6) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function distToSegment(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-9) return Math.hypot(px - a.x, py - a.y);
  let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/**
 * 特征保护掩码：1 = 允许匀肤，0 = 保护（眼白/虹膜/唇/眉）。
 * 与规格一致地做几何排除 + 羽化（羽化半径 = max(1, round(faceW*0.012)))，
 * 相比「梯度软阈值」不会被强纹理（痘印、皱纹、发丝投影）骗过，也不会把眼白抹灰。
 */
export function buildFeatureProtectMask(
  w: number,
  h: number,
  regions: FeatureRegion[],
  faceWidth: number,
): Float32Array {
  const n = w * h;
  const cover = new Float32Array(n);
  if (!regions || regions.length === 0) {
    cover.fill(0);
  } else {
    for (const r of regions) {
      if (r.points && r.points.length >= 3) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const p of r.points) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
        const stroke = Math.max(0, (r.strokePx ?? 0) / 2);
        const x0 = Math.max(0, Math.floor(minX - stroke - 1));
        const x1 = Math.min(w - 1, Math.ceil(maxX + stroke + 1));
        const y0 = Math.max(0, Math.floor(minY - stroke - 1));
        const y1 = Math.min(h - 1, Math.ceil(maxY + stroke + 1));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const px = x + 0.5;
            const py = y + 0.5;
            let hit = pointInPolygon(px, py, r.points);
            if (!hit && stroke > 0) {
              for (let i = 0, j = r.points.length - 1; i < r.points.length; j = i++) {
                if (distToSegment(px, py, r.points[j], r.points[i]) <= stroke) {
                  hit = true;
                  break;
                }
              }
            }
            if (hit) cover[y * w + x] = 1;
          }
        }
      } else if (r.cx !== undefined && r.cy !== undefined) {
        const rx = Math.max(0.5, r.rx ?? faceWidth * 0.16);
        const ry = Math.max(0.5, r.ry ?? faceWidth * 0.08);
        const x0 = Math.max(0, Math.floor(r.cx - rx - 1));
        const x1 = Math.min(w - 1, Math.ceil(r.cx + rx + 1));
        const y0 = Math.max(0, Math.floor(r.cy - ry - 1));
        const y1 = Math.min(h - 1, Math.ceil(r.cy + ry + 1));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const dx = (x + 0.5 - r.cx) / rx;
            const dy = (y + 0.5 - r.cy) / ry;
            if (dx * dx + dy * dy <= 1) cover[y * w + x] = 1;
          }
        }
      }
    }
  }
  const feather = Math.max(1, Math.round(faceWidth * 0.012));
  const soft = boxBlur(cover, w, h, feather);
  const keep = new Float32Array(n);
  for (let i = 0; i < n; i++) keep[i] = 1 - clamp01(soft[i]);
  return keep;
}

/**
 * 用 6 点人脸关键点（BlazeFace：右眼/左眼/鼻尖/嘴中心/右耳/左耳）近似出保护区。
 * 有 468 点网格时应直接传多边形，精度更高。
 */
export function featureRegionsFromKeypoints(
  kp: Pt[],
  w: number,
  h: number,
  faceWidth: number,
): FeatureRegion[] {
  if (!kp || kp.length < 4) return [];
  const fw = resolveFaceWidth(faceWidth, w);
  const px = (p: Pt) => ({ x: p.x * (p.x <= 1.0001 ? w : 1), y: p.y * (p.y <= 1.0001 ? h : 1) });
  const out: FeatureRegion[] = [];
  const rEye = px(kp[0]);
  const lEye = px(kp[1]);
  const nose = px(kp[2]);
  const mouth = px(kp[3]);
  for (const e of [rEye, lEye]) {
    out.push({ type: 'eye', cx: e.x, cy: e.y, rx: fw * 0.16, ry: fw * 0.085 });
    out.push({ type: 'brow', cx: e.x, cy: e.y - fw * 0.12, rx: fw * 0.2, ry: fw * 0.055 });
  }
  out.push({ type: 'mouth', cx: mouth.x, cy: mouth.y, rx: fw * 0.28, ry: fw * 0.13 });
  out.push({ type: 'nose', cx: nose.x, cy: nose.y, rx: fw * 0.12, ry: fw * 0.1 });
  return out;
}

// ---------------------------------------------------------------- 匀肤主内核

interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function maskBBox(mask: Float32Array, w: number, h: number): BBox | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[row + x] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/**
 * 引导滤波匀肤（classic 档核心，规格等价）。
 * 只在掩码包围盒内计算（与规格一致，避免全图空转）；超出 tilePixels 时按块切分，
 * 块间留 2·radius 内边距，保证块内结果与整图逐位一致。
 */
export function smoothSkinGuided(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  opts: GuidedSmoothOptions,
): SmoothStats {
  const s = clamp01(opts.strength);
  const n = w * h;
  if (s <= 0 || n === 0 || w < 2 || h < 2) {
    return { radius: 0, eps: 0, mix: 0, pixels: 0, tiles: 0 };
  }
  const faceWidth = resolveFaceWidth(opts.faceWidth, w);
  const spec = resolveSmoothParams(s, faceWidth);
  const radius = Math.max(1, Math.round(opts.radius ?? spec.radius));
  const eps = Math.max(1e-6, opts.eps ?? spec.eps);
  const mix = clamp01(opts.mix ?? spec.mix);
  const mask = resolveMask(rgba, w, h, opts, opts.protect, faceWidth);
  const bbox = maskBBox(mask, w, h);
  if (!bbox) return { radius, eps, mix, pixels: 0, tiles: 0 };

  // 引导滤波 = 两趟盒滤串联：a/b 依赖 2·radius，再盒滤 a/b 又外扩 radius，
  // 因此内区结果要逐位等价于整图，内边距须 ≥ 3·radius（2·radius 会在块缝留下 1~3 级差）。
  const pad = radius * 3;
  const tilePixels = Math.max(65536, opts.tilePixels ?? 4_000_000);

  // 计算分块网格（只覆盖掩码包围盒）
  const cropW = bbox.x1 - bbox.x0 + 1;
  const cropH = bbox.y1 - bbox.y0 + 1;
  const wantSplit = cropW * cropH > tilePixels;
  const side = wantSplit ? Math.max(32, Math.floor(Math.sqrt(tilePixels))) : Math.max(cropW, cropH);
  const cols = Math.max(1, Math.ceil(cropW / side));
  const rows = Math.max(1, Math.ceil(cropH / side));
  const stepX = Math.ceil(cropW / cols);
  const stepY = Math.ceil(cropH / rows);

  // 分块时后块的内边距会覆盖前块已写回的区域，必须从原始快照读，否则块缝出现数值漂移
  const src = cols * rows > 1 ? rgba.slice() : rgba;

  let pixels = 0;
  let tiles = 0;
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      // 内区（写回范围）
      const inX0 = bbox.x0 + tx * stepX;
      const inX1 = Math.min(bbox.x1, inX0 + stepX - 1);
      const inY0 = bbox.y0 + ty * stepY;
      const inY1 = Math.min(bbox.y1, inY0 + stepY - 1);
      if (inX1 < inX0 || inY1 < inY0) continue;
      // 外区（计算范围，含内边距）
      const x0 = Math.max(0, inX0 - pad);
      const x1 = Math.min(w - 1, inX1 + pad);
      const y0 = Math.max(0, inY0 - pad);
      const y1 = Math.min(h - 1, inY1 + pad);
      const tw = x1 - x0 + 1;
      const th = y1 - y0 + 1;
      if (tw < 3 || th < 3) continue;

      const tl = new Float32Array(tw * th);
      const tm = new Float32Array(tw * th);
      const tc = [new Float32Array(tw * th), new Float32Array(tw * th), new Float32Array(tw * th)];
      for (let y = 0; y < th; y++) {
        const srcRow = (y0 + y) * w + x0;
        const dstRow = y * tw;
        for (let x = 0; x < tw; x++) {
          const si = srcRow + x;
          const di = dstRow + x;
          tm[di] = clamp01(mask[si]);
          const p = si * 4;
          const r0 = src[p] / 255;
          const g0 = src[p + 1] / 255;
          const b0 = src[p + 2] / 255;
          tc[0][di] = r0;
          tc[1][di] = g0;
          tc[2][di] = b0;
          tl[di] = 0.299 * r0 + 0.587 * g0 + 0.114 * b0;
        }
      }

      // 掩码一致性：局部皮肤占比低（发丝/轮廓边界）时衰减混合权重，消除水渍与光晕
      const localMask = boxBlur(tm, tw, th, radius);
      const taper = new Float32Array(tw * th);
      for (let i = 0; i < tw * th; i++) taper[i] = smoothstep(0.2, 0.6, localMask[i]);

      const gf = createGuidedFilter(tl, tw, th, radius, eps);
      // 逐通道引导滤波（与原管线一致）；lumaOnly 时仅滤波亮度、把增量均摊到三通道，
      // 等价于保留色度，避免高饱和皮肤（腮红/阴影）被染色。
      let q: Float32Array[];
      if (opts.lumaOnly) {
        const ql = gf.apply(tl);
        q = [new Float32Array(tw * th), new Float32Array(tw * th), new Float32Array(tw * th)];
        for (let i = 0; i < tw * th; i++) {
          const d = ql[i] - tl[i];
          q[0][i] = tc[0][i] + d;
          q[1][i] = tc[1][i] + d;
          q[2][i] = tc[2][i] + d;
        }
      } else {
        q = [gf.apply(tc[0]), gf.apply(tc[1]), gf.apply(tc[2])];
      }

      for (let y = inY0; y <= inY1; y++) {
        const ty2 = y - y0;
        for (let x = inX0; x <= inX1; x++) {
          const si = y * w + x;
          const ti0 = ty2 * tw + (x - x0);
          const wgt = tm[ti0] * taper[ti0] * mix;
          if (wgt <= 0) continue;
          const p = si * 4;
          const a = rgba[p + 3];
          if (a === 0) continue;
          const ww = wgt * (a / 255);
          if (ww <= 0) continue;
          const ti = ty2 * tw + (x - x0);
          const rr = tc[0][ti] + (q[0][ti] - tc[0][ti]) * ww;
          const gg = tc[1][ti] + (q[1][ti] - tc[1][ti]) * ww;
          const bb = tc[2][ti] + (q[2][ti] - tc[2][ti]) * ww;
          rgba[p] = Math.round(clamp01(rr) * 255);
          rgba[p + 1] = Math.round(clamp01(gg) * 255);
          rgba[p + 2] = Math.round(clamp01(bb) * 255);
          pixels++;
        }
      }
      tiles++;
    }
  }
  return { radius, eps, mix, pixels, tiles };
}

// ---------------------------------------------------------------- 油光抑制

export interface ShineOptions extends MaskSource {
  strength: number;
  faceWidth?: number;
  protect?: FeatureRegion[];
  /**
   * 色调锚点：
   *  - 'local'（默认）：只削减「高于邻近干净皮肤」的局部超额 → 高调脸不会被压灰；
   *  - 'global'：按全脸掩码中位数回拉 70%（原规格行为，供逐位对照）。
   */
  toneAnchor?: 'local' | 'global';
}

/**
 * 高光/油光抑制：把「比邻近皮肤显著更亮」的镜面高光用周围非高光皮肤补洞，
 * 再做色调回拉与饱和度回补（否则额头会发灰、失去血色）。
 * 返回被改动的像素数。
 */
export function reduceShine(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  opts: ShineOptions,
): number {
  const s = clamp01(opts.strength);
  const n = w * h;
  if (s <= 0 || n === 0 || w < 3 || h < 3) return 0;
  const faceWidth = resolveFaceWidth(opts.faceWidth, w);
  // 参照半径须明显大于局部半径：大片镜面高光在自身尺度上看不出「亮」，
  // 用小半径会把最该处理的大高光判为正常（原管线此处会退化成 0 支撑，属边界 bug）。
  const rRef = Math.max(8, Math.round(faceWidth * 0.045));
  const rSmooth = Math.max(1, Math.round(faceWidth * 0.012));
  const mask = resolveMask(rgba, w, h, opts, opts.protect, faceWidth);

  const luma = new Float32Array(n);
  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p] / 255;
    const g = rgba[p + 1] / 255;
    const b = rgba[p + 2] / 255;
    luma[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    ch[0][i] = r;
    ch[1][i] = g;
    ch[2][i] = b;
  }

  // 1) 高光度量：亮度超出局部均值越多越像油光（软窗 0.03..0.10）
  const meanLocal = boxBlur(luma, w, h, rRef);
  const hi = new Float32Array(n);
  for (let i = 0; i < n; i++) hi[i] = smoothstep(0.03, 0.1, luma[i] - meanLocal[i]);

  // 2) 非高光皮肤权重：补洞时只用「干净皮肤」做参照
  const clean = new Float32Array(n);
  for (let i = 0; i < n; i++) clean[i] = mask[i] * (1 - hi[i]);

  // 最小支撑度：干净皮肤占比太低时比值会被单个像素放大（伪高光/边界），直接退回局部均值
  const MIN_SUPPORT = 0.05;
  const lumaClean = new Float32Array(n);
  for (let i = 0; i < n; i++) lumaClean[i] = luma[i] * clean[i];

  // 多尺度参照：大片镜面高光在其自身尺度内看不到「干净皮肤」，
  // 逐级放大半径直到有足够支撑（最多 3 级，覆盖约 64× 面积）。
  const ref = new Float32Array(n);
  const resolved = new Uint8Array(n);
  for (let level = 0; level < 3; level++) {
    const r = Math.max(3, Math.round(rRef * 4 ** level));
    const den = boxBlur(clean, w, h, r);
    const num = boxBlur(lumaClean, w, h, r);
    for (let i = 0; i < n; i++) {
      if (resolved[i]) continue;
      if (den[i] > MIN_SUPPORT) {
        ref[i] = num[i] / den[i];
        resolved[i] = 1;
      }
    }
  }
  {
    const wide = boxBlur(luma, w, h, Math.max(3, Math.round(rRef * 16)));
    for (let i = 0; i < n; i++) if (!resolved[i]) ref[i] = wide[i];
  }

  // 3) 高光补洞权重：相对局部超额 × 绝对亮度门（只有真正亮的镜面高光才算油光）
  //    绝对门 smoothstep(0.62, 0.9) 可显著减少把「正常受光皮肤」误判为油光。
  const wHl = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const rel = smoothstep(0.03, 0.1, luma[i] - ref[i]);
    const abs = smoothstep(0.62, 0.9, luma[i]);
    // 注：不按「干净皮肤支撑度」硬性门控——大片镜面高光邻域内本就没有干净皮肤，
    // 硬门会让最该处理的大高光被整体跳过；分母的 MIN_SUPPORT 已足够防止比值放大。
    wHl[i] = rel * abs * mask[i] * mask[i] * s;
  }

  // 4) 用非高光邻居均值替换高光像素（逐通道，补洞半径更大以免出现斑块）
  const denSmooth = boxBlur(clean, w, h, rSmooth);
  const numC = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 3; c++) {
    const tmp = new Float32Array(n);
    for (let i = 0; i < n; i++) tmp[i] = ch[c][i] * clean[i];
    const m = boxBlur(tmp, w, h, rSmooth);
    for (let i = 0; i < n; i++) numC[c][i] = denSmooth[i] > MIN_SUPPORT ? m[i] / denSmooth[i] : ch[c][i];
  }
  const MAX_SHIFT = 0.45; // 单点补洞幅度上限（≈115 级），防掩码误判把高光涂成色块
  for (let c = 0; c < 3; c++) {
    const src = ch[c];
    const sm = numC[c];
    for (let i = 0; i < n; i++) {
      const d = clamp(sm[i] - src[i], -MAX_SHIFT, MAX_SHIFT);
      src[i] += d * wHl[i];
    }
  }

  // 5) 重算亮度/色域（★ 补洞后必须重算，否则色调回拉会按旧亮度二次压暗）
  for (let i = 0; i < n; i++) {
    luma[i] = 0.299 * ch[0][i] + 0.587 * ch[1][i] + 0.114 * ch[2][i];
  }
  const mid = maskedMedian(luma, mask);
  const range = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const mx = Math.max(ch[0][i], ch[1][i], ch[2][i]);
    const mn = Math.min(ch[0][i], ch[1][i], ch[2][i]);
    range[i] = mx - mn;
  }
  const satBase = Math.max(0.001, maskedMedian(range, mask));

  const gate = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const toneUp = smoothstep(0.06, 0.22, luma[i] - mid);
    const desat = smoothstep(0.2, 0.8, 1 - Math.min(1, range[i] / satBase));
    gate[i] = toneUp * (0.5 + 0.5 * desat) * mask[i] * mask[i] * s;
  }
  const gateS = boxBlur(gate, w, h, rSmooth);

  const anchor = opts.toneAnchor ?? 'local';
  let count = 0;
  for (let i = 0; i < n; i++) {
    // ★ 色调压缩只作用于「确实是高光」的像素（再乘高光权重），
    //   否则会把「本来就亮但哑光」的皮肤也往全局中位数压，高调脸会发灰。
    const hl = wHl[i];
    const k = gateS[i] * hl;
    if (k <= 0.001 && hl <= 0.001) continue;
    const p = i * 4;
    if (rgba[p + 3] === 0) continue;
    const a0 = luma[i];
    let l2: number;
    if (anchor === 'global') {
      const pulled = mid + (a0 - mid) * 0.3; // 与规格一致：向中位数回拉 70%
      l2 = a0 + (pulled - a0) * k;
    } else {
      // 局部超额：仅削掉超出邻近干净皮肤的那部分，哑光皮肤（a0 ≤ ref）完全不动。
      // 单像素压暗量封顶 0.35（≈89 级）：掩码偶发误判（暖色背景/发丝被判成皮肤）时不出现色块。
      const excess = Math.max(0, a0 - ref[i]);
      l2 = a0 - Math.min(excess * 0.7 * k, 0.35);
    }
    const satRatio = clamp(satBase / Math.max(0.001, range[i]), 1, 2.5);
    const gain = 1 + (satRatio - 1) * 0.6 * k;
    for (let c = 0; c < 3; c++) {
      const v = l2 + (ch[c][i] - a0) * gain;
      rgba[p + c] = Math.round(clamp01(v) * 255);
    }
    count++;
  }
  return count;
}

// ---------------------------------------------------------------- 眼下校正

/**
 * 生成黑眼圈校正图（中性灰 128 编码偏差）。
 * 参照色 = 眼周环形区域的肤色中位数；区域内地亮度低于参照 → 正向提亮，
 * 偏差按最大 ±51（对应 strength=1 时的满量程 0.4·255）截断，边缘按椭圆径向羽化。
 * 返回 Float32Array（0..255 灰度，128 为中性）或 null（无有效区域）。
 */
export function buildUnderEyeMap(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  regions: EyeRegion[],
  opts: { biasScale?: number; feather?: number } = {},
): Float32Array | null {
  if (!regions || regions.length === 0) return null;
  const n = w * h;
  const map = new Float32Array(n).fill(128);
  const biasScale = opts.biasScale ?? 1.6;
  const maxBias = 51;
  let made = false;

  for (const r of regions) {
    const rx = Math.max(1, r.rx);
    const ry = Math.max(1, r.ry);
    const x0 = Math.max(0, Math.floor(r.cx - rx * 2.4));
    const x1 = Math.min(w - 1, Math.ceil(r.cx + rx * 2.4));
    const y0 = Math.max(0, Math.floor(r.cy - ry * 2.4));
    const y1 = Math.min(h - 1, Math.ceil(r.cy + ry * 2.4));
    if (x1 < x0 || y1 < y0) continue;

    // 参照色：椭圆外环（1.5..2.3 倍）里的肤色中位数
    const refL: number[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5 - r.cx) / rx;
        const dy = (y + 0.5 - r.cy) / ry;
        const d2 = dx * dx + dy * dy;
        if (d2 < 2.25 || d2 > 5.29) continue;
        const p = (y * w + x) * 4;
        if (rgba[p + 3] < 200) continue;
        refL.push((0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) / 255);
      }
    }
    if (refL.length < 16) continue;
    refL.sort((a, b) => a - b);
    const ref = refL[Math.floor(refL.length / 2)];

    let touched = false;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5 - r.cx) / rx;
        const dy = (y + 0.5 - r.cy) / ry;
        const d2 = dx * dx + dy * dy;
        if (d2 > 1) continue;
        const p = (y * w + x) * 4;
        if (rgba[p + 3] < 200) continue;
        const l = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) / 255;
        const deficit = ref - l;
        if (deficit <= 0.004) continue;
        // 径向羽化：中心满额，边缘归零
        const fall = 1 - Math.sqrt(d2);
        const bias = clamp(deficit * 255 * biasScale * fall, 0, maxBias);
        if (bias <= 0.5) continue;
        const idx = y * w + x;
        map[idx] = Math.min(179, map[idx] + bias);
        touched = true;
      }
    }
    if (touched) made = true;
  }
  return made ? map : null;
}

/** 应用黑眼圈图：offset = (map−128) · 0.4 · alpha · strength（规格同式） */
export function applyUnderEyeMap(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  map: Float32Array | Uint8ClampedArray,
  strength: number,
  mapW?: number,
  mapH?: number,
): number {
  const s = clamp01(strength);
  if (s <= 0) return 0;
  const n = w * h;
  if (map.length !== n) {
    if (!mapW || !mapH || mapW * mapH !== map.length) {
      throw new Error(`黑眼圈蒙版与照片尺寸不一致：${map.length}，期望 ${n}。`);
    }
  }
  const scale = 0.4 * s;
  let count = 0;
  const mw = mapW ?? w;
  const mh = mapH ?? h;
  for (let y = 0; y < h; y++) {
    const my = mh === h ? y : Math.min(mh - 1, Math.floor((y * mh) / h));
    for (let x = 0; x < w; x++) {
      const mx = mw === w ? x : Math.min(mw - 1, Math.floor((x * mw) / w));
      const i = y * w + x;
      const p = i * 4;
      const alpha = rgba[p + 3];
      if (alpha === 0) continue;
      const m = map[my * mw + mx];
      const delta = m - 128;
      if (delta === 0) continue;
      const off = delta * scale * (alpha / 255);
      rgba[p] = Math.round(clamp(rgba[p] + off, 0, 255));
      rgba[p + 1] = Math.round(clamp(rgba[p + 1] + off, 0, 255));
      rgba[p + 2] = Math.round(clamp(rgba[p + 2] + off, 0, 255));
      count++;
    }
  }
  return count;
}

/** 用 6 点关键点近似眼下区域（眼点下方、宽度按脸宽） */
export function eyeRegionsFromKeypoints(kp: Pt[], w: number, h: number, faceWidth: number): EyeRegion[] {
  if (!kp || kp.length < 2) return [];
  const fw = resolveFaceWidth(faceWidth, w);
  return [kp[0], kp[1]].map((p) => ({
    cx: p.x * (p.x <= 1.0001 ? w : 1),
    cy: p.y * (p.y <= 1.0001 ? h : 1) + fw * 0.085,
    rx: fw * 0.17,
    ry: fw * 0.075,
  }));
}

// ---------------------------------------------------------------- 模型通路

/**
 * 应用 retouch-v1 的 3 通道曲线控制场（规格同式）。
 * 输出语义：通道值是「以 0.5 为中性的曲线参数」，c = 0.5 恒等、c<0.5 压暗中间调、
 * c>0.5 提亮；alpha 通道为该像素的混合权重（无 alpha 视为 1）。
 */
export function applyRetouchBlendMap(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  blend: BlendMapLike,
  strength: number,
): number {
  const s = clamp01(strength * 1.25);
  if (s <= 0 || blend.width <= 0 || blend.height <= 0) return 0;
  const toUnit = blend.scale === 'byte' ? 1 / 255 : 1;
  const chans: Float32Array[] = [];
  for (let c = 0; c < 3; c++) {
    const flat = new Float32Array(blend.width * blend.height);
    for (let i = 0; i < flat.length; i++) flat[i] = blend.data[i * blend.channels + c] * toUnit;
    chans.push(resizeChannelBilinear(flat, blend.width, blend.height, w, h));
  }
  let weight: Float32Array | null = null;
  if (blend.channels === 4) {
    const flat = new Float32Array(blend.width * blend.height);
    for (let i = 0; i < flat.length; i++) flat[i] = blend.data[i * 4 + 3] * toUnit;
    weight = resizeChannelBilinear(flat, blend.width, blend.height, w, h);
  }
  let count = 0;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const a = rgba[p + 3];
    if (a === 0) continue;
    const bw = weight ? clamp01(weight[i]) : 1;
    const k = s * bw;
    if (k <= 0) continue;
    for (let c = 0; c < 3; c++) {
      const av = rgba[p + c] / 255;
      const cc = (clamp01(chans[c][i]) - 0.5) * k + 0.5;
      const out = (1 - 2 * cc) * av * av + 2 * cc * av;
      rgba[p + c] = Math.round(clamp01(out) * 255);
    }
    count++;
  }
  return count;
}

// ---------------------------------------------------------------- 总编排

export interface PortraitRetouchOptions extends MaskSource {
  /** 匀肤 0..1 */
  smoothing?: number;
  /** 油光抑制 0..1 */
  shine?: number;
  /** 黑眼圈校正 0..1 */
  underEye?: number;
  /** 人脸宽度（像素） */
  faceWidth?: number;
  /** 特征保护区 */
  protect?: FeatureRegion[];
  /** 眼下区域（不传则跳过 underEye） */
  eyeRegions?: EyeRegion[];
  /** 外部黑眼圈图（优先于 eyeRegions 现算） */
  underEyeMap?: Float32Array;
  /** 模型通路：retouch-v1 输出场 */
  blendMap?: BlendMapLike;
  /** 引擎选择：classic（仅经典）/ model（仅模型）/ both（默认，模型后再经典） */
  engine?: 'classic' | 'model' | 'both';
  /** 仅平滑亮度、保留色度 */
  lumaOnly?: boolean;
  /** 油光色调锚点（默认 local，见 ShineOptions） */
  toneAnchor?: 'local' | 'global';
  tilePixels?: number;
}

export interface PortraitRetouchStats {
  engine: 'classic' | 'model' | 'both';
  smoothedPixels: number;
  shinePixels: number;
  underEyePixels: number;
  blendPixels: number;
  smooth: SmoothStats;
}

/**
 * 人像优化总入口（顺序与规格一致：眼下 → 油光 → 模型 blend → 经典匀肤）。
 * 全部参数为 0 时零开销直接返回（不分配、不改像素）。
 */
export function retouchPortrait(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  opts: PortraitRetouchOptions,
): PortraitRetouchStats {
  const smoothing = clamp01(opts.smoothing ?? 0);
  const shine = clamp01(opts.shine ?? 0);
  const underEye = clamp01(opts.underEye ?? 0);
  const engine = opts.engine ?? 'both';
  const empty: SmoothStats = { radius: 0, eps: 0, mix: 0, pixels: 0, tiles: 0 };
  const stats: PortraitRetouchStats = {
    engine,
    smoothedPixels: 0,
    shinePixels: 0,
    underEyePixels: 0,
    blendPixels: 0,
    smooth: empty,
  };
  if (smoothing <= 0 && shine <= 0 && underEye <= 0) return stats;
  if (w < 2 || h < 2) return stats;

  const faceWidth = resolveFaceWidth(opts.faceWidth, w);

  if (underEye > 0) {
    let map = opts.underEyeMap ?? null;
    if (!map && opts.eyeRegions && opts.eyeRegions.length > 0) {
      map = buildUnderEyeMap(rgba, w, h, opts.eyeRegions);
    }
    if (map) {
      stats.underEyePixels = applyUnderEyeMap(rgba, w, h, map, underEye);
    }
  }

  if (shine > 0) {
    stats.shinePixels = reduceShine(rgba, w, h, {
      strength: shine,
      faceWidth,
      mask: opts.mask,
      protect: opts.protect,
      toneAnchor: opts.toneAnchor,
    });
  }

  if (smoothing <= 0) return stats;

  if (engine !== 'classic' && opts.blendMap) {
    stats.blendPixels = applyRetouchBlendMap(rgba, w, h, opts.blendMap, smoothing);
  }

  if (engine !== 'model') {
    const r = smoothSkinGuided(rgba, w, h, {
      strength: smoothing,
      faceWidth,
      mask: opts.mask,
      protect: opts.protect,
      lumaOnly: opts.lumaOnly,
      tilePixels: opts.tilePixels,
    });
    stats.smooth = r;
    stats.smoothedPixels = r.pixels;
  }
  return stats;
}
