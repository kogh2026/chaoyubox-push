// 证件照换底：本地 ML 抠图（@imgly/background-removal，底层 onnxruntime-web + ISNet）
// 桌面端优先用安装包内预装模型（appres:// 本地协议，完全离线）；
// 浏览器预览环境回退官方 CDN（首次下载后由 IndexedDB 缓存）。
import { removeBackground, type Config } from '@imgly/background-removal';

/**
 * 预装模型的资源根：桌面端由主进程的 appres:// 协议提供（resources/matting-model/）。
 * 浏览器环境返回 undefined，交给 @imgly 走默认 CDN；Worker 里没有 window，由池传入。
 */
export function mattingPublicPath(): string | undefined {
  const base =
    typeof window !== 'undefined'
      ? (window as unknown as { electronAPI?: { appResBase?: string } }).electronAPI?.appResBase
      : undefined;
  return typeof base === 'string' && base ? `${base}matting-model/` : undefined;
}

/** ort wasm 目录（appres://res/ort/），MODNet 引擎在 Worker 里设置 wasmPaths 用 */
export function mattingOrtPath(): string | undefined {
  const base =
    typeof window !== 'undefined'
      ? (window as unknown as { electronAPI?: { appResBase?: string } }).electronAPI?.appResBase
      : undefined;
  return typeof base === 'string' && base ? `${base}ort/` : undefined;
}

/** MODNet 模型 URL（appres://res/matting-model/modnet/modnet.onnx），桌面端预装 */
export function modnetModelUrl(): string | undefined {
  const p = mattingPublicPath();
  return p ? `${p}modnet/modnet.onnx` : undefined;
}


export type BgColor = 'red' | 'blue' | 'white';

export const BG_COLORS: { id: BgColor; name: string; hex: string }[] = [
  { id: 'red', name: '红底', hex: '#FF0000' },
  { id: 'blue', name: '蓝底', hex: '#438EDB' },
  { id: 'white', name: '白底', hex: '#FFFFFF' },
];

export const BG_HEX: Record<BgColor, string> = {
  red: '#FF0000',
  blue: '#438EDB',
  white: '#FFFFFF',
};

// 原版"背景与抠图"色板：纯色 + 渐变 + 自定义
export interface BgOption {
  id: string;
  name: string;
  hex: string;          // 纯色值（渐变取主色，用于命名/展示）
  gradient?: [string, string];
}

export const BG_OPTIONS: BgOption[] = [
  { id: 'white', name: '白底', hex: '#FFFFFF' },
  { id: 'red', name: '红底', hex: '#FF0000' },
  { id: 'blue', name: '蓝底', hex: '#438EDB' },
  { id: 'grad-red', name: '渐变红', hex: '#E33', gradient: ['#ff9a9a', '#e02f2f'] },
  { id: 'grad-blue', name: '渐变蓝', hex: '#39C', gradient: ['#9ecbff', '#2f6fed'] },
  { id: 'grad-rb', name: '渐变红蓝', hex: '#824', gradient: ['#e02f2f', '#2f6fed'] },
  { id: 'custom', name: '自定义', hex: '#FFFFFF' },
];

export interface RetouchOpts {
  bg?: BgOption;          // 背景（纯色或渐变）
  whiten?: number;        // 0~0.5 美白强度（仅作用于人像区域）
  warm?: number;          // 0~0.3 红润（提肤色）
  brightness?: number;    // -50~50 亮度（仅作用于人像区域）
  edgeThreshold?: number; // 0~50 抠图阈值：越大边缘越干净、碎发越少
  defringe?: number;      // 0~1 去晕边强度：把边缘半透明像素的 RGB 中和为前景色，去掉彩色底外沿色晕
  beauty?: number;        // 0~1 保真美颜强度：皮肤自适应表面模糊（抹毛孔/瑕疵），高细节(眉眼唇/轮廓)不动，保真不变形
  mono?: boolean;         // 黑白照片：整图（含背景）转灰度
}

