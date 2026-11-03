/**
 * 证件照「设置项」收敛：25 个独立 `useState` → 一个可序列化对象 + 纯 reducer。
 *
 * 为什么收敛（拆分方案步骤 7）：
 * - 原先 25 个 option 散在组件里，任何「一键切换预设 / 恢复默认 / 记住上次选择」都得逐个改；
 * - 默认值散落在各处 `useState(初始值)`，没有单点真相，「默认档 = 自然 / 纸 r6 / 间距 2mm」
 *   这种口径只能靠人肉阅读组件才能确认；
 * - 右栏为了拿这些值 + 各自 setter，宽度到 63 个 prop —— 收敛后传 `options` + `setOption`。
 *
 * 边界（重要）：只收「影响产出的配置」。运行时状态（items / checked / results / busy /
 * progress / saveMsg / errors / placements / framingId / frameMode / activeFraming / issues /
 * dragOver / sheets / matteVer）留在组件，`manualOpen`（折叠区展开态）与 `tab` 也留 ——
 * 它们不是配置，塞进来会让「可序列化、可快照、可持久化」的目标名存实亡。
 *
 * 本模块无 React、无 DOM：`usePhotoOptions`（hooks 封装）在 `src/tools/usePhotoOptions.ts`，
 * 这样 reducer 能在 node 下直接测。
 */

import type { FramingMode } from './specFraming';
import { DEFAULT_MATTE_ENGINE, type MatteEngine } from './matteEngine';

/** 经典美颜档位（数值表仍在 `IdPhoto.tsx`，因为要算像素强度） */
export type BeautyLevel = 'off' | 'natural' | 'standard' | 'refined';
/** 美白档位 */
export type WhitenLevel = 'natural' | 'rosy' | 'fair' | 'ultra';
/** 排版方式：一人一版 / 自动铺满 */
export type SheetMode = 'multi' | 'single';

/**
 * 全部设置项。字段顺序按右栏面板的视觉顺序排（规格 → 构图 → 抠图 → 人像优化 → 排版），
 * 这样「面板上有什么」与「options 里有什么」能一眼对齐。
 */
export interface PhotoOptions {
  // ---- 1. 照片规格 ----
  /** 当前预览/主导出规格 id（PHOTO_PRESETS） */
  presetId: string;
  /** 同时导出的规格集合（多选，恒 ≥1） */
  exportSizeIds: string[];
  /**
   * 单张输出体积档位（PHOTO_SIZE_PRESETS）。默认 `none` = 不限制；
   * 选 `20~200 KB` 等档位时导出会对超限的 JPEG 二分 quality 重编码（见 lib/jpegSize.ts）。
   */
  sizeTargetId: string;
  // ---- 2. 人像构图 ----
  /** 规格构图模式：默认 / 自定义 / 按规格 / 保持原图 */
  specMode: FramingMode;
  /** 自定义构图的放大填满系数（1..1.35） */
  fillScale: number;
  /** 批量默认启用自动构图（抠图完成后自动按规格构图） */
  batchAutoFrame: boolean;
  // ---- 3. 背景与抠图 ----
  /** 抠图引擎：精细 ISNet / 快速 MODNet */
  engine: MatteEngine;
  /** 底色 id（BG_OPTIONS） */
  bgId: string;
  /** 自定义底色（#RRGGBB） */
  customHex: string;
  /** 发丝边缘阈值（0..50） */
  edgeThreshold: number;
  /** 去晕边：把彩色底外沿的发丝色晕中和掉 */
  defringeOn: boolean;
  /** 黑白照片：整图灰度 */
  monoOn: boolean;
  /** 体态纠正：本地版暂不支持（入口占位） */
  postureOn: boolean;
  // ---- 4. 人像优化 ----
  /** 经典美颜档位 */
  beautyLevel: BeautyLevel;
  /** 专业匀肤开关（与经典美颜互斥） */
  advOn: boolean;
  /** 专业匀肤三档（0..100） */
  advSmooth: number;
  advShine: number;
  advEye: number;
  /** 美白开关 */
  whitenOn: boolean;
  /** 美白档位 */
  whitenLevel: WhitenLevel;
  /** 亮度（-50..50） */
  brightness: number;
  // ---- 5. 多张排版 ----
  /** 相纸尺寸 id（PAPER_SIZES） */
  paperId: string;
  /** 排版方式 */
  sheetMode: SheetMode;
  /** 照片间隔（mm） */
  gapMm: number;
  /** 排版/预览叠加尺寸标注 */
  sizeMark: boolean;
  /** 预览叠加人像定位线 */
  guideOn: boolean;
}

