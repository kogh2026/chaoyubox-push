// 证件照换底：本地 ML 抠图（@imgly/background-removal，底层 onnxruntime-web + ISNet）
// 模型首次使用从 jsdelivr CDN 拉取并缓存到 IndexedDB，之后离线可用。
import { removeBackground, type Config } from '@imgly/background-removal';

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
}

// 像素级人像调整：只处理 alpha>0 的像素（人物），背景不受影响
function adjustPerson(
  canvas: HTMLCanvasElement,
  o: { whiten: number; warm: number; brightness: number; edgeThreshold: number },
): void {
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
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

// 抠图结果 → 指定背景（纯色/渐变）+ 规格 + 修饰，输出成品 Blob
export function composePhoto(
  matteBlob: Blob,
  opt: RetouchOpts,
  pxW: number,
  pxH: number,
  mime: 'image/png' | 'image/jpeg' = 'image/png',
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(matteBlob);
    const img = new Image();
    img.onload = () => {
      // 1) 人物层（原始分辨率上做像素调整，避免小图失真）
      const person = document.createElement('canvas');
      person.width = img.width;
      person.height = img.height;
      const pctx = person.getContext('2d')!;
      pctx.drawImage(img, 0, 0);
      adjustPerson(person, {
        whiten: opt.whiten ?? 0,
        warm: opt.warm ?? 0,
        brightness: opt.brightness ?? 0,
        edgeThreshold: opt.edgeThreshold ?? 0,
      });

      // 2) 背景层 + contain 放置人物
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(pxW));
      canvas.height = Math.max(1, Math.round(pxH));
      const ctx = canvas.getContext('2d')!;
      const bg = opt.bg ?? BG_OPTIONS[0];
      if (bg.gradient) {
        const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        g.addColorStop(0, bg.gradient[0]);
        g.addColorStop(1, bg.gradient[1]);
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = bg.hex;
      }
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(person, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
      canvas.toBlob(
        (b) => {
          URL.revokeObjectURL(url);
          if (b) resolve(b);
          else reject(new Error('合成失败'));
        },
        mime,
        0.95,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('抠图结果加载失败'));
    };
    img.src = url;
  });
}

export function mmToPx(mm: number, dpi = 300): number {
  return Math.round((mm / 25.4) * dpi);
}

export type ProgressFn = (phase: string, current: number, total: number) => void;

// 抠图：输入图片，返回带透明通道的 PNG Blob
export async function matte(
  input: Blob | File | HTMLImageElement | string,
  onProgress?: ProgressFn,
): Promise<Blob> {
  const config: Config = {
    output: { format: 'image/png' },
    progress: (key: string, current: number, total: number) => {
      onProgress?.(key, current, total);
    },
  };
  return removeBackground(input, config);
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
  const matteBlob = await matte(input, onProgress);
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

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