// ---- P1：去晕边（defringe）----
// 透明底 RGBA 里，边缘半透明像素(0<alpha<250)的 RGB 仍混着被抠掉的原背景色，
// 换到彩色底后会在发丝/轮廓外沿形成一圈"晕边"。defringe 把这些像素的 RGB
// 中和成最近不透光像素(前景)的颜色，去掉色晕。只处理边缘像素，代价很小。
function defringe(d: Uint8ClampedArray, w: number, h: number, strength: number): void {
  if (strength <= 0) return;
  const OPAQUE = 250;
  const n = w * h;
  const fgR = new Int32Array(n);
  const fgG = new Int32Array(n);
  const fgB = new Int32Array(n);
  fgR.fill(-1); fgG.fill(-1); fgB.fill(-1);
  const edge: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3];
    if (a >= OPAQUE) {
      fgR[i] = d[i * 4]; fgG[i] = d[i * 4 + 1]; fgB[i] = d[i * 4 + 2];
    } else if (a > 0) {
      edge.push(i);
    }
  }
  if (edge.length === 0) return;
  // 迭代近邻传播：不透光像素作种子，逐轮把前景色向外扩散进边缘带（取已赋值 8 邻域均值）
  const RADIUS = 5;
  for (let it = 0; it < RADIUS; it++) {
    let changed = 0;
    for (let k = 0; k < edge.length; k++) {
      const p = edge[k];
      if (fgR[p] >= 0) continue;
      const x = p % w, y = (p / w) | 0;
      let sr = 0, sg = 0, sb = 0, cnt = 0;
      for (let yy = -1; yy <= 1; yy++) {
        const ny = y + yy;
        if (ny < 0 || ny >= h) continue;
        for (let xx = -1; xx <= 1; xx++) {
          const nx = x + xx;
          if (nx < 0 || nx >= w) continue;
          if (xx === 0 && yy === 0) continue;
          const q = ny * w + nx;
          if (fgR[q] >= 0) { sr += fgR[q]; sg += fgG[q]; sb += fgB[q]; cnt++; }
        }
      }
      if (cnt > 0) {
        fgR[p] = (sr / cnt) | 0; fgG[p] = (sg / cnt) | 0; fgB[p] = (sb / cnt) | 0;
        changed++;
      }
    }
    if (changed === 0) break;
  }
  const s = Math.min(1, Math.max(0, strength));
  for (let k = 0; k < edge.length; k++) {
    const p = edge[k];
    if (fgR[p] < 0) continue;
    const idx = p * 4;
    d[idx] = Math.round(d[idx] + (fgR[p] - d[idx]) * s);
    d[idx + 1] = Math.round(d[idx + 1] + (fgG[p] - d[idx + 1]) * s);
    d[idx + 2] = Math.round(d[idx + 2] + (fgB[p] - d[idx + 2]) * s);
  }
}