/**
 * 出厂默认值 —— **默认档的唯一真相**。
 * 几处刻意的默认（都有产品理由，单测钉住）：
 * - `engine: DEFAULT_MATTE_ENGINE`（= 快速 MODNet）：默认值只有 `matteEngine.ts` 那一处真相，
 *   抠图池的初始引擎也引同一个常量，避免「面板显示快速、实际跑精细」；
 *   图文店一次导几十张，MODNet 比 ISNet 快约 6 倍（实测 50 张 45s vs 288s），
 *   而卡住两分钟是当场就能感觉到的；要更精细的去面板切「精细」。
 * - `defringeOn: true`：**去边缘默认开**。白底转蓝底时发丝外沿的彩色光圈最显眼，
 *   默认关掉的话用户得先发现有一条彩边、再去面板找开关；
 * - `beautyLevel: 'natural'`：美颜默认「自然」档（与爱印一致，可选默认档）；
 * - `paperId: 'r6'` / `gapMm: 2`：6 寸相纸 + 2mm 间隔，证件照排版最常用；
 * - `batchAutoFrame: true`：批量抠完即按规格构图，省掉「忘了点自动构图」的常见失误。
 */
export const DEFAULT_PHOTO_OPTIONS: PhotoOptions = {
  presetId: '1cun',
  exportSizeIds: ['1cun'],
  /** 不限制输出体积：保持既有导出行为，需要卡体积时用户手动选档 */
  sizeTargetId: 'none',
  specMode: 'default',
  fillScale: 1,
  batchAutoFrame: true,
  engine: DEFAULT_MATTE_ENGINE,
  bgId: 'white',
  customHex: '#ffffff',
  edgeThreshold: 30,
  defringeOn: true,
  monoOn: false,
  postureOn: false,
  beautyLevel: 'natural',
  advOn: false,
  advSmooth: 60,
  advShine: 35,
  advEye: 25,
  whitenOn: false,
  whitenLevel: 'natural',
  brightness: 0,
  paperId: 'r6',
  sheetMode: 'multi',
  gapMm: 2,
  /** 大图左右/底部的 mm · px 标尺（同爱印常显）：用户第一眼就能确认「这真的是 25×35」 */
  sizeMark: true,
  guideOn: false,
};

/**
 * 一次改一个键。`value` 用联合类型（而非 unknown）是为了让 reducer 里不出现 `any`；
 * 调用侧的键值配对由 `SetPhotoOption` 的泛型守住（键与值类型不匹配时 tsc 直接报错）。
 */
export type PhotoOptionsAction =
  | { type: 'set'; key: keyof PhotoOptions; value: PhotoOptions[keyof PhotoOptions] }
  /** 一次改多个（预设套用 / 迁移 / 恢复局部） */
  | { type: 'patch'; patch: Partial<PhotoOptions> }
  /** 换主规格时把它并进导出集合（幂等） */
  | { type: 'add-size'; id: string }
  /** 勾/取消一个导出规格（恒保留至少一个） */
  | { type: 'toggle-size'; id: string }
  | { type: 'reset' };

/**
 * 设置项 reducer。纯函数：不读外部状态、不改入参、同输入同输出。
 *
 * 两条不变量写在这里而不是 JSX 里（原先散在两个 onChange 中，没有测试）：
 * - `add-size` 幂等：已在集合里就原样返回（**返回同一引用**，不触发多余渲染）；
 * - `toggle-size` 恒保留至少一个：取消最后一个勾选直接无效。
 */
export function photoOptionsReducer(state: PhotoOptions, action: PhotoOptionsAction): PhotoOptions {
  switch (action.type) {
    case 'set':
      return { ...state, [action.key]: action.value } as PhotoOptions;

    case 'patch':
      return { ...state, ...action.patch };

    case 'add-size':
      return state.exportSizeIds.includes(action.id)
        ? state
        : { ...state, exportSizeIds: [...state.exportSizeIds, action.id] };

    case 'toggle-size': {
      if (!state.exportSizeIds.includes(action.id)) {
        return { ...state, exportSizeIds: [...state.exportSizeIds, action.id] };
      }
      // 至少保留一个，否则「同时导出尺寸」无意义
      if (state.exportSizeIds.length <= 1) return state;
      return { ...state, exportSizeIds: state.exportSizeIds.filter((x) => x !== action.id) };
    }

    case 'reset':
      // exportSizeIds 必须拷贝：否则组件后续 toggle 会顺着引用改掉 DEFAULT_PHOTO_OPTIONS
      return { ...DEFAULT_PHOTO_OPTIONS, exportSizeIds: [...DEFAULT_PHOTO_OPTIONS.exportSizeIds] };
  }
}

/** 单键 setter 的类型：键与值强绑定（`setOption('gapMm', 'x')` 会在 tsc 阶段报错） */
export type SetPhotoOption = <K extends keyof PhotoOptions>(key: K, value: PhotoOptions[K]) => void;
