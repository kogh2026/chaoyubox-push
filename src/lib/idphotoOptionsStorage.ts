/**
 * 证件照设置项落盘（`PhotoOptions` 的持久化）。
 *
 * 为什么要落盘：图文店每天开机第一件事是把「3 寸 / 蓝底 / 6 寸纸 / 2mm 间距」
 * 重新点一遍。设置项在步骤 7 已经收敛成一个可序列化对象，落盘只是把它存下来。
 *
 * 三条设计约束（都不是可选项）：
 *
 * 1. **`exportSizeIds` 刻意不落盘**。它是「这次的批量意图」，不是偏好。
 *    上次勾了 7 个规格，下次开机默认 7×N 份导出 —— 用户会以为软件疯了。
 *    读回时一律重建为 `[presetId]`（= 只导出当前规格），与 reducer 的
 *    「换主规格时并进集合」保持同一套语义。
 *
 * 2. **逐字段 normalize，不做整体信任**。存档可能来自旧版本（`PHOTO_PRESETS`
 *    少了一个规格、`PAPER_SIZES` 改了 id）、也可能被手工改坏。放任不管的话，
 *    `IdPhoto.tsx` 里 `PHOTO_PRESETS.find(...) ?? preset` 这类兜底会把
 *    「已删除的规格 id」静默解释成「当前规格」，导出的文件名和用户以为的不一致。
 *    所以每个字段独立校验：合法则用，非法则回落到**该字段的默认值**。
 *
 * 3. **不崩**。任何解析失败都退回默认值，设置错误永远不该让工具起不来。
 *
 * 本模块无 React；hook 封装在 `src/tools/usePhotoOptions.ts`。
 */

import { BG_OPTIONS } from './matting';
import { PAPER_SIZES, PHOTO_PRESETS } from './cardLayout';
import { BOTTOM_FILL_HARD_MAX, type FramingMode } from './specFraming';
import { MATTE_ENGINES, type MatteEngine } from './matteEngine';
import {
  DEFAULT_PHOTO_OPTIONS,
  type BeautyLevel,
  type PhotoOptions,
  type SheetMode,
  type WhitenLevel,
} from './idphotoOptions';
import { atomicGet, atomicSet, backupKey } from './atomicStorage';
import { PHOTO_SIZE_IDS } from './jpegSize';

/** 存储键。带版本号：字段重命名/删除时换 v2 并补迁移，不要就地改 v1 的语义 */
const KEY = 'chaoyu.idphoto.options.v1';

/**
 * 存档结构版本。
 * 注意它与 `KEY` 里的 v1 **不是一回事**：key 名是「存档格式家族」，一旦换了就读不到老用户的设置；
 * 这里的版本号是「同一份存档内部的结构/语义版本」，靠迁移函数处理，key 不动。
 */
export const CURRENT_OPTIONS_SCHEMA = 3;

/* ===== 合法取值域：全部从目录/类型派生，避免第二份真相 ===== */

const PRESET_IDS: string[] = PHOTO_PRESETS.map((p) => p.id);
const PAPER_IDS: string[] = PAPER_SIZES.map((p) => p.id);
const BG_IDS: string[] = BG_OPTIONS.map((b) => b.id);
const FRAMING_MODES: FramingMode[] = ['default', 'custom', 'spec', 'keep'];
const ENGINES: readonly MatteEngine[] = MATTE_ENGINES;
const BEAUTY_LEVELS: BeautyLevel[] = ['off', 'natural', 'standard', 'refined'];
const WHITEN_LEVELS: WhitenLevel[] = ['natural', 'rosy', 'fair', 'ultra'];
const SHEET_MODES: SheetMode[] = ['multi', 'single'];

/** `#RRGGBB`（大小写均可）；`<input type="color">` 恒产小写，但存档可能是手改的 */
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/* ===== 字段级校验器：非法一律回落默认，绝不抛错 ===== */

function asBool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def;
}