// ---- P1：保真美颜（保真不变形）----
// 频域分离软阈值降噪：先用盒式模糊(R=2)得到低频"平滑层"，再对"细节层"(原图-平滑层)
// 做幅值软阈值衰减 —— 小幅细节(毛孔/颗粒噪点)按强度抹平，大幅细节(眉眼/唇/发丝/强边缘)
// 完整保留 → 抹瑕疵不糊五官，脸型/结构不变。
// 仅在肤色像素上生效(避免磨到衣服/头发/背景)。强度 0..1；默认关，避免拖慢批量。
function beautify(d: Uint8ClampedArray, w: number, h: number, strength: number): void {
  if (strength <= 0) return;
  const n = w * h;
  const s = Math.min(1, Math.max(0, strength));
  const R = 2; // 模糊半径
  const opq = new Uint8Array(n); // 不透光标记
  for (let i = 0; i < n; i++) opq[i] = d[i * 4 + 3] > 0 ? 1 : 0;
  // 平滑层：分离式盒式模糊(半径 R)，仅统计不透光像素
  const sm = new Float32Array(n * 3);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let rr = 0, gg = 0, bb = 0, cnt = 0;
      for (let k = -R; k <= R; k++) {
        const nx = x + k;
        if (nx < 0 || nx >= w) continue;
        const i = row + nx;
        if (!opq[i]) continue;
        const j = i * 4;
        rr += d[j]; gg += d[j + 1]; bb += d[j + 2]; cnt++;
      }
      if (cnt > 0) {
        const o = (row + x) * 3;
        sm[o] = rr / cnt; sm[o + 1] = gg / cnt; sm[o + 2] = bb / cnt;
      }
    }
  }
  const sm2 = new Float32Array(n * 3);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let rr = 0, gg = 0, bb = 0, cnt = 0;
      for (let k = -R; k <= R; k++) {
        const ny = y + k;
        if (ny < 0 || ny >= h) continue;
        const i = ny * w + x;
        if (!opq[i]) continue;
        const o = i * 3;
        rr += sm[o]; gg += sm[o + 1]; bb += sm[o + 2]; cnt++;
      }
      if (cnt > 0) {
        const o2 = (y * w + x) * 3;
        sm2[o2] = rr / cnt; sm2[o2 + 1] = gg / cnt; sm2[o2 + 2] = bb / cnt;
      }
    }
  }
  // 幅值软阈值：< T 全平滑，> T2 全保留，中间线性过渡
  const T = 8, T2 = 42;
  const inv = 1 / (T2 - T);
  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    const a = d[idx + 3];
    if (a === 0) continue;
    const r = d[idx], g = d[idx + 1], b = d[idx + 2];
    const o = i * 3;
    const sr2 = sm2[o], sg2 = sm2[o + 1], sb2 = sm2[o + 2];
    if (sr2 === 0 && sg2 === 0 && sb2 === 0) continue;
    const Y = 0.299 * r + 0.587 * g + 0.114 * b;
    const Cb = -0.169 * r - 0.331 * g + 0.5 * b + 128;
    const Cr = 0.5 * r - 0.419 * g - 0.081 * b + 128;
    const isSkin = Cb >= 77 && Cb <= 127 && Cr >= 133 && Cr <= 173 && Y > 60;
    if (!isSkin) continue;
    // 三通道细节幅值取最大者决定保留比例
    const dr = r - sr2, dg = g - sg2, db = b - sb2;
    const mag = Math.abs(dr) > Math.abs(dg) ? Math.abs(dr) : Math.abs(dg);
    const magMax = mag > Math.abs(db) ? mag : Math.abs(db);
    let keep: number;
    if (magMax <= T) keep = 1 - s;          // 毛孔/细噪：全抹
    else if (magMax >= T2) keep = 1;        // 眉眼/唇/强边缘：全保留
    else keep = 1 - s * (1 - (magMax - T) * inv); // 过渡
    d[idx] = Math.max(0, Math.min(255, Math.round(sr2 + dr * keep)));
    d[idx + 1] = Math.max(0, Math.min(255, Math.round(sg2 + dg * keep)));
    d[idx + 2] = Math.max(0, Math.min(255, Math.round(sb2 + db * keep)));
  }
}

