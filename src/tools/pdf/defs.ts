// PDF 工具集定义：40 项功能、6 大分类。
// 名称与描述均为通用中性表述，不引用任何第三方产品标识。
// 参数面板由 ParamPanel 按 schema 渲染；custom 面板见 CustomPanels.tsx。
import { PAPER_SIZES_PT } from '../../lib/pdfOps';

export type CatId = 'page' | 'adjust' | 'impose' | 'image' | 'mark' | 'secure';

export interface CatDef {
  id: CatId;
  name: string;
  desc: string;
  icon: string;
}

export const CATS: CatDef[] = [
  { id: 'page', name: '页面管理', desc: '合并、拆分、提取、重排', icon: '📑' },
  { id: 'adjust', name: '页面调整', desc: '旋转、裁剪、纠偏、补齐', icon: '📐' },
  { id: 'impose', name: '版式拼版', desc: '拼版、折页、页码、新建', icon: '🧱' },
  { id: 'image', name: '格式图像', desc: '转图、提取、滤镜、压缩', icon: '🖼' },
  { id: 'mark', name: '标注编号', desc: '水印、批注、接缝、编号', icon: '✍️' },
  { id: 'secure', name: '安全信息', desc: '加密、解密、属性、签名', icon: '🔒' },
];

// 输入类型：single 单个 PDF / multi 多个 PDF / image-multi 多个图片 / none 无需输入
export type InputKind = 'single' | 'multi' | 'image-multi' | 'none';

// 自定义面板种类
export type CustomKind = 'reorder' | 'rotate' | 'bookmarks' | 'wmpos' | 'annotate' | 'metadata' | 'signature';

export type ParamValue = string | number | boolean;

export type ParamDef =
  | { kind: 'select'; key: string; label: string; options: [string, string][]; def: string }
  | { kind: 'check'; key: string; label: string; def: boolean }
  | { kind: 'number'; key: string; label: string; def: number; min?: number; max?: number; step?: number; unit?: string }
  | { kind: 'text'; key: string; label: string; def: string; placeholder?: string }
  | { kind: 'password'; key: string; label: string; def: string; placeholder?: string }
  | { kind: 'color'; key: string; label: string; def: string }
  | { kind: 'range'; key: string; label: string; def: string; placeholder?: string };

export interface ToolDef {
  id: string;
  name: string;
  desc: string;
  icon: string;
  cat: CatId;
  input: InputKind;
  accept?: string;
  custom?: CustomKind;
  thumbs?: boolean; // 需要加载页面缩略图
  params?: ParamDef[];
  run: string; // 分发键（PdfTools.tsx 的 switch）
  hint?: string;
}

const PAPER_OPTS: [string, string][] = PAPER_SIZES_PT.map((p) => [p.name, `${p.name}（${Math.round(p.w)}×${Math.round(p.h)} pt）`]);
const DPI_OPTS: [string, string][] = [
  ['1', '1×（72 dpi，最快）'],
  ['1.5', '1.5×（108 dpi）'],
  ['2', '2×（144 dpi）'],
  ['3', '3×（216 dpi，推荐）'],
  ['4', '4×（288 dpi）'],
];
const RANGE_HINT = '留空 = 全部页，例：1-3,5,8-10';
const RANGE_PARAM = (label = '页码范围'): ParamDef => ({ kind: 'range', key: 'range', label, def: '', placeholder: RANGE_HINT });