/** 数值：非有限数回落默认，越界钳到区间（钳制而非丢弃 —— 越界通常只是滑杆换过上限） */
function asNum(v: unknown, def: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, v));
}

function asEnum<T extends string>(v: unknown, domain: readonly T[], def: T): T {
  return typeof v === 'string' && (domain as readonly string[]).includes(v) ? (v as T) : def;
}

/** 目录 id：不在目录里（版本回退/手工改坏）就回落默认，不给下游「猜」的机会 */
function asId(v: unknown, domain: readonly string[], def: string): string {
  return typeof v === 'string' && domain.includes(v) ? v : def;
}

/**
 * 把任意原始值（localStorage 里的 JSON、旧版本存档、手改的垃圾）规整成合法 `PhotoOptions`。
 * 纯函数：同输入同输出，不读存储。
 */
export function normalizePhotoOptions(raw: unknown): PhotoOptions {
  const d = DEFAULT_PHOTO_OPTIONS;
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const presetId = asId(o.presetId, PRESET_IDS, d.presetId);
  const hex = typeof o.customHex === 'string' && HEX_RE.test(o.customHex) ? o.customHex : d.customHex;

  return {
    presetId,
    // 约束 1：不继承上次的多选，恒回到「只导出当前规格」
    exportSizeIds: [presetId],
    // 体积档位属于偏好（不是本次意图），照常落盘
    sizeTargetId: asId(o.sizeTargetId, PHOTO_SIZE_IDS, d.sizeTargetId),
    specMode: asEnum(o.specMode, FRAMING_MODES, d.specMode),
    fillScale: asNum(o.fillScale, d.fillScale, 1, BOTTOM_FILL_HARD_MAX),
    batchAutoFrame: asBool(o.batchAutoFrame, d.batchAutoFrame),
    engine: asEnum(o.engine, ENGINES, d.engine),
    bgId: asId(o.bgId, BG_IDS, d.bgId),
    customHex: hex,
    edgeThreshold: asNum(o.edgeThreshold, d.edgeThreshold, 0, 50),
    defringeOn: asBool(o.defringeOn, d.defringeOn),
    monoOn: asBool(o.monoOn, d.monoOn),
    postureOn: asBool(o.postureOn, d.postureOn),
    beautyLevel: asEnum(o.beautyLevel, BEAUTY_LEVELS, d.beautyLevel),
    advOn: asBool(o.advOn, d.advOn),
    advSmooth: asNum(o.advSmooth, d.advSmooth, 0, 100),
    advShine: asNum(o.advShine, d.advShine, 0, 100),
    advEye: asNum(o.advEye, d.advEye, 0, 100),
    whitenOn: asBool(o.whitenOn, d.whitenOn),
    whitenLevel: asEnum(o.whitenLevel, WHITEN_LEVELS, d.whitenLevel),
    brightness: asNum(o.brightness, d.brightness, -50, 50),
    paperId: asId(o.paperId, PAPER_IDS, d.paperId),
    sheetMode: asEnum(o.sheetMode, SHEET_MODES, d.sheetMode),
    gapMm: asNum(o.gapMm, d.gapMm, 0, 10),
    sizeMark: asBool(o.sizeMark, d.sizeMark),
    guideOn: asBool(o.guideOn, d.guideOn),
  };
}

/** 默认值的独立副本：避免把模块级常量对象交出去后被就地改坏 */
function defaultOptions(): PhotoOptions {
  return { ...DEFAULT_PHOTO_OPTIONS, exportSizeIds: [...DEFAULT_PHOTO_OPTIONS.exportSizeIds] };
}

/** 读存档里的结构版本；缺字段的老存档按 v1 处理（那时候还没有这两个新默认） */
function schemaVersionOf(raw: unknown): number {
  const v =
    raw && typeof raw === 'object' ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : 1;
}