// 像素级人像调整：只处理 alpha>0 的像素（人物），背景不受影响
// 顺序：去晕边 → 保真美颜 → 抠图阈值 → 美白/暖肤/亮度
function adjustPerson(
  canvas: HTMLCanvasElement,
  o: { whiten: number; warm: number; brightness: number; edgeThreshold: number; defringe: number; beauty: number },
): void {
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  if (o.defringe > 0) defringe(d, canvas.width, canvas.height, o.defringe);
  if (o.beauty > 0) beautify(d, canvas.width, canvas.height, o.beauty);
  const th = o.edgeThreshold * 2.55; // 0..127.5
  for (let i = 0; i < d.length; i += 4) {
    let a = d[i + 3];
    if (a === 0) continue;
    // 抠图阈值：alpha 低于阈值压到 0，其余重新拉满对比（边缘更实、碎发收掉）
    if (th > 0) {
      a = Math.max(0, Math.min(255, ((a - th) / (255 - th)) * 255));
      d[i + 3] = a;
      if (a === 0) continue;
    }
    const w = o.whiten;
    const warm = o.warm;
    const br = o.brightness;
    if (w === 0 && warm === 0 && br === 0) continue;
    for (let c = 0; c < 3; c++) {
      let v = d[i + c] + br;
      if (w > 0) v = v + (255 - v) * w * 0.9; // 提亮逼近纯白
      if (warm > 0 && c === 0) v = v + (255 - v) * warm * 0.35; // R 通道略抬
      d[i + c] = Math.max(0, Math.min(255, v));
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** 取景参数：dx/dy 为目标像素偏移；zoom 相对 cover 基准放大（≥1）；rotation 为人物层旋转角（度） */
export type Placement = { dx: number; dy: number; zoom?: number; rotation?: number };

/**
 * 人物层：已缩放到「目标画布尺寸」并完成像素级调整的前景。
 *
 * 为什么要有这一层：像素级调整（去晕边/抠图阈值/美白/美颜）是纯 CPU 逐像素运算，
 * 旧实现跑在**原图分辨率**上（12MP 手机照 → 每张 1200 万次循环 + 上百 MB 临时数组），
 * 而输出只有 1 寸 295×413。改成「先缩放、再调整」后，同样的算法只跑 12 万像素
 * （≈1/100 的像素量），且人物层可缓存复用 —— 换底色/换排版时无需重做像素运算。
 */
export interface PersonLayer {
  /** 人物层画布（尺寸≈目标画布，含旋转外接矩形） */
  canvas: HTMLCanvasElement;
  /** 在目标画布上的绘制宽高 */
  dw: number;
  dh: number;
  /** 左上角偏移（仅 cover 取景时可能为负；contain 时为居中值） */
  ox: number;
  oy: number;
  /** 目标画布尺寸 */
  w: number;
  h: number;
  /** 参数指纹（像素调整 + 规格 + 取景），用于复用缓存 */
  key: string;
}

/** 影响「人物层像素内容」的参数指纹；底色/黑白不在其中（它们只在合层时生效） */
export function personLayerKey(
  opt: RetouchOpts,
  pxW: number,
  pxH: number,
  placement?: Placement,
): string {
  const n = (v?: number) => (v == null ? '' : Number(v).toFixed(3));
  return [
    Math.round(pxW),
    Math.round(pxH),
    n(opt.whiten),
    n(opt.warm),
    n(opt.brightness),
    n(opt.edgeThreshold),
    n(opt.defringe),
    n(opt.beauty),
    n(placement?.dx),
    n(placement?.dy),
    n(placement?.zoom),
    n(placement?.rotation),
  ].join('|');
}

function loadBlobImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('抠图结果加载失败'));
    };
    img.src = url;
  });
}

/**
 * 合成几何（纯函数，可单测）：给定目标画布 W×H、人物源尺寸 sw×sh 与取景参数，
 * 算出缩放后的绘制宽高（dw/dh）、左上角偏移（ox/oy）与人物层画布尺寸（cw/ch）。
 *
 * 关键点：
 * - contain（无 placement）：人物完整可见并**居中**；
 * - cover（有 placement）：铺满画布，位移后仍钳制在「不露白」范围内；
 * - 旋转时按外接矩形定缩放，保证旋转后整幅人物仍在画面内。
 */
export function composeGeometry(
  W: number,
  H: number,
  sw: number,
  sh: number,
  placement?: Placement,
): { scale: number; dw: number; dh: number; ox: number; oy: number; cw: number; ch: number; rad: number } {
  const rotation = placement?.rotation ?? 0;
  const rad = (rotation * Math.PI) / 180;
  const noRot = rotation % 360 === 0;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const rotW = noRot ? sw : sw * cos + sh * sin;
  const rotH = noRot ? sh : sw * sin + sh * cos;
  const fit = placement ? Math.max : Math.min;
  const scale = fit(W / rotW, H / rotH) * (placement?.zoom ?? 1);
  const dw = rotW * scale;
  const dh = rotH * scale;
  const cw = Math.max(1, Math.round(sw * scale));
  const ch = Math.max(1, Math.round(sh * scale));
  let ox = (W - dw) / 2 + (placement?.dx ?? 0);
  let oy = (H - dh) / 2 + (placement?.dy ?? 0);
  // 边界 clamp 只对 cover 生效：位移后画面仍须完整覆盖画布。
  // contain 下 dw/dh ≤ 画布，必须保持居中（旧实现无条件 clamp 会把人物顶到左上角）。
  if (placement) {
    ox = Math.min(0, Math.max(W - dw, ox));
    oy = Math.min(0, Math.max(H - dh, oy));
  }
  return { scale, dw, dh, ox, oy, cw, ch, rad };
}