export const TOOLS: ToolDef[] = [
  /* ===== 页面管理（9） ===== */
  {
    id: 'merge', name: '合并文档', desc: '多个 PDF 与图片按顺序合成一个文档', icon: '📎', cat: 'page', input: 'multi',
    accept: '.pdf,image/jpeg,image/png',
    params: [
      { kind: 'check', key: 'compatMode', label: '兼容模式', def: false },
      { kind: 'select', key: 'dpi', label: '光栅倍率', options: DPI_OPTS, def: '2' },
      { kind: 'select', key: 'pageSize', label: '图片纸张', options: [...PAPER_OPTS, ['fit', '跟随图片']], def: 'A4' },
    ],
    run: 'merge',
    hint: '兼容模式会把无法直接合并的文件转成图片后合并，速度较慢但成功率高',
  },
  {
    id: 'interleave', name: '交叉合并', desc: '多个文档逐页交叉穿插，常用于双面扫描件正反面', icon: '🔀', cat: 'page', input: 'multi',
    accept: '.pdf,application/pdf',
    run: 'interleave',
    hint: '第 1 份第 1 页、第 2 份第 1 页、第 1 份第 2 页……交替插入；页数不齐时自动跳过',
  },
  {
    id: 'split', name: '拆分文档', desc: '按页码范围、固定页数或奇偶拆成多个文件', icon: '✂️', cat: 'page', input: 'single',
    params: [
      { kind: 'select', key: 'mode', label: '拆分方式', options: [['ranges', '按页码范围'], ['fixed', '每 N 页一份'], ['single', '每页一份'], ['oddeven', '奇偶页分离']], def: 'ranges' },
      RANGE_PARAM(),
      { kind: 'number', key: 'fixed', label: '每份页数', def: 10, min: 1, max: 9999, step: 1 },
    ],
    run: 'split',
  },
  {
    id: 'split-bookmark', name: '按书签拆分', desc: '勾选书签章节，拆出所选章节并保留原顺序', icon: '🔖', cat: 'page', input: 'single',
    custom: 'bookmarks',
    run: 'splitBookmark',
    hint: '在下方书签列表中勾选要保留的章节，未勾选的页不会进入结果',
  },
  {
    id: 'explode-bookmark', name: '书签生成文件', desc: '按书签层级把文档炸开成多个独立文件', icon: '💥', cat: 'page', input: 'single',
    params: [
      { kind: 'check', key: 'addIndex', label: '添加序号', def: true },
      { kind: 'check', key: 'useFileNamePrefix', label: '原文件名前缀', def: false },
      { kind: 'check', key: 'useBookmarkName', label: '使用书签名', def: true },
      { kind: 'check', key: 'keepHierarchy', label: '保留层级名称', def: true },
      { kind: 'number', key: 'maxDepth', label: '拆分层级', def: 3, min: 1, max: 6, step: 1 },
    ],
    run: 'explodeBookmark',
    hint: '层级 1 = 只拆一级书签；勾选保留层级时文件名形如「父_子_孙」',
  },
  {
    id: 'extract', name: '提取页面', desc: '把指定页码提取成一个新文档', icon: '📤', cat: 'page', input: 'single',
    params: [RANGE_PARAM('提取范围')],
    run: 'extract',
  },
  {
    id: 'delete', name: '删除页面', desc: '按页码范围删除页面，其余页顺次前移', icon: '🗑', cat: 'page', input: 'single',
    params: [RANGE_PARAM('删除范围')],
    run: 'delete',
  },
  {
    id: 'reorder', name: '整理页序', desc: '拖拽调整页面顺序，可插入空白页', icon: '🔃', cat: 'page', input: 'single',
    custom: 'reorder', thumbs: true,
    run: 'reorder',
    hint: '拖动缩略图调整顺序；「+ 空白」可在该位置插入一张空白页',
  },
  {
    id: 'odd-even', name: '奇偶页分离', desc: '按页码奇偶拆成两个文件', icon: '↔️', cat: 'page', input: 'single',
    run: 'oddEven',
  },

  /* ===== 页面调整（8） ===== */
  {
    id: 'rotate', name: '旋转页面', desc: '整篇或指定页顺时针旋转 90/180/270', icon: '🔄', cat: 'adjust', input: 'single',
    params: [
      { kind: 'select', key: 'angle', label: '角度', options: [['90', '90°'], ['180', '180°'], ['270', '270°']], def: '90' },
      RANGE_PARAM(),
    ],
    run: 'rotate',
    hint: '旋转是累加的：对已旋转过的页面重复旋转会叠加',
  },
  {
    id: 'unify', name: '统一页面大小', desc: '把所有页面缩放统一到同一纸张', icon: '📏', cat: 'adjust', input: 'single',
    params: [
      { kind: 'select', key: 'size', label: '目标纸张', options: PAPER_OPTS, def: 'A4' },
      { kind: 'select', key: 'mode', label: '缩放方式', options: [['contain', '等比容纳（留白）'], ['cover', '等比填满（裁切）'], ['stretch', '拉满（变形）']], def: 'contain' },
      RANGE_PARAM(),
    ],
    run: 'unify',
  },
  {
    id: 'reverse', name: '颠倒页序', desc: '整篇页面顺序完全倒转', icon: '⤵️', cat: 'adjust', input: 'single',
    run: 'reverse',
  },
  {
    id: 'pad-even', name: '补齐偶数页', desc: '页数为奇数时在末尾补一张空白页', icon: '➕', cat: 'adjust', input: 'single',
    params: [
      { kind: 'select', key: 'mode', label: '空白页尺寸', options: [['last', '跟随末页'], ['A4', 'A4'], ['Letter', 'Letter']], def: 'last' },
    ],
    run: 'padEven',
    hint: '双面打印前用，避免正反面错页',
  },
  {
    id: 'remove-blank', name: '删除空白页', desc: '自动识别并删除空白页', icon: '🕳', cat: 'adjust', input: 'single', thumbs: true,
    params: [
      { kind: 'number', key: 'thresholdPct', label: '空白阈值', def: 0.3, min: 0.05, max: 5, step: 0.05, unit: '%' },
    ],
    run: 'removeBlank',
    hint: '阈值 = 非白像素占比；调大可识别更多「接近空白」的页面',
  },
  {
    id: 'crop', name: '裁切白边', desc: '按内容边界自动裁掉页面白边', icon: '✂', cat: 'adjust', input: 'single',
    params: [
      { kind: 'number', key: 'threshold', label: '白边判定', def: 246, min: 200, max: 255, step: 1 },
      { kind: 'number', key: 'marginMm', label: '保留边距', def: 2, min: 0, max: 20, step: 0.5, unit: 'mm' },
    ],
    run: 'crop',
    hint: '判定值越大越容易把浅色内容当成白边裁掉',
  },
  {
    id: 'deskew', name: '纠正倾斜', desc: '自动检测扫描倾斜角并转正', icon: '📐', cat: 'adjust', input: 'single',
    params: [
      { kind: 'check', key: 'auto', label: '自动检测角度', def: true },
      { kind: 'number', key: 'angle', label: '手动角度', def: 0, min: -45, max: 45, step: 0.5, unit: '°' },
      { kind: 'select', key: 'dpi', label: '输出倍率', options: DPI_OPTS, def: '2' },
    ],
    run: 'deskew',
    hint: '结果为图片版 PDF；顺时针为正，逆时针为负',
  },
  {
    id: 'spread', name: '对开页切分', desc: '把左右摊开的对开页切成单页', icon: '📖', cat: 'adjust', input: 'single',
    params: [
      { kind: 'check', key: 'force', label: '强制对半切', def: false },
    ],
    run: 'spread',
    hint: '默认只切宽度明显大于高度的页面；勾选强制后所有页面对半切',
  },

  /* ===== 版式拼版（7） ===== */
  {
    id: 'nup', name: 'N-up 拼版', desc: '多页缩排到同一张纸，节省纸张', icon: '🧱', cat: 'impose', input: 'single',
    params: [
      { kind: 'number', key: 'cols', label: '列数', def: 2, min: 1, max: 6, step: 1 },
      { kind: 'number', key: 'rows', label: '行数', def: 2, min: 1, max: 6, step: 1 },
      { kind: 'select', key: 'order', label: '排列顺序', options: [['row', '先行后列'], ['col', '先列后行']], def: 'row' },
      { kind: 'number', key: 'marginMm', label: '页边距', def: 5, min: 0, max: 30, step: 1, unit: 'mm' },
      { kind: 'number', key: 'gapMm', label: '间距', def: 2, min: 0, max: 30, step: 1, unit: 'mm' },
      { kind: 'check', key: 'border', label: '画边框', def: true },
      { kind: 'check', key: 'skipEmpty', label: '跳过不足一组', def: true },
    ],
    run: 'nup',
  },
  {
    id: 'booklet', name: '骑马订拼版', desc: '按骑马订折页顺序重排页面', icon: '📕', cat: 'impose', input: 'single',
    params: [
      { kind: 'select', key: 'size', label: '成品尺寸', options: [['origin', '跟随原页'], ['A4', 'A4'], ['A5', 'A5'], ['A6', 'A6']], def: 'origin' },
    ],
    run: 'booklet',
    hint: '页数会自动补齐到 4 的倍数',
  },
  {
    id: 'booklet-split', name: '书籍折页拆分', desc: '把对折扫描的书籍页拆成单页', icon: '📗', cat: 'impose', input: 'multi',
    accept: '.pdf,application/pdf',
    params: [
      { kind: 'select', key: 'dir', label: '拆分方向', options: [['auto', '自动判断'], ['lr', '左右对开'], ['tb', '上下对开']], def: 'auto' },
    ],
    run: 'bookletSplit',
  },
  {
    id: 'img-pdf', name: '图片转 PDF', desc: '多张图片排版成一个 PDF 文档', icon: '🖼', cat: 'impose', input: 'image-multi',
    accept: 'image/jpeg,image/png',
    params: [
      { kind: 'select', key: 'pageSize', label: '纸张', options: [...PAPER_OPTS, ['fit', '跟随图片']], def: 'A4' },
      { kind: 'check', key: 'landscape', label: '横向', def: false },
      { kind: 'number', key: 'marginMm', label: '页边距', def: 5, min: 0, max: 50, step: 1, unit: 'mm' },
      { kind: 'select', key: 'fit', label: '缩放方式', options: [['contain', '等比容纳（留白）'], ['cover', '等比填满（裁切）'], ['stretch', '拉满（变形）']], def: 'contain' },
      { kind: 'color', key: 'background', label: '背景色', def: '#ffffff' },
    ],
    run: 'imgToPdf',
  },
  {
    id: 'blank', name: '新建空白文档', desc: '生成带格线 / 横线的空白页', icon: '📄', cat: 'impose', input: 'none',
    params: [
      { kind: 'select', key: 'preset', label: '纸张', options: [...PAPER_OPTS, ['custom', '自定义尺寸']], def: 'A4' },
      { kind: 'number', key: 'customW', label: '宽', def: 210, min: 20, max: 1000, step: 1, unit: 'mm' },
      { kind: 'number', key: 'customH', label: '高', def: 297, min: 20, max: 1000, step: 1, unit: 'mm' },
      { kind: 'check', key: 'landscape', label: '横向', def: false },
      { kind: 'number', key: 'count', label: '页数', def: 1, min: 1, max: 500, step: 1 },
      { kind: 'select', key: 'grid', label: '底纹', options: [['none', '纯白'], ['quad', '方格'], ['ruled', '横线'], ['dotted', '点阵']], def: 'none' },
      { kind: 'color', key: 'lineColor', label: '线条颜色', def: '#c8ccd4' },
      { kind: 'number', key: 'lineSpacingMm', label: '线距', def: 8, min: 3, max: 30, step: 1, unit: 'mm' },
      { kind: 'text', key: 'header', label: '页眉', def: '', placeholder: '可留空' },
      { kind: 'text', key: 'footer', label: '页脚', def: '', placeholder: '可留空' },
    ],
    run: 'blank',
  },
  {
    id: 'page-no', name: '添加页码', desc: '在页面九宫格位置添加页码', icon: '🔢', cat: 'impose', input: 'single',
    params: [
      { kind: 'select', key: 'template', label: '格式', options: [['n', '仅数字 1'], ['n-total', '1 / 10'], ['cn', '中文 一'], ['cn-total', '中文 一 / 十'], ['dash', '- 1 -']], def: 'n' },
      { kind: 'select', key: 'position', label: '位置', options: [['tl', '左上'], ['tc', '上中'], ['tr', '右上'], ['ml', '左中'], ['mc', '居中'], ['mr', '右中'], ['bl', '左下'], ['bc', '下中'], ['br', '右下']], def: 'bc' },
      { kind: 'number', key: 'sizePt', label: '字号', def: 10, min: 6, max: 48, step: 1, unit: 'pt' },
      { kind: 'color', key: 'color', label: '颜色', def: '#333333' },
      { kind: 'number', key: 'marginMm', label: '边距', def: 10, min: 0, max: 50, step: 1, unit: 'mm' },
      { kind: 'number', key: 'startAt', label: '起始页码', def: 1, min: 0, max: 9999, step: 1 },
      { kind: 'select', key: 'font', label: '字体', options: [['regular', '常规'], ['bold', '加粗']], def: 'regular' },
      RANGE_PARAM(),
    ],
    run: 'pageNumbers',
  },
  {
    id: 'fixed-split', name: '固定页数拆分', desc: '每 N 页拆成一个文件', icon: '📦', cat: 'impose', input: 'single',
    params: [
      { kind: 'number', key: 'fixed', label: '每份页数', def: 10, min: 1, max: 9999, step: 1 },
    ],
    run: 'fixedSplit',
  },

  /* ===== 格式图像（7） ===== */
  {
    id: 'to-img', name: '导出为图片', desc: '每页导出为 JPG / PNG 并打包', icon: '📸', cat: 'image', input: 'single',
    params: [
      { kind: 'select', key: 'dpi', label: '倍率', options: DPI_OPTS, def: '2' },
      { kind: 'select', key: 'format', label: '格式', options: [['image/jpeg', 'JPG（体积小）'], ['image/png', 'PNG（无损）']], def: 'image/jpeg' },
      { kind: 'number', key: 'quality', label: 'JPG 质量', def: 0.85, min: 0.3, max: 1, step: 0.05 },
    ],
    run: 'toImages',
    hint: '结果打包为 ZIP 下载',
  },
  {
    id: 'extract-img', name: '提取内嵌图片', desc: '把文档里嵌入的图片原样抽出', icon: '🧲', cat: 'image', input: 'single',
    run: 'extractImages',
    hint: '结果打包为 ZIP 下载；只提取位图，矢量图形不算',
  },
  {
    id: 'img-doc', name: '转为图片版', desc: '整档转成图片 PDF，可叠加滤镜', icon: '🖨', cat: 'image', input: 'single',
    params: [
      { kind: 'select', key: 'dpi', label: '倍率', options: DPI_OPTS, def: '2' },
      { kind: 'select', key: 'filter', label: '滤镜', options: [['none', '无'], ['bw', '黑白'], ['gray', '灰度'], ['sharpen', '锐化'], ['invert', '反色']], def: 'none' },
    ],
    run: 'toImageDoc',
  },
  {
    id: 'gray', name: '黑白灰度化', desc: '彩色文档转灰度，黑白打印更省', icon: '⚫', cat: 'image', input: 'single',
    params: [
      { kind: 'select', key: 'dpi', label: '倍率', options: DPI_OPTS, def: '2' },
    ],
    run: 'gray',
  },
  {
    id: 'blueprint', name: '图纸蓝底化', desc: '转成蓝图风格的蓝底白线', icon: '🔵', cat: 'image', input: 'single',
    params: [
      { kind: 'select', key: 'dpi', label: '倍率', options: DPI_OPTS, def: '2' },
    ],
    run: 'blueprint',
  },
  {
    id: 'compress', name: '压缩优化', desc: '重建对象流或深度重排，减小体积', icon: '🗜', cat: 'image', input: 'single',
    params: [
      { kind: 'select', key: 'mode', label: '模式', options: [['light', '轻度（保留画质）'], ['deep', '深度（图片重采样）']], def: 'light' },
      { kind: 'select', key: 'dpi', label: '重采样倍率', options: DPI_OPTS, def: '2' },
    ],
    run: 'compress',
    hint: '轻度模式只重组文件结构；深度模式会重新压缩内嵌图片',
  },
  {
    id: 'flatten', name: '扁平化处理', desc: '压平表单与注释，内容不可再编辑', icon: '🧇', cat: 'image', input: 'single',
    params: [
      { kind: 'select', key: 'dpi', label: '倍率', options: DPI_OPTS, def: '2' },
    ],
    run: 'flatten',
  },

  /* ===== 标注编号（5） ===== */
  {
    id: 'text-wm', name: '文字水印', desc: '平铺或单点文字水印', icon: '💧', cat: 'mark', input: 'single',
    custom: 'wmpos', thumbs: true,
    params: [
      { kind: 'text', key: 'text', label: '水印文字', def: '机密', placeholder: '水印内容' },
      { kind: 'number', key: 'sizePt', label: '字号', def: 48, min: 6, max: 200, step: 1, unit: 'pt' },
      { kind: 'color', key: 'color', label: '颜色', def: '#888888' },
      { kind: 'number', key: 'opacity', label: '不透明度', def: 0.25, min: 0.05, max: 1, step: 0.05 },
      { kind: 'number', key: 'angle', label: '角度', def: -30, min: -90, max: 90, step: 5, unit: '°' },
      { kind: 'check', key: 'tile', label: '平铺', def: true },
      { kind: 'number', key: 'tileStepMm', label: '平铺间距', def: 60, min: 10, max: 300, step: 5, unit: 'mm' },
      { kind: 'check', key: 'bold', label: '加粗', def: false },
      RANGE_PARAM(),
    ],
    run: 'textWatermark',
    hint: '在右侧预览图上点击或拖动可调整单点水印位置',
  },
  {
    id: 'img-wm', name: '图片水印', desc: '把一张图片作为水印叠加到页面', icon: '🏷', cat: 'mark', input: 'single',
    custom: 'wmpos', thumbs: true,
    params: [
      { kind: 'number', key: 'scalePct', label: '缩放', def: 30, min: 5, max: 100, step: 1, unit: '%' },
      { kind: 'number', key: 'opacity', label: '不透明度', def: 0.3, min: 0.05, max: 1, step: 0.05 },
      { kind: 'number', key: 'angle', label: '角度', def: 0, min: -90, max: 90, step: 5, unit: '°' },
      RANGE_PARAM(),
    ],
    run: 'imageWatermark',
    hint: '先选择 PDF，再选择一张水印图片（PNG 透明背景效果最好）',
  },
  {
    id: 'seam', name: '接缝标记', desc: '页边连续小字标记，便于核对装订', icon: '🧵', cat: 'mark', input: 'single',
    params: [
      { kind: 'text', key: 'text', label: '标记文字', def: '接缝', placeholder: '逐字排在页边' },
      { kind: 'number', key: 'sizePt', label: '字号', def: 9, min: 4, max: 24, step: 0.5, unit: 'pt' },
      { kind: 'color', key: 'color', label: '颜色', def: '#999999' },
      { kind: 'number', key: 'charsPerPage', label: '每页字数', def: 8, min: 1, max: 40, step: 1 },
      { kind: 'check', key: 'fan', label: '扇形渐变', def: true },
      RANGE_PARAM(),
    ],
    run: 'seam',
    hint: '文字逐字均布在页面下边缘，扇形渐变让两端字渐变变小',
  },
  {
    id: 'annotate', name: '添加批注', desc: '高亮、下划线、方框、便签', icon: '🖊', cat: 'mark', input: 'single',
    custom: 'annotate', thumbs: true,
    params: [
      { kind: 'select', key: 'kind', label: '批注类型', options: [['highlight', '高亮'], ['underline', '下划线'], ['strikeout', '删除线'], ['square', '方框'], ['note', '便签']], def: 'highlight' },
      { kind: 'color', key: 'color', label: '颜色', def: '#ffd400' },
      { kind: 'number', key: 'opacity', label: '不透明度', def: 0.4, min: 0.05, max: 1, step: 0.05 },
      { kind: 'text', key: 'note', label: '便签内容', def: '', placeholder: '仅便签类型使用' },
    ],
    run: 'annotate',
    hint: '在预览页上按住拖动划出区域；生成的是真实 PDF 批注，阅读器里可删除',
  },
  {
    id: 'bates', name: '贝斯编号', desc: '跨文件连续编号，可合并输出', icon: '🔖', cat: 'mark', input: 'multi',
    accept: '.pdf,application/pdf',
    params: [
      { kind: 'text', key: 'prefix', label: '前缀', def: '', placeholder: '如 ABC-' },
      { kind: 'text', key: 'suffix', label: '后缀', def: '', placeholder: '可留空' },
      { kind: 'number', key: 'start', label: '起始编号', def: 1, min: 0, max: 999999, step: 1 },
      { kind: 'number', key: 'digits', label: '位数', def: 4, min: 1, max: 9, step: 1 },
      { kind: 'select', key: 'position', label: '位置', options: [['tl', '左上'], ['tc', '上中'], ['tr', '右上'], ['ml', '左中'], ['mc', '居中'], ['mr', '右中'], ['bl', '左下'], ['bc', '下中'], ['br', '右下']], def: 'bc' },
      { kind: 'number', key: 'sizePt', label: '字号', def: 9, min: 6, max: 48, step: 1, unit: 'pt' },
      { kind: 'color', key: 'color', label: '颜色', def: '#333333' },
      { kind: 'number', key: 'marginMm', label: '边距', def: 8, min: 0, max: 50, step: 1, unit: 'mm' },
      { kind: 'check', key: 'merge', label: '合并为一个文件', def: false },
      RANGE_PARAM(),
    ],
    run: 'bates',
    hint: '编号跨所有文件连续；勾选合并时额外输出一个合并文件',
  },

  /* ===== 安全信息（4） ===== */
  {
    id: 'encrypt', name: '加密文档', desc: '设置打开密码与权限密码', icon: '🔒', cat: 'secure', input: 'single',
    params: [
      { kind: 'password', key: 'userPassword', label: '打开密码', def: '', placeholder: '打开文件时需要' },
      { kind: 'password', key: 'ownerPassword', label: '权限密码', def: '', placeholder: '修改权限时需要' },
      { kind: 'check', key: 'r3', label: '128 位加密', def: true },
      { kind: 'check', key: 'printing', label: '允许打印', def: true },
      { kind: 'check', key: 'copying', label: '允许复制', def: true },
      { kind: 'check', key: 'modifying', label: '允许修改', def: true },
      { kind: 'check', key: 'annotating', label: '允许批注', def: true },
    ],
    run: 'encrypt',
    hint: '打开密码与权限密码至少填一个；未勾选的权限在读者端被限制',
  },
  {
    id: 'decrypt', name: '解除加密', desc: '移除打开密码与权限限制', icon: '🔓', cat: 'secure', input: 'single',
    params: [
      { kind: 'password', key: 'password', label: '原密码', def: '', placeholder: '打开密码（可留空尝试）' },
    ],
    run: 'decrypt',
    hint: '仅移除标准安全处理器的加密，不涉及签名证书',
  },
  {
    id: 'props', name: '文档属性', desc: '查看与编辑标题、作者等元数据', icon: '📋', cat: 'secure', input: 'single',
    custom: 'metadata',
    run: 'properties',
  },
  {
    id: 'signature', name: '签名检查', desc: '查看文档中的数字签名信息', icon: '🖋', cat: 'secure', input: 'single',
    custom: 'signature',
    run: 'signatures',
  },
];

export const TOOL_MAP: Record<string, ToolDef> = Object.fromEntries(TOOLS.map((t) => [t.id, t]));

export function defaultParams(def: ToolDef): Record<string, ParamValue> {
  const o: Record<string, ParamValue> = {};
  for (const p of def.params ?? []) o[p.key] = p.def;
  return o;
}
