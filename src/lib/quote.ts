import type { ColorMode } from './pdfAnalyze';

/** 页级模式：'none' 表示该页不打印 */
export type PageMode = ColorMode | 'none';

export interface LadderTier {
  minFaces: number; // 计价面数达到该值后进入此档（含）
  unitCents: number; // 该档每面单价（作为封顶价，与基础单价取低）
}

export interface Preset {
  id: number;
  name: string;
  paper: string;
  bwCents: number;
  dotCents: number;
  colorCents: number;
  duplexFactor: number; // 双面系数，如 0.6
  ladderTiers: LadderTier[]; // 阶梯价（多档数量区间）；空数组=不启用。建议按 minFaces 升序、unitCents 递减（越印越便宜）
  markupPercent: number; // 全局加价百分比（如 5 = 在已算单价上 ×1.05）；用于店铺统一上调
}

export interface FileRow {
  name: string;
  pages: number;
  paper: string; // A4 / A3 …按价格表
  size?: string; // 自动识别的原始尺寸（如 A3）；与 paper 不同时提示用户
  perPage: { page: number; mode: PageMode; colorRatio: number; redRatio?: number; manual?: boolean; size?: string }[];
  thumbs?: string[];
  copies: number;
  duplex: boolean; // 双面（版面）
  modeOverride?: ColorMode; // 手动整篇改色
}

export interface QuoteLine {
  name: string;
  paper: string;
  faces: number; // 计价面数（不含被排除页）
  pages: number;
  bwPages: number;
  dotPages: number;
  colorPages: number;
  copies: number;
  lineCents: number;
}

export interface Quote {
  lines: QuoteLine[];
  totalPages: number; // 计价面数合计（×份数）
  totalCents: number;
}

/** 报价明细分项：按 纸张+颜色+单双面+单价 聚合后的一行（对应原版「报价明细」面板） */
export interface QuoteDetailRow {
  key: string; // 聚合键：paper|mode|duplex|unit
  label: string; // 如「A4 黑白单面」
  paper: string;
  mode: Exclude<PageMode, 'none'>;
  duplex: boolean;
  unitCents: number; // 每面单价（已含双面系数 / 阶梯封顶）
  faces: number; // 计价面数（×份数后）
  subtotalCents: number; // faces × unitCents
}

const MODE_NAME: Record<Exclude<PageMode, 'none'>, string> = { bw: '黑白', dot: '点彩', color: '彩色' };
const MODE_ORDER: Record<Exclude<PageMode, 'none'>, number> = { bw: 0, dot: 1, color: 2 };

/** 阶梯价：取已命中档位中 minFaces 最大的一档（tiers 按 minFaces 升序时即最后一个命中档），返回其单价（封顶价）；无命中返回 null */
function applicableLadderUnit(preset: Preset, totalFaces: number): number | null {
  if (!preset.ladderTiers?.length) return null;
  let best: number | null = null;
  for (const t of preset.ladderTiers) if (totalFaces >= t.minFaces) best = t.unitCents; // 升序遍历，最后一个命中档生效
  return best;
}

/** 每面单价：quote() 与 quoteDetail() 共用，避免两处计价口径漂移。
 *  计价顺序：基础单价 → 阶梯封顶（按该文件计价面数×份数取档，与基础单价取低）→ 双面系数 → 全局加价百分比。 */
function pageUnitCents(mode: Exclude<PageMode, 'none'>, preset: Preset, totalFaces: number, duplex: boolean): number {
  let unit = modeUnit(mode, preset);
  const ladder = applicableLadderUnit(preset, totalFaces);
  if (ladder != null) unit = Math.min(unit, ladder);
  if (duplex) unit = Math.round(unit * preset.duplexFactor);
  if (preset.markupPercent) unit = Math.round((unit * (100 + preset.markupPercent)) / 100);
  return unit;
}

export function modeUnit(mode: ColorMode, preset: Preset): number {
  if (mode === 'bw') return preset.bwCents;
  if (mode === 'dot') return preset.dotCents;
  return preset.colorCents;
}