/** 把 matte 缩放到目标画布尺寸并完成像素级调整，产出可复用的人物层 */
export async function buildPersonLayer(
  matteBlob: Blob,
  opt: RetouchOpts,
  pxW: number,
  pxH: number,
  placement?: Placement,
): Promise<PersonLayer> {
  const img = await loadBlobImage(matteBlob);
  const W = Math.max(1, Math.round(pxW));
  const H = Math.max(1, Math.round(pxH));
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  const rot = placement?.rotation ?? 0;
  const noRot = rot % 360 === 0;
  const { dw, dh, ox, oy, cw, ch, rad } = composeGeometry(W, H, sw, sh, placement);

  // 1) 人物层直接按「绘制尺寸」建画布：像素级调整只跑输出分辨率
  const person = document.createElement('canvas');
  person.width = cw;
  person.height = ch;
  const pctx = person.getContext('2d')!;
  pctx.imageSmoothingEnabled = true;
  pctx.imageSmoothingQuality = 'high';
  pctx.drawImage(img, 0, 0, cw, ch);
  adjustPerson(person, {
    whiten: opt.whiten ?? 0,
    warm: opt.warm ?? 0,
    brightness: opt.brightness ?? 0,
    edgeThreshold: opt.edgeThreshold ?? 0,
    defringe: opt.defringe ?? 0,
    beauty: opt.beauty ?? 0,
  });

  // 2) 旋转：绕中心旋转到「能容纳整幅人物」的外接矩形上，不丢像素
  let canvas: HTMLCanvasElement = person;
  if (!noRot) {
    const rc = document.createElement('canvas');
    rc.width = Math.max(1, Math.ceil(dw));
    rc.height = Math.max(1, Math.ceil(dh));
    const rctx = rc.getContext('2d')!;
    rctx.imageSmoothingQuality = 'high';
    rctx.translate(rc.width / 2, rc.height / 2);
    rctx.rotate(rad);
    rctx.drawImage(person, -cw / 2, -ch / 2, cw, ch);
    canvas = rc;
  }

  return { canvas, dw, dh, ox, oy, w: W, h: H, key: personLayerKey(opt, pxW, pxH, placement) };
}

function toBlobP(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('合成失败'))),
      mime,
      quality,
    );
  });
}

/** 人物层 + 底色 → 成品 Blob（只做底色绘制 / 可选黑白，约 2~5ms／张） */
export function compositeLayer(
  layer: PersonLayer,
  opt: RetouchOpts,
  mime: 'image/png' | 'image/jpeg' = 'image/jpeg',
): Promise<Blob> {
  const { canvas: person, dw, dh, ox, oy, w: W, h: H } = layer;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const bg = opt.bg ?? BG_OPTIONS[0];
  if (bg.gradient) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, bg.gradient[0]);
    g.addColorStop(1, bg.gradient[1]);
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = bg.hex;
  }
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(person, ox, oy, dw, dh);
  // 黑白照片：整图（含背景/人物）转灰度
  if (opt.mono) {
    const id = ctx.getImageData(0, 0, W, H);
    const dd = id.data;
    for (let i = 0; i < dd.length; i += 4) {
      const g = Math.round(0.299 * dd[i] + 0.587 * dd[i + 1] + 0.114 * dd[i + 2]);
      dd[i] = dd[i + 1] = dd[i + 2] = g;
    }
    ctx.putImageData(id, 0, 0);
  }
  return toBlobP(canvas, mime, 0.95);
}

// 抠图结果 → 指定背景（纯色/渐变）+ 规格 + 修饰，输出成品 Blob
// placement：取景偏移（目标像素）。传入时改用 cover 缩放（图大于框，可平移微调且不会露白）；
// zoom 为相对 cover 基准的额外放大（≥1，人脸自动构图用）；rotation 为人物层旋转角度（度，
// 顺时针为正，绕人物中心旋转，用于「取景微调」的摆正/微调）；不传时维持原 contain 居中（零回归）。
// 批量场景应改用 buildPersonLayer + compositeLayer 两步走，才能复用人物层、只重做底色。
export async function composePhoto(
  matteBlob: Blob,
  opt: RetouchOpts,
  pxW: number,
  pxH: number,
  mime: 'image/png' | 'image/jpeg' = 'image/png',
  placement?: Placement,
): Promise<Blob> {
  const layer = await buildPersonLayer(matteBlob, opt, pxW, pxH, placement);
  return compositeLayer(layer, opt, mime);
}