/**
 * 存档迁移：v1 → v2 → v3。
 *
 * v2 改了两项**默认值**：抠图质量 `isnet → modnet`（快速）、去边缘强调默认开。
 * 默认值改在代码里是没用的 —— 老用户存档里存着旧值，`normalizePhotoOptions` 会照旧读回来，
 * 表现就是「代码改了、装上新版还是精细」。所以升级时把这两项一次性归位到新默认。
 *
 * v3 把「精细（ISNet）」换成了「MODNet + 边缘精修」（`modnet-refine`）：
 * 实测 ISNet 在证件照上反而更差（IoU 0.9788 vs MODNet 0.9984，12/51 张 < 0.90），
 * 而边缘精修能解决真正的痛点（发丝处残留原底色）。
 * 老存档里的 `isnet` 归一到 `modnet-refine` —— 用户当初要的是「更精细」，
 * 新方案同样是「更精细」，只是换了个更好的实现方式，**不擅自推翻用户的选择**。
 *
 * 只动这两项：规格 / 底色 / 纸张 / 间距等**用户真正表达过的偏好**一律保留。
 */
function migrateFrom(version: number, opts: PhotoOptions): PhotoOptions {
  if (version >= 3) return opts;
  const v2 = version >= 2
    ? opts
    : {
        ...opts,
        engine: DEFAULT_PHOTO_OPTIONS.engine,
        defringeOn: DEFAULT_PHOTO_OPTIONS.defringeOn,
      };
  if (v2.engine === 'isnet') {
    return { ...v2, engine: 'modnet-refine' };
  }
  return v2;
}

/**
 * 读存档。无存档 / 解析失败 / 非浏览器环境 → 出厂默认。
 * 主 key 损坏时 `atomicGet` 自动回退上一版（`.bak`）。
 */
export function loadPhotoOptions(): PhotoOptions {
  if (typeof localStorage === 'undefined') return defaultOptions();
  const raw = atomicGet(KEY);
  if (raw == null) return defaultOptions();
  try {
    const parsed: unknown = JSON.parse(raw);
    const ver = schemaVersionOf(parsed);
    const opts = migrateFrom(ver, normalizePhotoOptions(parsed));
    // 迁移结果立刻写回：否则每次启动都要重跑一次迁移，而且「面板显示的默认」与存档内容长期不一致
    if (ver < CURRENT_OPTIONS_SCHEMA) {
      try {
        savePhotoOptions(opts);
      } catch {
        /* 写回失败不影响本次使用（配额满/隐私模式），下次启动再试 */
      }
    }
    return opts;
  } catch {
    return defaultOptions();
  }
}

/** 落盘时剥掉不持久化的字段（`exportSizeIds`）；单独导出便于单测与「是否有改动」比较 */
export function toPersisted(o: PhotoOptions): Omit<PhotoOptions, 'exportSizeIds'> {
  const { exportSizeIds, ...rest } = o;
  void exportSizeIds; // 刻意丢弃：见文件头约束 1
  return rest;
}

/** 写存档（原子写 + 备份上一版）。写失败抛错由调用方决定——本模块不吞配额错误 */
export function savePhotoOptions(o: PhotoOptions): void {
  if (typeof localStorage === 'undefined') return;
  atomicSet(KEY, JSON.stringify({ schemaVersion: CURRENT_OPTIONS_SCHEMA, ...toPersisted(o) }));
}

/** 清存档（主 key + 备份）：恢复默认时调用，确保下次启动拿到的是出厂值而不是「上次的默认」 */
export function clearPhotoOptions(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(KEY);
  localStorage.removeItem(backupKey(KEY));
}

/**
 * 是否全为出厂默认（决定「恢复默认」按钮是否可点）。
 * 只比较落盘字段：`exportSizeIds` 本来就不存，它变化不算「改动过设置」。
 */
export function isDefaultPhotoOptions(o: PhotoOptions): boolean {
  const d = DEFAULT_PHOTO_OPTIONS;
  return (Object.keys(d) as (keyof PhotoOptions)[]).every(
    (k) => k === 'exportSizeIds' || o[k] === d[k],
  );
}
