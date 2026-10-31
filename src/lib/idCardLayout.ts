// 证卡拼版助手（增强模式）布局引擎 —— clean-room 复刻
// 单位全部为毫米(mm)；图像以 cover 方式填满卡片，不变形。
// 不含证件自动识别（无 ML），类型由用户手动指定。

export interface CardType {
  id: string;
  name: string;
  w: number;
  h: number;
}

// 常见证件实际尺寸（mm）
export const CARD_TYPES: CardType[] = [
  { id: 'idcard', name: '身份证', w: 85.6, h: 54 },
  { id: 'hukou', name: '户口本', w: 105, h: 143 },
  { id: 'passport', name: '护照', w: 125, h: 88 },
  { id: 'drive', name: '驾驶证', w: 88, h: 60 },
  { id: 'other', name: '其他', w: 85.6, h: 54 },
];

export function cardTypeOf(id: string): CardType {
  return CARD_TYPES.find((t) => t.id === id) ?? CARD_TYPES[0];
}

export type PaperId = 'a4' | 'a5' | 'a3';
export const IC_PAPERS: Record<PaperId, { w: number; h: number; name: string }> = {
  a4: { w: 210, h: 297, name: 'A4' },
  a5: { w: 148, h: 210, name: 'A5' },
  a3: { w: 297, h: 420, name: 'A3' },
};

export type Orient = 'p' | 'l';

export function paperSize(id: PaperId, orient: Orient): { w: number; h: number; name: string } {
  const p = IC_PAPERS[id];
  return orient === 'l' ? { w: p.h, h: p.w, name: p.name } : { w: p.w, h: p.h, name: p.name };
}

export type Pos = 'tl' | 'center' | 'br';
export type ColorMode = 'enhance' | 'bw' | 'color';

export interface LayoutCfg {
  perPage: number | 'auto';
  gap: number; // 卡间距 mm
  shrink: boolean; // 放不下时缩小排版
  pos: Pos; // 版面位置
  offX: number; // 左右移缩 mm（正=右）
  offY: number; // 上下移缩 mm（正=下）
}

const PAD = 6; // 打印安全边距 mm

export interface CardGrid {
  cols: number;
  rows: number; // 可用总行数
  usedRows: number; // 本页实际占用行数
  perPage: number; // 实际每页张数
  capacity: number; // 一页最多能放几张
  scale: number; // 1 = 原尺寸
  cardW: number; // 缩放后的卡宽
  cardH: number;
  blockW: number; // 内容块总宽
  blockH: number;
}

// 依据纸张与卡片尺寸计算网格；放不下时按 cfg.shrink 决定是否缩小
export function computeCardGrid(
  paperW: number,
  paperH: number,
  cardW: number,
  cardH: number,
  cfg: LayoutCfg,
): CardGrid {
  const uw = paperW - 2 * PAD;
  const uh = paperH - 2 * PAD;
  const gap = cfg.gap;

  const colsFit = Math.max(1, Math.floor((uw + gap) / (cardW + gap)));
  const rowsFit = Math.max(1, Math.floor((uh + gap) / (cardH + gap)));
  const capacity = colsFit * rowsFit;
  const singleFitScale = Math.min(1, Math.min(uw / cardW, uh / cardH));

  let scale = singleFitScale;
  let cols = colsFit;
  let perPage = cfg.perPage === 'auto' ? capacity : Math.min(cfg.perPage, capacity);

  // 每页 ≤3 张时优先竖排一列（正/反上下对应，贴近复印习惯）；
  // 一列放不下时：开启"放不下时缩小"且缩小不超过一半 → 整体缩放后仍排一列，否则回退网格
  const wantStack = cfg.perPage !== 'auto' && cfg.perPage <= 3;
  if (wantStack) {
    const n = cfg.perPage as number;
    const sStack = Math.min(uw / cardW, (uh - (n - 1) * gap) / (n * cardH));
    if (sStack >= 1 || (cfg.shrink && sStack >= 0.5)) {
      scale = Math.min(1, sStack);
      cols = 1;
      perPage = n;
    }
  }

  const cw = cardW * scale;
  const ch = cardH * scale;
  const rows = rowsFit;
  const usedRows = Math.max(1, Math.ceil(perPage / cols));
  return {
    cols,
    rows,
    usedRows,
    perPage,
    capacity,
    scale,
    cardW: cw,
    cardH: ch,
    blockW: cols * cw + (cols - 1) * gap,
    blockH: usedRows * ch + (usedRows - 1) * gap,
  };
}