export function mmToPx(mm: number, dpi = 300): number {
  return Math.round((mm / 25.4) * dpi);
}

export type ProgressFn = (phase: string, current: number, total: number) => void;

export type MatteInput = Blob | File | HTMLImageElement | string;

// 抠图：输入图片，返回带透明通道的 PNG Blob
export async function matte(input: MatteInput, onProgress?: ProgressFn): Promise<Blob> {
  const config: Config = {
    output: { format: 'image/png' },
    publicPath: mattingPublicPath(),
    progress: (key: string, current: number, total: number) => {
      onProgress?.(key, current, total);
    },
  };
  return removeBackground(input, config);
}

/* ===== F14：抠图结果缓存（同一张原图的多规格只抠一次） ===== */

// 对象输入（Blob/File/HTMLImageElement）用 WeakMap：对象被回收时缓存自动释放，不泄漏。
let matteWeak = new WeakMap<object, Promise<Blob>>();
// 字符串输入（URL）用 Map：数量通常很少，提供 clearMatteCache 手动清理。
let matteStr = new Map<string, Promise<Blob>>();

export function clearMatteCache(): void {
  matteWeak = new WeakMap();
  matteStr = new Map();
}

/**
 * 带缓存的抠图：同一输入多次调用只真正跑一次模型推理。
 * 批量出「同一张原图的多规格证件照」时，抠图从 N 次降为 1 次。
 * runner 可注入（单测用桩替代真实模型）。
 */
export async function cachedMatte(
  input: MatteInput,
  onProgress?: ProgressFn,
  runner: (i: MatteInput, p?: ProgressFn) => Promise<Blob> = matte,
): Promise<Blob> {
  const keyObj = typeof input === 'object' && input !== null;
  if (keyObj) {
    const o = input as object;
    const hit = matteWeak.get(o);
    if (hit) return hit;
    const p = runner(input, onProgress).catch((e) => {
      matteWeak.delete(o); // 失败不入缓存，允许重试
      throw e;
    });
    matteWeak.set(o, p);
    return p;
  }
  const s = String(input);
  const hit = matteStr.get(s);
  if (hit) return hit;
  const p = runner(input, onProgress).catch((e) => {
    matteStr.delete(s);
    throw e;
  });
  matteStr.set(s, p);
  return p;
}

// 把透明 PNG 合成到纯色背景，并按目标像素尺寸"contain"居中放置
export function composite(
  matteBlob: Blob,
  bg: BgColor,
  pxW: number,
  pxH: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(matteBlob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(pxW));
      canvas.height = Math.max(1, Math.round(pxH));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error('canvas 不可用'));
        return;
      }
      ctx.fillStyle = BG_HEX[bg];
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // contain：保留人物完整，不裁切
      const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
      canvas.toBlob((b) => {
        URL.revokeObjectURL(url);
        if (b) resolve(b);
        else reject(new Error('合成失败'));
      }, 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('抠图结果加载失败'));
    };
    img.src = url;
  });
}

// 一次性：抠图 + 换底，输出指定 mm 规格、指定 dpi 的证件照 Blob
export async function makeIdPhoto(
  input: Blob | File | HTMLImageElement | string,
  bg: BgColor,
  mmW: number,
  mmH: number,
  dpi = 300,
  onProgress?: ProgressFn,
): Promise<Blob> {
  // F14：多规格批量导出时复用同一份抠图结果，避免重复推理
  const matteBlob = await cachedMatte(input, onProgress);
  return composite(matteBlob, bg, mmToPx(mmW, dpi), mmToPx(mmH, dpi));
}

export function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图加载失败'));
    };
    img.src = url;
  });
}

// 保存 Blob 到磁盘这件事统一由 ../lib/exporter 的 saveBlob 负责（桌面端 tmp + rename 原子写，
// 浏览器环境回退 <a download>）。这里不再保留一层叫 downloadBlob 的同义包装 ——
// 名字里带 download 容易让人误以为绕过了主进程写盘，直接 import saveBlob 即可。