/** 兼容旧调用：preset 可传单个或按行取（每文件不同纸张） */
export function quote(rows: FileRow[], presetOrFn: Preset | ((r: FileRow) => Preset)): Quote {
  const presetOf = typeof presetOrFn === 'function' ? presetOrFn : () => presetOrFn;

  const lines: QuoteLine[] = rows.map((r) => {
    const preset = presetOf(r);
    // 阶梯价按该文件计价面数 × 份数判断进入哪一档（同一文件所有页共用达到的档位）
    const facesNoCopy = r.perPage.filter((p) => p.mode !== 'none').length;
    const totalFaces = facesNoCopy * r.copies;

    let bwPages = 0;
    let dotPages = 0;
    let colorPages = 0;
    let lineCents = 0;
    r.perPage.forEach((p) => {
      if (p.mode === 'none') return; // 不打印的页不计价
      const mode = r.modeOverride ?? p.mode;
      lineCents += pageUnitCents(mode, preset, totalFaces, r.duplex);
      if (mode === 'bw') bwPages++;
      else if (mode === 'dot') dotPages++;
      else colorPages++;
    });
    lineCents *= r.copies;
    return {
      name: r.name,
      paper: r.paper,
      faces: facesNoCopy,
      pages: r.pages,
      bwPages,
      dotPages,
      colorPages,
      copies: r.copies,
      lineCents,
    };
  });

  const totalCents = lines.reduce((s, l) => s + l.lineCents, 0);
  const totalPages = lines.reduce((s, l) => s + l.faces * l.copies, 0);
  return { lines, totalPages, totalCents };
}

/** 报价明细：把按文件计价结果聚合为「纸张+颜色+单双面+单价」分项（UI 面板与报价 PDF 共用同一份数据）。
 *  同一文件内同色模式的单价必然一致（阶梯价按文件整体判定），不同文件单价不同时自然分成两行，保证 小计=面数×单价 恒成立。 */
export function quoteDetail(rows: FileRow[], presetOrFn: Preset | ((r: FileRow) => Preset)): QuoteDetailRow[] {
  const presetOf = typeof presetOrFn === 'function' ? presetOrFn : () => presetOrFn;
  const map = new Map<string, QuoteDetailRow>();

  rows.forEach((r) => {
    const preset = presetOf(r);
    const facesNoCopy = r.perPage.filter((p) => p.mode !== 'none').length;
    const totalFaces = facesNoCopy * r.copies;
    // 同文件内同色模式单价唯一（阶梯价按文件整体判定），逐页直接聚合即可
    r.perPage.forEach((p) => {
      if (p.mode === 'none') return;
      const mode = r.modeOverride ?? p.mode;
      const key = `${r.paper}|${mode}|${r.duplex ? 1 : 0}`;
      const unit = pageUnitCents(mode, preset, totalFaces, r.duplex);
      const existing = map.get(`${key}|${unit}`);
      if (existing) {
        existing.faces += r.copies;
        existing.subtotalCents += unit * r.copies;
      } else {
        map.set(`${key}|${unit}`, {
          key: `${key}|${unit}`,
          label: `${r.paper} ${MODE_NAME[mode]}${r.duplex ? '双面' : '单面'}`,
          paper: r.paper,
          mode,
          duplex: r.duplex,
          unitCents: unit,
          faces: r.copies,
          subtotalCents: unit * r.copies,
        });
      }
    });
  });

  // 稳定排序：纸张 → 颜色（黑白/点彩/彩色）→ 单面在前 → 单价升序
  return [...map.values()].sort(
    (a, b) =>
      a.paper.localeCompare(b.paper, 'zh-CN') ||
      MODE_ORDER[a.mode] - MODE_ORDER[b.mode] ||
      (a.duplex ? 1 : 0) - (b.duplex ? 1 : 0) ||
      a.unitCents - b.unitCents,
  );
}

/** 明细分项小计之和（应恒等于 quote().totalCents，测试兜底） */
export function quoteDetailTotal(detail: QuoteDetailRow[]): number {
  return detail.reduce((s, d) => s + d.subtotalCents, 0);
}

/** 用纸张数：单面 = 面数；双面 = ceil(面数/2)。双面的文件每一份都从新的一张纸开始（奇数面按份补整），按文件各自纸张归并 */
export function sheetCount(rows: FileRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  rows.forEach((r) => {
    const faces = r.perPage.filter((p) => p.mode !== 'none').length;
    const perCopy = r.duplex ? Math.ceil(faces / 2) : faces;
    out[r.paper] = (out[r.paper] ?? 0) + perCopy * r.copies;
  });
  return out;
}

export function formatCents(cents: number): string {
  return '¥' + (cents / 100).toFixed(2);
}