export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
}

// 把内容块按版面位置 + 偏移放到页面上，返回每张卡的位置
export function pagePlacements(
  paperW: number,
  paperH: number,
  g: CardGrid,
  cfg: LayoutCfg,
): Placement[] {
  let x0: number;
  if (cfg.pos === 'tl') x0 = PAD;
  else if (cfg.pos === 'br') x0 = paperW - PAD - g.blockW;
  else x0 = (paperW - g.blockW) / 2;
  let y0: number;
  if (cfg.pos === 'tl') y0 = PAD;
  else if (cfg.pos === 'br') y0 = paperH - PAD - g.blockH;
  else y0 = (paperH - g.blockH) / 2;
  x0 += cfg.offX;
  y0 += cfg.offY;
  const out: Placement[] = [];
  for (let i = 0; i < g.perPage; i++) {
    const c = i % g.cols;
    const r = Math.floor(i / g.cols);
    out.push({
      x: x0 + c * (g.cardW + cfg.gap),
      y: y0 + r * (g.cardH + cfg.gap),
      w: g.cardW,
      h: g.cardH,
    });
  }
  return out;
}

// 把勾选的图按 perPage 分页，返回每页的源图下标
export function paginate(count: number, perPage: number): number[][] {
  const pages: number[][] = [];
  for (let i = 0; i < count; i += perPage) {
    pages.push(Array.from({ length: Math.min(perPage, count - i) }, (_, k) => i + k));
  }
  return pages;
}

// 色彩滤镜（预览与导出共用，保证所见即所得）
export function colorFilter(mode: ColorMode, sat: number, sharpen: number): string {
  const contrast = 1 + sharpen * 0.02; // -15 → 0.70, +15 → 1.30
  if (mode === 'bw') return `grayscale(1) contrast(${contrast.toFixed(2)})`;
  if (mode === 'enhance')
    return `saturate(${Math.round(sat)}%) contrast(${(contrast + 0.08).toFixed(2)}) brightness(1.02)`;
  return `saturate(${Math.round(sat)}%)`;
}

function rotatedCanvas(src: CanvasImageSource, sw: number, sh: number, rotation: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const swap = rotation === 90 || rotation === 270;
  c.width = swap ? sh : sw;
  c.height = swap ? sw : sh;
  const ctx = c.getContext('2d')!;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(src, -sw / 2, -sh / 2, sw, sh);
  return c;
}

// cover 方式把源图（可带旋转/滤镜）画进目标矩形
export function coverDraw(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  sw: number,
  sh: number,
  rotation: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  filter: string,
): void {
  let source: CanvasImageSource = src;
  let w = sw;
  let h = sh;
  if (rotation) {
    const rc = rotatedCanvas(src, sw, sh, rotation);
    source = rc;
    w = rc.width;
    h = rc.height;
  }
  const tr = dw / dh;
  let sx = 0;
  let sy = 0;
  let sWidth = w;
  let sHeight = h;
  if (w / h > tr) {
    sWidth = h * tr;
    sx = (w - sWidth) / 2;
  } else {
    sHeight = w / tr;
    sy = (h - sHeight) / 2;
  }
  ctx.save();
  if (filter) ctx.filter = filter;
  ctx.drawImage(source, sx, sy, sWidth, sHeight, dx, dy, dw, dh);
  ctx.restore();
}

export interface WmCfg {
  on: boolean;
  text: string;
}

