import type { ColorMode } from './pdfAnalyze';

/** 页级模式：'none' 表示该页不打印 */
export type PageMode = ColorMode | 'none';

export interface Preset {
  id: number;
  name: string;
  paper: string;
  bwCents: number;
  dotCents: number;
  colorCents: number;
  duplexFactor: number; // 双面系数，如 0.6
  ladderThreshold: number; // 满多少面启用阶梯价，0=不启用
  ladderCents: number; // 阶梯价每面单价（作为批量封顶单价）
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
    // 阶梯价：总面数达标时，每面单价取 min(原单价, 阶梯单价)
    const facesNoCopy = r.perPage.filter((p) => p.mode !== 'none').length;
    const useLadder =
      preset.ladderThreshold > 0 && facesNoCopy * r.copies >= preset.ladderThreshold && preset.ladderCents > 0;

    let bwPages = 0;
    let dotPages = 0;
    let colorPages = 0;
    let lineCents = 0;
    r.perPage.forEach((p) => {
      if (p.mode === 'none') return; // 不打印的页不计价
      const mode = r.modeOverride ?? p.mode;
      let unit = modeUnit(mode, preset);
      if (useLadder) unit = Math.min(unit, preset.ladderCents);
      if (r.duplex) unit = Math.round(unit * preset.duplexFactor);
      lineCents += unit;
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

/** 用纸张数：单面 = 面数；双面 = ceil(面数/2)。按文件各自纸张归并 */
export function sheetCount(rows: FileRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  rows.forEach((r) => {
    const faces = r.perPage.filter((p) => p.mode !== 'none').length * r.copies;
    const sheets = r.duplex ? Math.ceil(faces / 2) : faces;
    out[r.paper] = (out[r.paper] ?? 0) + sheets;
  });
  return out;
}

export function formatCents(cents: number): string {
  return '¥' + (cents / 100).toFixed(2);
}
