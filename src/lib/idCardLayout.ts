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

export type PaperId = 'a4' | 'letter' | 'a5' | 'a3';
export const IC_PAPERS: Record<PaperId, { w: number; h: number; name: string }> = {
  a4: { w: 210, h: 297, name: 'A4' },
  // Letter（美制信纸 8.5×11 in）：爱印原版有此档，这里补齐以对齐纸张列表
  letter: { w: 215.9, h: 279.4, name: 'Letter' },
  a5: { w: 148, h: 210, name: 'A5' },
  a3: { w: 297, h: 420, name: 'A3' },
};

/** 纸张按钮的显示顺序：前三个与爱印一致（A4 / Letter / A3），A5 作为额外档位排最后 */
export const IC_PAPER_ORDER: PaperId[] = ['a4', 'letter', 'a3', 'a5'];

export type Orient = 'p' | 'l';

export function paperSize(id: PaperId, orient: Orient): { w: number; h: number; name: string } {
  const p = IC_PAPERS[id];
  return orient === 'l' ? { w: p.h, h: p.w, name: p.name } : { w: p.w, h: p.h, name: p.name };
}

/** 版面位置（对齐爱印：仅纵向锚定，水平恒居中；可用 offX 微调） */
export type Pos = 'top' | 'center' | 'bottom';
export type ColorMode = 'enhance' | 'bw' | 'color';

/** 显式排布（版面预备用）：指定列/行，其余按"这一页就要这样排"处理 */
export interface GridPreset {
  cols: number;
  rows: number;
}

export interface LayoutCfg {
  perPage: number | 'auto';
  gap: number; // 卡间距 mm
  shrink: boolean; // 放不下时缩小排版
  pos: Pos; // 版面位置
  offX: number; // 左右移缩 mm（正=右）
  offY: number; // 上下移缩 mm（正=下）
  /**
   * 版面预设：给出显式行列时按预设排（恒自适应缩放到能放下），
   * 省略/null 则走原有的自动网格推算。
   */
  preset?: GridPreset | null;
}

/**
 * 版面预设（对齐爱印「每页张数」的排版缩略图：2/3/5/6/11 张）。
 * 说明：爱印原图的缩略图只给出「几张 + 大致排布」，精确行列按证件横放的复印习惯推定——
 * 2/3 张竖排一列（正反面上下对应），5/6 张 2 列 3 行，11 张 3 列 4 行（缩到能放下）。
 */
export const LAYOUT_PRESETS: { id: string; count: number; cols: number; rows: number }[] = [
  { id: 'p2', count: 2, cols: 1, rows: 2 },
  { id: 'p3', count: 3, cols: 1, rows: 3 },
  { id: 'p5', count: 5, cols: 2, rows: 3 },
  { id: 'p6', count: 6, cols: 2, rows: 3 },
  { id: 'p11', count: 11, cols: 3, rows: 4 },
];

/** 按张数查预设排布；没有对应预设（如 1/4 张或 auto）时返回 null，走自动网格 */
export function presetForCount(perPage: number | 'auto'): GridPreset | null {
  if (perPage === 'auto') return null;
  const p = LAYOUT_PRESETS.find((x) => x.count === perPage);
  return p ? { cols: p.cols, rows: p.rows } : null;
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

  // 版面预设：按显式行列排，恒自适应缩放到能放下（预设本身就是"这一页就要这样排"的指令），
  // 因此不受 shrink 开关影响；usedRows 只算实际占用的行，保证居上/居中/居下锚定正确。
  if (cfg.preset) {
    const pc = Math.max(1, Math.floor(cfg.preset.cols));
    const pr = Math.max(1, Math.floor(cfg.preset.rows));
    const slots = pc * pr;
    const want = cfg.perPage === 'auto' ? slots : Math.min(Math.max(1, Math.floor(cfg.perPage)), slots);
    // 缩放只作用在卡片上，间距是固定 mm —— 所以求 scale 时必须先把间距占掉，
    // 否则「块宽 = 列×卡宽 + (列-1)×间距」会超出版心（旧版紧凑算法就踩了这个坑）。
    const sW = pc * cardW > 0 ? (uw - (pc - 1) * gap) / (pc * cardW) : 1;
    const sH = pr * cardH > 0 ? (uh - (pr - 1) * gap) / (pr * cardH) : 1;
    const sFit = Math.min(sW, sH);
    // 下限保护：极端参数下也不返回 0/负尺寸（画面会退化但不崩）
    const scale = Math.max(0.05, Math.min(1, sFit));
    const cw = cardW * scale;
    const ch = cardH * scale;
    const usedRows = Math.max(1, Math.ceil(want / pc));
    return {
      cols: pc,
      rows: pr,
      usedRows,
      perPage: want,
      capacity: slots,
      scale,
      cardW: cw,
      cardH: ch,
      blockW: pc * cw + (pc - 1) * gap,
      blockH: usedRows * ch + (usedRows - 1) * gap,
    };
  }

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
  // 水平恒居中（对齐爱印：横向不锚定，可用 offX 微调）
  let x0 = (paperW - g.blockW) / 2;
  // 纵向锚定：居上/居中/居下
  let y0: number;
  if (cfg.pos === 'top') y0 = PAD;
  else if (cfg.pos === 'bottom') y0 = paperH - PAD - g.blockH;
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