export interface PageStyle {
  colorMode: ColorMode;
  sat: number; // 0-100 浓度
  sharpen: number; // -15..15 锐度
  wm: WmCfg;
  cropMarks?: boolean; // 蚂蚁线裁切口（导出/预览同源，远离卡边）
  /**
   * 卡片圆角半径（mm）。undefined = 按卡片短边自然比例自动（CARD_CORNER_FACTOR），
   * 保证"必备且默认生效"；显式传 0 可关闭直角输出。
   */
  cornerRadiusMm?: number;
}

/**
 * 卡片圆角：短边占比（爱印参考效果的自然弧度）。
 * 身份证 54mm 短边 → 约 4.3mm，肉眼可见且不过分。
 */
export const CARD_CORNER_FACTOR = 0.08;

/**
 * 计算卡片圆角半径（mm）：undefined 走自然比例（保证默认生效），
 * 显式数值（含 0）直接采用（0 = 直角）。纯函数便于单测。
 */
export function cardCornerRadiusMm(wMm: number, hMm: number, override?: number): number {
  if (override !== undefined) return Math.max(0, override);
  return Math.min(wMm, hMm) * CARD_CORNER_FACTOR;
}

/** 在 2D 上下文上描出圆角矩形路径（兼容真实 CanvasRenderingContext2D）。 */
export function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (rr <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// 渲染一页到 canvas（预览与导出共用）
export function renderCardPage(
  canvas: HTMLCanvasElement,
  paperW: number,
  paperH: number,
  placements: Placement[],
  images: { img: HTMLImageElement; rotation: number }[],
  pxPerMm: number,
  style: PageStyle,
): void {
  canvas.width = Math.round(paperW * pxPerMm);
  canvas.height = Math.round(paperH * pxPerMm);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const filter = colorFilter(style.colorMode, style.sat, style.sharpen);
  placements.forEach((p, i) => {
    const im = images[i];
    if (!im) return;
    const rMm = cardCornerRadiusMm(p.w, p.h, style.cornerRadiusMm);
    const px = pxPerMm;
    const x = p.x * px;
    const y = p.y * px;
    const w = p.w * px;
    const h = p.h * px;
    const rPx = Math.min(rMm * px, w / 2, h / 2);
    ctx.save();
    if (rPx > 0.5) {
      roundRectPath(ctx, x, y, w, h, rPx);
      ctx.clip();
    }
    coverDraw(ctx, im.img, im.img.naturalWidth, im.img.naturalHeight, im.rotation, x, y, w, h, filter);
    ctx.restore();
  });

  if (style.wm.on && style.wm.text.trim()) {
    const step = Math.max(canvas.width, canvas.height) / 3;
    ctx.save();
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = '#000';
    ctx.font = `${Math.round(step / 6)}px sans-serif`;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((-25 * Math.PI) / 180);
    const span = (canvas.width + canvas.height) * 1.2;
    for (let y = -span / 2; y < span / 2; y += step) {
      for (let x = -span / 2; x < span / 2; x += step * 2.2) {
        ctx.fillText(style.wm.text, x, y);
      }
    }
    ctx.restore();
  }

  // 蚂蚁线裁切口：在每个卡槽四角外缘画短虚线，便于裁切对齐（远离卡面）
  if (style.cropMarks) {
    const tick = Math.max(6, pxPerMm * 2.5); // 裁切标记长度 ~2.5mm
    ctx.save();
    ctx.strokeStyle = 'rgba(80,80,80,0.85)';
    ctx.lineWidth = Math.max(0.6, pxPerMm * 0.18);
    ctx.setLineDash([pxPerMm * 0.9, pxPerMm * 0.7]);
    placements.forEach((p) => {
      const x0 = p.x * pxPerMm;
      const y0 = p.y * pxPerMm;
      const x1 = (p.x + p.w) * pxPerMm;
      const y1 = (p.y + p.h) * pxPerMm;
      const corners = [
        [x0, y0, 1, 1],
        [x1, y0, -1, 1],
        [x1, y1, -1, -1],
        [x0, y1, 1, -1],
      ] as const;
      for (const [cx, cy, dx, dy] of corners) {
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + dx * tick, cy);
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx, cy + dy * tick);
        ctx.stroke();
      }
    });
    ctx.restore();
  }
}
