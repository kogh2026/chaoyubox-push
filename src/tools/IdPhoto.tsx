import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BoundedCache } from '../lib/boundedCache';
import { useHotkeyActions } from '../lib/hotkeys';
import { presetPrintOpts, printPdfBytes } from '../lib/printers';
import {
  BG_OPTIONS,
  cachedMatte,
  clearMatteCache,
  buildPersonLayer,
  compositeLayer,
  personLayerKey,
  blobToImage,
  mmToPx,
  type BgOption,
  type PersonLayer,
  type Placement,
  type RetouchOpts,
} from '../lib/matting';
import {
  bytesOf,
  saveBatch,
  saveBytes,
  batchMessage,
  outcomeMessage,
  revealIfWanted,
} from '../lib/exporter';
import { poolMatte, setMatteEngine, type MatteEngine } from '../lib/mattingPool';
import { fitJpegBlob, sizeTargetName, sizeTargetOf } from '../lib/jpegSize';
import {
  inspectAll,
  framingMetrics,
  meanLuminance,
  edgeColorStd,
  type PhotoIssue,
} from '../lib/photoInspect';
import {
  PAPER_SIZES,
  PHOTO_PRESETS,
  DEFAULT_DPI,
  computeLayout,
  buildSheetImages,
  renderPreview,
  framingSpecOf,
  type CanvasLike,
  type PaperSize,
  type PhotoPreset,
} from '../lib/cardLayout';
import { exportSheetPdf } from '../lib/sheetPdf';
import { withJpegDpi } from '../lib/dpiTag';
import { composeMany, exportLayerKey, memoRetouch, previewLayerKey } from '../lib/idphotoCompose';
import { retouchPhotoBlob, summarizeRetouch } from '../lib/idphotoRetouchDom';
import { detectFaces } from '../lib/faceDetect';
import { headFromFace } from '../lib/faceFrame';
import { segmentPersonLowerBody } from '../lib/selfieMulticlassMask';
import {
  ensureFrames,
  personBottomFrac,
  placementForFrame,
  planPlacements,
  type FramingDeps,
  type FramingFrame,
  type FramingTarget,
} from '../lib/idphotoFramingFlow';
import {
  computeMetrics,
  verifyFraming,
  type FramingSpec,
  type FramingMetrics,
  type FramingVerification,
} from '../lib/specFraming';
import FramingEditor from './FramingEditor';
import IdPhotoLeft from './IdPhotoLeft';
import IdPhotoCenter from './IdPhotoCenter';
import IdPhotoRight from './IdPhotoRight';
import { usePhotoOptions } from './usePhotoOptions';
import { isDefaultPhotoOptions } from '../lib/idphotoOptionsStorage';
import type { ComposeResult, PhotoItem } from './idphotoTypes';

/** 美白档位 → 提亮强度（仅作用于人像区域），集中成常量避免散落字面量 */
const WHITEN_LEVELS: Record<string, number> = {
  natural: 0.15,
  rosy: 0.22,
  fair: 0.35,
  ultra: 0.5,
};

/** 保真美颜档位 → 平滑强度（0=关），皮肤自适应表面模糊，高细节不动、保真不变形 */
const BEAUTY_LEVELS: Record<string, number> = {
  off: 0,
  natural: 0.35,
  standard: 0.55,
  refined: 0.75,
};

const SHEET_MARGIN_MM = 5;
const PREVIEW_SCALE = 3.4;
/** 人物层缓存上限（条）：1 寸人物层约 0.5MB，120 条约 60MB，足够覆盖「多规格 × 多次调参」的复用 */
const LAYER_CACHE_MAX = 120;
/** 下半身分割的预缩上限：模型输入即 256，缩到 ≤512 足够且省内存（原 ensureFrameData 内联值） */
const SEG_MAX = 512;

/** `PhotoItem` → 构图流输入：只挑「能当缓存键的 id」与「能加载原图的 url」两件事 */
const toFramingTarget = (it: PhotoItem): FramingTarget => ({ id: it.id, url: it.url });

// 专业匀肤三档的默认值（60 / 35 / 25）随 25 个设置项一起收敛进
// `lib/idphotoOptions.ts` 的 DEFAULT_PHOTO_OPTIONS，这里不再保留第二份默认值。

// ---------- 演示照片：默认使用两张真实人像，展现真实换底效果 ----------
// 以模块方式引入（Vite 生成可移植资源 URL，打包后 Electron 也能正确加载）；
// 加载失败时回退到本地绘制的"人像剪影"，保证无网络/测试环境也能演示。
import demoPhoto1 from '../assets/demo/photo1.png?url';
import demoPhoto2 from '../assets/demo/photo2.png?url';

/** 演示照片资源 URL 顺序（与下方"演示照片"卡片一一对应） */
export const DEMO_URLS: string[] = [demoPhoto1, demoPhoto2];

/**
 * 拉取一张演示照片并打包成可处理的 File。
 * 任意环节失败（如打包环境 fetch 受限）回退到本地绘制的剪影，避免按钮失效。
 */
export async function loadDemoPhoto(variant: number): Promise<Blob> {
  const url = DEMO_URLS[variant] ?? DEMO_URLS[0];
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`演示图 HTTP ${res.status}`);
    return await res.blob();
  } catch {
    return canvasToBlob(drawDemoCanvas(variant));
  }
}

// ---------- 演示照片：绘制一个本地生成的"人像剪影"，返回真实 JPEG 文件 ----------
// 仅作为真实演示图加载失败时的兜底，并导出供单元测试（带 canvas 环境时）复用
export function drawDemoCanvas(variant: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 420;
  c.height = 560;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, c.height);
  if (variant === 0) {
    g.addColorStop(0, '#cfd8e3');
    g.addColorStop(1, '#9fb0c2');
  } else {
    g.addColorStop(0, '#e8ddd2');
    g.addColorStop(1, '#c2b3a4');
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  const skin = variant === 0 ? '#e8c8a8' : '#d9b090';
  const shirt = variant === 0 ? '#37465c' : '#7a4a3f';
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.ellipse(c.width / 2, 210, 92, 112, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = variant === 0 ? '#2a2320' : '#4a3325';
  ctx.beginPath();
  ctx.ellipse(c.width / 2, 158, 96, 74, 0, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = shirt;
  ctx.beginPath();
  ctx.ellipse(c.width / 2, 520, 170, 130, 0, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.95): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('画布导出失败'))),
      type,
      quality,
    );
  });
}

// ---------- P2：异常检测用的图像采样（DOM 依赖，仅在浏览器运行；测试不触发） ----------
function loadImage(src: string | Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const isStr = typeof src === 'string';
    const url = isStr ? src : URL.createObjectURL(src);
    const img = new Image();
    const clean = () => {
      if (!isStr) URL.revokeObjectURL(url);
    };
    img.onload = () => {
      clean();
      resolve(img);
    };
    img.onerror = () => {
      clean();
      reject(new Error('图像加载失败'));
    };
    img.src = url;
  });
}

/** 把原图降采样到 ≤256px，提取灰度均值与四边颜色标准差（曝光/背景检测用） */
function sampleOriginal(img: HTMLImageElement): { w: number; h: number; meanL: number; edgeStd: number } {
  const w = Math.min(img.naturalWidth || 256, 256);
  const h = Math.max(1, Math.round((img.naturalHeight || w) * (w / (img.naturalWidth || w))));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  return { w, h, meanL: meanLuminance(d), edgeStd: edgeColorStd(d, w, h) };
}

/** 把抠图蒙版降采样到 ≤128px，提取 alpha 通道（构图/角度检测用） */
function sampleAlpha(img: HTMLImageElement): { w: number; h: number; alpha: Uint8ClampedArray } {
  const w = Math.min(img.naturalWidth || 128, 128);
  const h = Math.max(1, Math.round((img.naturalHeight || w) * (w / (img.naturalWidth || w))));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const alpha = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < alpha.length; i++, p += 4) alpha[i] = d[p + 3];
  return { w, h, alpha };
}

/** 把演示照片打包成一张真实可处理的照片（file + 预览 URL），演示"先试一张"时即走真实抠图/换底链路 */
export async function createDemoItem(variant: number, nextId: () => string): Promise<PhotoItem> {
  const blob = await loadDemoPhoto(variant);
  const file = new File([blob], `示例照片${variant + 1}.jpg`, { type: blob.type || 'image/jpeg' });
  return { id: nextId(), file, url: URL.createObjectURL(blob) };
}

export default function IdPhoto() {
  // 设置项（25 个）收敛成一个可序列化对象（拆分方案步骤 7）。运行时状态仍各自 useState。
  // 读侧在这里解构出别名，让下面几百行的引用逐字保持原样 —— diff 只落在 setter 调用点。
  const { options, setOption, addExportSize, toggleExportSize, resetOptions } = usePhotoOptions();
  const {
    presetId,
    exportSizeIds,
    sizeTargetId,
    specMode,
    fillScale,
    batchAutoFrame,
    bgId,
    customHex,
    edgeThreshold,
    defringeOn,
    monoOn,
    beautyLevel,
    advOn,
    advSmooth,
    advShine,
    advEye,
    whitenOn,
    whitenLevel,
    brightness,
    paperId,
    sheetMode,
    gapMm,
    sizeMark,
    guideOn,
  } = options;

  /** 是否全为出厂默认 → 决定「恢复默认」按钮是否可点（比较的是落盘字段，见 storage 模块） */
  const isDefaultOptions = isDefaultPhotoOptions(options);

  // ---- 以下为运行时状态：不可序列化 / 每次交互都变，不属于「设置项」 ----
  const [items, setItems] = useState<PhotoItem[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  /**
   * 「当前查看哪一张」—— 与 `checked`（导出范围）是两个独立概念，这是参考爱印后
   * 补上的那层：左栏点行体换主预览，勾选框只决定导出哪些，两者互不牵连。
   * null 表示还没选中，`activeItem` 会回落到列表第一张。
   */
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tab, setTab] = useState<'photo' | 'sheet'>('photo');
  const [advMsg, setAdvMsg] = useState('');
  const [manualOpen, setManualOpen] = useState(false); // 「手动微调」折叠区（美白等）
  const [results, setResults] = useState<ComposeResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  // 导出结果提示：不随 busy 结束而消失（原 progress 只在处理中显示，导出完就看不见了）
  const [saveMsg, setSaveMsg] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  // P3：取景微调偏移（目标像素）+ 旋转角（度），按 id 存储；不传则用默认居中
  const [placements, setPlacements] = useState<Record<string, { dx: number; dy: number; zoom?: number; rotation?: number }>>({});
  const [framingId, setFramingId] = useState<string | null>(null);
  // 构图模式：default=整图居中；auto=已按人脸自动构图（逐张 placements）
  const [frameMode, setFrameMode] = useState<'auto' | 'default'>('default');
  const [activeFraming, setActiveFraming] = useState<{
    metrics?: FramingMetrics;
    verification?: FramingVerification;
    /** 下半身分割是否命中（决定「下方不足」判定是实测还是整图近似） */
    segmented?: boolean;
    /** 本次是否真的触发了放大填满 */
    fillApplied?: boolean;
  }>({});
  // P2：异常照片检测结果（按 id）→ 缩略图角标 + 原因提示
  const [issues, setIssues] = useState<Record<string, PhotoIssue[]>>({});
  const inspected = useRef<Set<string>>(new Set());
  const lastPx = useRef({ w: 0, h: 0 });
  const [dragOver, setDragOver] = useState(false);
  const [sheets, setSheets] = useState<CanvasLike[]>([]);

  const idSeq = useRef(0);
  const nextId = useCallback(() => `p${++idSeq.current}`, []);
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  /**
   * 人物层缓存（第 5 轮批量提速）：键 = id|匀肤参数|像素级参数指纹。
   * 换底色/换纸张/改排版都只重新合层，不再重做去晕边/阈值/美白等逐像素运算。
   * 改用 BoundedCache：批量上百张时把人物层内存钉在 256 条上限内（LRU 淘汰），
   * 避免长任务内存随照片数线性增长。
   */
  const layerCache = useRef(new BoundedCache<string, PersonLayer>(256));
  /**
   * 抠图结果按 id 缓存：规格/底色变化无需重跑模型。
   * 同样带上限（128 条）：抠图 Blob 每张数百 KB~数 MB，长任务不能无限累积。
   * onEvict 级联删掉该照片的人物层（层依赖这张抠图，抠图被淘汰层也没用了）。
   */
  const matteCache = useRef(
    new BoundedCache<string, Blob>(128, (k) => layerCache.current.deletePrefix(`${k}|`)),
  );
  /** 已有成品的 id 集合（与 results 同步的 ref）：合成前用它判断「这张还缺成品」，避免重算整批 */
  const resultIds = useRef<Set<string>>(new Set());
  /** 影响成品的参数指纹：没变就只补缺的照片（抠图逐张完成时的高频路径） */
  const composeSig = useRef('');
  /**
   * 每张照片的「构图输入」缓存：人脸几何 + 下半身分割结果。
   * 自动构图、批量默认构图、多尺寸导出都复用，避免重复跑人脸检测与分割（一次/张）。
   * 改 BoundedCache（96 条上限）：FramingFrame 含人脸/分割浮点数组，长任务不可无限增长。
   */
  const frameData = useRef(new BoundedCache<string, FramingFrame>(96));
  const [mattesVer, setMattesVer] = useState(0);
  /** 预览缩略图（演示卡）直接用演示照片资源 URL，无需重绘 */
  const demoThumbs = useMemo(() => DEMO_URLS, []);

  const preset: PhotoPreset = useMemo(
    () => PHOTO_PRESETS.find((p) => p.id === presetId) ?? PHOTO_PRESETS[0],
    [presetId],
  );
  const paper: PaperSize = useMemo(
    () => PAPER_SIZES.find((p) => p.id === paperId) ?? PAPER_SIZES[0],
    [paperId],
  );
  const bg: BgOption = useMemo(
    () => BG_OPTIONS.find((b) => b.id === bgId) ?? BG_OPTIONS[0],
    [bgId],
  );

  const retouch: RetouchOpts = useMemo(() => {
    return {
      bg: bg.id === 'custom' ? { ...bg, hex: customHex } : bg,
      whiten: whitenOn ? WHITEN_LEVELS[whitenLevel] : 0,
      warm: whitenOn && whitenLevel === 'rosy' ? 0.2 : 0,
      brightness,
      edgeThreshold,
      defringe: defringeOn ? 0.7 : 0,
      // 专业档接管平滑：经典美颜强制 0，避免两套平滑串联
      beauty: advOn ? 0 : BEAUTY_LEVELS[beautyLevel],
    };
  }, [bg, customHex, whitenOn, whitenLevel, brightness, edgeThreshold, defringeOn, beautyLevel, advOn]);

  /** 三档参数（0..1）；专业档关闭时全 0 → 适配层直接返回原图，零开销 */
  const advOpts = useMemo(
    () => ({
      smoothing: advOn ? advSmooth / 100 : 0,
      shine: advOn ? advShine / 100 : 0,
      underEye: advOn ? advEye / 100 : 0,
    }),
    [advOn, advSmooth, advShine, advEye],
  );
  /** 匀肤参数指纹：参与人物层缓存键（匀肤会改变人物层像素，必须区分） */
  const advKey = useMemo(() => `${advOpts.smoothing.toFixed(3)},${advOpts.shine.toFixed(3)},${advOpts.underEye.toFixed(3)}`, [advOpts]);

  // ---------- 派生：当前查看的照片 / 成品 / 导出范围 ----------
  /** 当前查看的照片：选中项失效（被移除、还没选）时回落到列表第一张，中栏永远有主预览 */
  const activeItem = useMemo(
    () => items.find((it) => it.id === activeId) ?? items[0] ?? null,
    [items, activeId],
  );
  const activeIndex = activeItem ? items.findIndex((it) => it.id === activeItem.id) : -1;
  /** 当前照片的成品（换底后 JPEG）；null = 还没出片 —— 中栏据此在「大图」与「原图+进度」间切换 */
  const activeResult = useMemo(
    () => (activeItem ? results.find((r) => r.id === activeItem.id) ?? null : null),
    [results, activeItem],
  );
  const activeError = activeItem ? errors[activeItem.id] ?? '' : '';
  /** 已勾选且有成品的张数：底部「将导出 N 张」与右栏估算都用它（未被勾选的不该算进去） */
  const picked = useMemo(() => results.filter((r) => checked.has(r.id)), [results, checked]);
  /** id → 成品 URL：左栏缩略图优先显示换底后的样子（同爱印），没有则退回原图 */
  const resultUrls = useMemo(() => {
    const m: Record<string, string> = {};
    for (const r of results) m[r.id] = r.url;
    return m;
  }, [results]);

  /** 面板接线用的别名（`verify:wiring` 要求 `name={name}` 自接线，不接受表达式） */
  const total = items.length;
  /** 标尺用短名（「1寸」而不是「1寸 25×35」）：毫米已经在后面写了，别重复 */
  const presetName = preset.name.split(' ')[0];
  const presetW = preset.w;
  const presetH = preset.h;
  const exportCount = picked.length;
  /** 底部状态栏的失败计数：有失败就该在「开始导出」旁边被看见，而不是靠用户翻左栏 */
  const failCount = Object.keys(errors).length;

  /** 上一张 / 下一张（循环） */
  const stepPhoto = useCallback(
    (dir: -1 | 1) => {
      setActiveId((cur) => {
        if (items.length === 0) return cur;
        const i = items.findIndex((it) => it.id === cur);
        const j = i < 0 ? 0 : (i + dir + items.length) % items.length;
        return items[j].id;
      });
    },
    [items],
  );

  // 选中项失效（被移除）或首次导入后自动选中第一张：保证「当前照片」始终指向存在的项
  useEffect(() => {
    if (items.length === 0) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (!activeId || !items.some((it) => it.id === activeId)) setActiveId(items[0].id);
  }, [items, activeId]);


  // 抠图引擎切换：同步全局（mattingPool）+ 清空 matte 缓存（同图不同引擎结果不同）
  const onEngineChange = useCallback(
    (next: MatteEngine) => {
      setOption('engine', next);
      setMatteEngine(next);
      clearMatteCache();
      layerCache.current.clear(); // 引擎换了 → 人物层像素来源变了
    },
    [setOption],
  );

  // 设置项会跨会话保留，但 `mattingPool` 的引擎是**模块级变量**（默认恒 isnet），
  // 不走 onEngineChange 就不会被纠正。不同步的话，上次选了「快速」的用户这次开机
  // 面板显示「快速」、实际仍跑精细 ISNet —— 批量 50 张会从 45s 变 288s 且无处可查。
  // 只在挂载跑一次：之后的变更都由 onEngineChange 负责。
  useEffect(() => {
    setMatteEngine(options.engine);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pxW = mmToPx(preset.w, 300);
  const pxH = mmToPx(preset.h, 300);
  // 当前尺寸的构图规格（topRatio/headRatio/safeRatio），喂给 specAutoPlacement / 面板。
  // 与自动构图、多尺寸导出共用 cardLayout.framingSpecOf，避免同一份默认比例写两遍。
  const framingSpec: FramingSpec = useMemo(() => framingSpecOf(preset, 300), [preset]);
  const layout = useMemo(
    () => computeLayout(paper.w, paper.h, preset.w, preset.h, SHEET_MARGIN_MM, gapMm),
    [paper, preset, gapMm],
  );

  // ---------- 导入：统一入口，自动全选新增项 ----------
  const addItems = useCallback((newItems: PhotoItem[]) => {
    setItems((prev) => {
      const next = [...prev, ...newItems];
      setChecked(new Set(next.map((it) => it.id)));
      return next;
    });
  }, []);

  const addFiles = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return;
      const imgs = Array.from(list).filter((f) => f.type.startsWith('image/'));
      if (imgs.length === 0) return;
      addItems(imgs.map((file) => ({ id: nextId(), file, url: URL.createObjectURL(file) })));
    },
    [addItems, nextId],
  );

  const removeItem = useCallback((id: string) => {
    setItems((prev) => {
      const target = prev.find((it) => it.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((it) => it.id !== id);
    });
    setChecked((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    matteCache.current.delete(id);
    layerCache.current.deletePrefix(`${id}|`);
    frameData.current.delete(id);
    inspected.current.delete(id);
    setIssues((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
    setErrors((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
  }, []);

  const clearAll = useCallback(() => {
    items.forEach((it) => URL.revokeObjectURL(it.url));
    matteCache.current.clear();
    layerCache.current.clear();
    inspected.current.clear();
    setItems([]);
    setChecked(new Set());
    setResults([]);
    setSheets([]);
    setErrors({});
    setIssues({});
  }, [items]);

  const toggleAll = useCallback(() => {
    setChecked((prev) =>
      prev.size === items.length && items.length > 0
        ? new Set<string>()
        : new Set(items.map((it) => it.id)),
    );
  }, [items]);

  const loadDemo = useCallback(async () => {
    setBusy(true);
    setProgress('生成演示照片…');
    try {
      const demos = await Promise.all([0, 1].map((v) => createDemoItem(v, nextId)));
      addItems(demos);
    } finally {
      setBusy(false);
      setProgress('');
    }
  }, [addItems, nextId]);

  useEffect(() => {
    resultIds.current = new Set(results.map((r) => r.id));
  }, [results]);

  // ---------- 抠图（按 id 缓存；失败记入 errors 而非静默跳过） ----------
  // P1：由"主线程串行 for 循环"改为"并发派发到 Worker 池"——所有任务一次性入队，
  // 池内至多 MAX_MATTE 个 Worker 同时推理，主线程只负责投递与回收，不再被 WASM 卡住。
  useEffect(() => {
    const todo = items.filter((it) => !matteCache.current.has(it.id));
    if (todo.length === 0) return;
    let cancelled = false;
    let done = 0;
    // 进度节流：@imgly 每张会上报多个阶段，50 张累计数百次 setState → 整表重渲染数百次。
    // 5 次/秒足够表达进度，渲染开销降到 1/10。
    let lastTick = 0;
    const tick = (msg: string, force = false) => {
      const now = performance.now();
      if (!force && now - lastTick < 200) return;
      lastTick = now;
      setProgress(msg);
    };
    /**
     * 「逐张出片」通知：每完成一张就 +1，让左栏该行从「抠图中…」翻成成品缩略图、
     * 中栏也能尽早显示当前照片。节流 300ms（合成侧只补缺的那张，代价 ≈ 一次合层），
     * 否则 50 张会触发 50 轮渲染。最后一张必刷。
     */
    let lastBump = 0;
    const bump = (force = false) => {
      const now = performance.now();
      if (!force && now - lastBump < 300) return;
      lastBump = now;
      setMattesVer((v) => v + 1);
    };
    (async () => {
      setBusy(true);
      setProgress(`正在处理 ${todo.length} 张照片…`);
      const jobs = todo.map((it) => (async () => {
        if (cancelled) return;
        try {
          const blob = await cachedMatte(
            it.file,
            // 不暴露引擎内部下载/URL key（如 fetch:/models/…），只显示友好进度
            () => tick(`正在抠图 ${done + 1}/${todo.length}…`),
            poolMatte,
          );
          if (cancelled) return;
          matteCache.current.set(it.id, blob);
          done += 1;
          tick(`抠图完成 ${done}/${todo.length}`, done === todo.length);
          bump(done === todo.length);
        } catch {
          if (cancelled) return;
          setErrors((prev) => ({ ...prev, [it.id]: '抠图失败' }));
          done += 1;
          tick(`抠图完成 ${done}/${todo.length}`, done === todo.length);
        }
      })());
      await Promise.all(jobs);
      if (cancelled) return;
      setBusy(false);
      setProgress('');
      setMattesVer((v) => v + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [items]);

  // ---------- P2：异常照片检测（抠图完成后跑，纯前端像素分析，给出可解释原因） ----------
  useEffect(() => {
    // 规格（分辨率判定基准）变化时，清掉旧结论重新评估
    if (lastPx.current.w !== pxW || lastPx.current.h !== pxH) {
      inspected.current.clear();
      setIssues({});
      lastPx.current = { w: pxW, h: pxH };
    }
    const targets = items.filter((it) => !inspected.current.has(it.id) && matteCache.current.has(it.id));
    if (targets.length === 0) return;
    let cancelled = false;
    (async () => {
      // 批量场景：每张都 setIssues 会让 50 张缩略图整表重渲染 50 次（O(n²)），
      // 改为攒 8 条刷一次 + 让出一帧，检测阶段的渲染开销从「50 次全表」降到「7 次」
      let pending: Record<string, PhotoIssue[]> = {};
      let since = 0;
      for (const it of targets) {
        if (cancelled) return;
        try {
          const img = await loadImage(it.file);
          const o = sampleOriginal(img);
          const matte = matteCache.current.get(it.id)!;
          const mImg = await loadImage(matte);
          const { w: mw, h: mh, alpha } = sampleAlpha(mImg);
          const { xOff, tiltOff } = framingMetrics(alpha, mw, mh);
          const found = inspectAll({
            natW: img.naturalWidth,
            natH: img.naturalHeight,
            pxW,
            pxH,
            meanL: o.meanL,
            edgeStd: o.edgeStd,
            xOff,
            tiltOff,
          });
          if (cancelled) return;
          inspected.current.add(it.id);
          pending[it.id] = found;
          if (++since >= 8) {
            const flush = pending;
            pending = {};
            since = 0;
            setIssues((prev) => ({ ...prev, ...flush }));
            await new Promise((r) => setTimeout(r, 0));
          }
        } catch {
          inspected.current.add(it.id); // 失败也标记，避免反复重试卡死
        }
      }
      if (cancelled) return;
      if (since > 0) setIssues((prev) => ({ ...prev, ...pending }));
    })();
    return () => {
      cancelled = true;
    };
  }, [items, mattesVer, pxW, pxH]);

  // ---------- 合成（换底/美白/亮度） ----------
  // 性能要点（批量 50 张重构，详见 MATTE_BATCH_NOTES）：
  //   1) 像素级运算改在「输出分辨率」上做（1 寸 ≈ 310×413，而原图 12MP）—— 像素量降到 1/95；
  //   2) 人物层按 id 缓存：换底色/换纸张只重新合层（2~5ms/张），不再重做去晕边/阈值/美白；
  //   3) 每处理 8 张让出一帧，批量时界面不再整段假死（长任务从数十秒降到 <200ms）。
  //
  // 交互要点（参考爱印的「大图即时预览」）：
  //   4) 合成范围 = **所有已抠图的照片**，不再只限勾选 —— 勾选只决定导出，左栏缩略图与
  //      中栏大图都要有成品；
  //   5) **当前照片先出片**（分两段提交）：拖一次滑杆后先看到主预览变化，其余照片随后补齐。
  //      否则 50 张排在前面时，用户要等一轮全量合成才看到自己正在调的那张。
  useEffect(() => {
    let cancelled = false;
    const targets = items.filter((it) => matteCache.current.has(it.id));
    if (targets.length === 0) {
      setResults((prev) => {
        prev.forEach((r) => URL.revokeObjectURL(r.url));
        return [];
      });
      return;
    }
    /** 左栏顺序：结果集按它排序，保证「照片 N」与列表行一一对应 */
    const order = new Map(items.map((it, i) => [it.id, i] as const));
    /**
     * 参数指纹：没变时只补「还没有成品」的照片 —— 抠图是逐张完成的（每完成一张 mattesVer+1），
     * 若每次都重算整批，50 张会变成 O(n²)。指纹里放 placements 的 JSON：手动微调也算参数变化。
     */
    const sig = JSON.stringify([pxW, pxH, retouch, monoOn, advOpts, placements, presetId]);
    const reuse = composeSig.current === sig;
    composeSig.current = sig;
    /**
     * 把新出的结果并进现有集合：
     * 同 id 的旧结果回收（避免 URL 泄漏）、已移除照片的结果丢弃、整体按左栏顺序重排。
     * 分两段提交因此不会互相覆盖 —— 第二段只补「其余照片」，当前照片保持不动。
     */
    const commit = (fresh: ComposeResult[]) => {
      setResults((prev) => {
        const byId = new Map(fresh.map((r) => [r.id, r]));
        const keep: ComposeResult[] = [];
        for (const r of prev) {
          if (byId.has(r.id) || !order.has(r.id)) {
            URL.revokeObjectURL(r.url);
            continue;
          }
          keep.push(r);
        }
        return [...keep, ...fresh].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      });
    };

    // 回收已移除照片的成品（幂等：没有多余的就不改 state，不触发重渲染）
    setResults((prev) => {
      const gone = prev.filter((r) => !order.has(r.id));
      if (gone.length === 0) return prev;
      gone.forEach((r) => URL.revokeObjectURL(r.url));
      return prev.filter((r) => order.has(r.id));
    });

    const pending = reuse ? targets.filter((it) => !resultIds.current.has(it.id)) : targets;
    if (pending.length === 0) return;

    void (async () => {
      const advActive = advOpts.smoothing > 0 || advOpts.shine > 0 || advOpts.underEye > 0;
      const input = {
        w: pxW,
        h: pxH,
        retouch,
        mono: monoOn,
        adv: {
          active: advActive,
          key: advKey,
          opts: advOpts,
          fallbackBeauty: BEAUTY_LEVELS[beautyLevel],
        },
      };
      const deps = {
        retouchPhoto: retouchPhotoBlob,
        summarizeRetouch,
        buildPersonLayer,
        compositeLayer,
        // 缓存键沿用预览版格式（与导出键不同，见 previewLayerKey/exportLayerKey）
        keyOf: (id: string, opt: RetouchOpts, w: number, h: number, pl: Placement | undefined, sig: string) =>
          previewLayerKey(id, sig, personLayerKey(opt, w, h, pl)),
        layerCache: layerCache.current,
        maxLayers: LAYER_CACHE_MAX,
        createObjectURL: (b: Blob) => URL.createObjectURL(b),
        revokeObjectURL: (u: string) => URL.revokeObjectURL(u),
        isCancelled: () => cancelled,
        onError: (id: string) => setErrors((prev) => ({ ...prev, [id]: '合成失败' })),
      };
      const toItem = (it: PhotoItem) => ({
        id: it.id,
        name: it.file.name,
        matte: matteCache.current.get(it.id)!,
        placement: placements[it.id],
      });

      // 第一段：当前正在看的那张（读 activeId 而不进依赖数组 —— 切换照片不该触发重合成）
      const focus = pending.find((it) => it.id === (activeId ?? items[0].id)) ?? pending[0];
      const first = await composeMany({ ...input, items: [toItem(focus)] }, deps);
      if (cancelled || first.cancelled) return;
      if (first.results.length > 0) commit(first.results);
      if (advOn && !advActive) setAdvMsg('三档均为 0：本张未做匀肤');
      else setAdvMsg(first.retouchMsg);

      // 第二段：其余照片（人物层缓存命中，只重新合层）
      const rest = pending.filter((it) => it.id !== focus.id);
      if (rest.length === 0) return;
      const more = await composeMany({ ...input, items: rest.map(toItem) }, deps);
      if (cancelled || more.cancelled) return;
      commit(more.results);
    })();
    return () => {
      cancelled = true;
    };
    // 依赖 mattesVer 而非 matteCache（缓存是 ref，需版本号触发）；placements 变化需重合成。
    // checked / activeId 刻意不在依赖里：前者只影响导出，后者只影响第一段的顺序。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mattesVer, retouch, presetId, items, placements, advOpts, monoOn]);

  // ---------- 排版页构建（只排「已勾选」的照片） ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (picked.length === 0) {
        setSheets([]);
        return;
      }
      const imgs = await Promise.all(picked.map((r) => blobToImage(r.blob)));
      if (cancelled) return;
      setSheets(
        buildSheetImages({
          sources: imgs,
          layout,
          itemW: preset.w,
          itemH: preset.h,
          mode: sheetMode,
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [picked, layout, preset, sheetMode]);

  // ---------- 预览绘制（含尺寸标注） ----------
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    renderPreview(canvas, {
      paper,
      layout,
      itemW: preset.w,
      itemH: preset.h,
      margin: SHEET_MARGIN_MM,
      gap: gapMm,
      cutLines: true,
      sheets,
      scale: PREVIEW_SCALE,
    });
    if (sizeMark && sheets.length > 0) {
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.font = `${Math.max(9, 2.4 * PREVIEW_SCALE)}px sans-serif`;
      const label = `${pxW}×${pxH}px`;
      for (let r = 0; r < layout.rows; r++) {
        for (let c = 0; c < layout.cols; c++) {
          const x = (SHEET_MARGIN_MM + c * (preset.w + gapMm)) * PREVIEW_SCALE;
          const y = (SHEET_MARGIN_MM + r * (preset.h + gapMm)) * PREVIEW_SCALE;
          ctx.fillText(label, x + 2, y + 3.2 * PREVIEW_SCALE);
        }
      }
    }
  }, [paper, layout, preset, sheets, gapMm, sizeMark, pxW, pxH]);

  // ---------- 导出 / 打印 ----------
  /**
   * 批量导出：一次选目录，并发原子写入 —— 不再一个个弹保存框（图文店一次几十份）。
   *
   * 多尺寸（复刻爱印「一个原图出多个规格」）：勾选多个尺寸时，**每个尺寸按自身规格独立重新构图**
   * ——各自用该尺寸的 topRatio/headRatio 重算摆放、按该尺寸像素重建人物层，
   * 而不是把当前预览的图缩放裁切。人脸/下半身数据来自 frameData 缓存，每张只跑一次。
   * 只有勾「当前规格」这一个时走快路径，直接复用已合成的 results。
   */
  async function exportAll() {
    const sizeIds = exportSizeIds.length > 0 ? exportSizeIds : [presetId];
    const fastPath = sizeIds.length === 1 && sizeIds[0] === presetId;
    const targets = items.filter((it) => checked.has(it.id) && matteCache.current.has(it.id));
    // 合成范围已放宽到「所有已抠图」（左栏缩略图要成品），导出仍只认勾选
    if (fastPath ? picked.length === 0 : targets.length === 0) return;

    setBusy(true);
    setSaveMsg('');
    setProgress('正在准备导出…');
    try {
      const payload: { name: string; data: Uint8Array }[] = [];
      /** 体积档位（20~200KB 等）；null = 不限制，原样交出字节 */
      const sizeTarget = sizeTargetOf(sizeTargetId);
      /** 压到下限/上限之外的照片张数（只用于结果提示，不阻断导出） */
      let oversize = 0;
      /** 收一份 300DPI 的 JPEG 进导出队列：命名统一为「证件照_原名_规格.jpg」 */
      const pushJpeg = async (baseName: string, specName: string, blob: Blob) => {
        // 体积约束：只在超上限时二次重编码（不超就原样用，零画质损失）
        const fitted = await fitJpegBlob(blob, sizeTarget);
        if (!fitted.fits) oversize += 1;
        payload.push({
          name: `证件照_${baseName}_${specName}.jpg`,
          data: withJpegDpi(await bytesOf(fitted.blob), DEFAULT_DPI),
        });
      };

      if (fastPath) {
        // 快路径：当前规格的预览结果已是按该规格构图合成的，直接复用（只补 DPI 元数据）
        for (const r of picked) await pushJpeg(r.name.replace(/\.[^.]+$/, ''), preset.name, r.blob);
      } else {
        // 多尺寸：先备齐构图输入（一次/张），再逐尺寸逐张独立构图合成
        setProgress('正在检测人脸与下半身…');
        await ensureFrameData(targets);

        const advActive = advOpts.smoothing > 0 || advOpts.shine > 0 || advOpts.underEye > 0;
        // 专业匀肤与输出尺寸无关：按抠图 blob 记忆（含失败），多个尺寸只做一次
        const retouchOnce = memoRetouch(retouchPhotoBlob);
        const total = sizeIds.length * targets.length;
        let done = 0;

        for (const sid of sizeIds) {
          const p = PHOTO_PRESETS.find((x) => x.id === sid) ?? preset;
          const spec = framingSpecOf(p);
          const outW = mmToPx(p.w);
          const outH = mmToPx(p.h);
          const offset = done;
          done += targets.length;

          // 该尺寸的独立构图：有脸 → 按该尺寸规格重算（`placementForFrame` 是这条判断的唯一实现）；
          // 无脸 → 手动微调按比例换算
          const sizeItems = targets.map((it) => {
            const auto = placementForFrame(frameData.current.get(it.id), spec);
            let placement: Placement | undefined;
            if (auto) {
              placement = auto.placement;
            } else if (placements[it.id]) {
              placement = {
                dx: Math.round(placements[it.id].dx * (outW / pxW)),
                dy: Math.round((placements[it.id].dy ?? 0) * (outH / pxH)),
                zoom: placements[it.id].zoom,
                rotation: placements[it.id].rotation,
              };
            }
            return {
              id: it.id,
              name: it.file.name,
              matte: matteCache.current.get(it.id)!,
              placement,
            };
          });

          // 合成走与预览同一份编排，差异只有：输出分辨率（outW/outH）、
          // 缓存键带规格 id、失败文案带规格名、进度条
          const res = await composeMany(
            {
              items: sizeItems,
              w: outW,
              h: outH,
              retouch,
              mono: monoOn,
              adv: {
                active: advActive,
                key: advKey,
                opts: advOpts,
                fallbackBeauty: BEAUTY_LEVELS[beautyLevel],
              },
            },
            {
              retouchPhoto: retouchOnce,
              summarizeRetouch,
              buildPersonLayer,
              compositeLayer,
              // 导出键格式：多一段规格 id，否则同图不同尺寸会互相命中
              keyOf: (id, opt, w, h, pl) =>
                exportLayerKey(id, p.id, advActive ? advKey : '', personLayerKey(opt, w, h, pl)),
              layerCache: layerCache.current,
              maxLayers: LAYER_CACHE_MAX,
              onProgress: (n) => setProgress(`正在导出 ${p.name}：${offset + n}/${total}…`),
              onError: (id) => setErrors((prev) => ({ ...prev, [id]: `${p.name} 导出失败` })),
            },
          );

          for (const r of res.results) {
            await pushJpeg(r.name.replace(/\.[^.]+$/, ''), p.name, r.blob);
          }
        }
      }

      // 订阅主进程的写盘进度：几十份证件照可能持续数秒，别让界面一直停在「正在准备导出…」
      const res = await saveBatch(payload, {
        onProgress: (p) => setProgress(`正在写入 ${p.done}/${p.total}…`),
      });
      setProgress('');
      setSaveMsg(
        res.cancelled
          ? '已取消保存'
          : batchMessage(res) +
              (oversize > 0
                ? `（其中 ${oversize} 张已压到最低质量仍超 ${sizeTargetName(sizeTargetId)}，已按最大压缩交付）`
                : ''),
      );
      void revealIfWanted(res.dir ?? undefined);
    } catch (e) {
      setProgress('');
      setSaveMsg(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /** 排版 PDF 字节：导出与打印共用同一份，避免两条路径参数漂移 */
  function sheetPdfBytes(): Uint8Array | null {
    if (sheets.length === 0) return null;
    const fileName = `证件照排版_${paper.name.split(' ')[0]}_${preset.name}.pdf`;
    return exportSheetPdf({
      paper,
      layout,
      itemW: preset.w,
      itemH: preset.h,
      margin: SHEET_MARGIN_MM,
      gap: gapMm,
      cutLines: true,
      sheets,
      fileName,
    });
  }

  function exportSheet() {
    const fileName = `证件照排版_${paper.name.split(' ')[0]}_${preset.name}.pdf`;
    const bytes = sheetPdfBytes();
    // 拿到字节说明还没落盘，交给主进程原子写；返回 null 表示函数内部已自行触发下载
    if (bytes) {
      void saveBytes(bytes, fileName).then((o) => {
        setSaveMsg(o.ok ? outcomeMessage(o) : o.code === 'cancelled' ? '' : o.error || '保存失败');
        void revealIfWanted(o.path);
      });
    }
  }

  // 打印：生成排版 PDF 交给主进程用内置 PDFium 静默直出（纸张跟随 PDF，不再弹对话框）；
  // 还没有排版结果时回退旧的窗口打印
  async function doPrint() {
    const api = (window as unknown as { electronAPI?: { print?: (o: unknown) => void } })
      .electronAPI;
    const bytes = sheetPdfBytes();
    if (bytes) {
      setSaveMsg('正在发送到打印机…');
      // 证卡/证件照是小纸张、字小，栅格化提到 400DPI；灰度交给打印预设决定
      const r = await printPdfBytes(bytes, { ...presetPrintOpts(), dpi: 400, copies: 1 });
      setSaveMsg(r.ok ? '已发送到打印机' : `打印失败：${r.reason || r.error || '未知原因'}`);
      return;
    }
    if (api?.print) api.print({ ...presetPrintOpts(), grayscale: false, copies: 1 });
    else window.print();
  }

  // 快捷键接入：导入/打印/导出（能力自动登记供设置页展示）
  useHotkeyActions('id-photo', '证件照批量处理', {
    import: () => inputRef.current?.click(),
    print: doPrint,
    export: exportAll,
  });

  /**
   * 构图流的 DOM 侧适配层：图像加载 / 人脸检测 / 下半身分割。
   * 判断逻辑（无脸跳过、分割失败容忍、让帧）全部在 `lib/idphotoFramingFlow` 里，
   * 这里只负责「把模型和 canvas 跑起来」—— 换模型实现不改行为，单测也不必碰 DOM。
   * deps 全是模块级函数，故依赖数组为空、引用恒定。
   */
  const frameDeps = useMemo<FramingDeps<HTMLImageElement>>(
    () => ({
      loadSource: async (t) => {
        const img = await loadImage(t.url);
        return { src: img, w: img.naturalWidth, h: img.naturalHeight };
      },
      detectHead: async (img) => {
        const faces = await detectFaces(img);
        return faces.length === 0 ? undefined : headFromFace(faces[0]);
      },
      segmentLower: async (img, w, h) => {
        const s = Math.min(1, SEG_MAX / Math.max(w, h));
        const sw = Math.max(1, Math.round(w * s));
        const sh = Math.max(1, Math.round(h * s));
        const c = document.createElement('canvas');
        c.width = sw;
        c.height = sh;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) return undefined;
        ctx.drawImage(img, 0, 0, sw, sh);
        const rgba = ctx.getImageData(0, 0, sw, sh).data;
        return segmentPersonLowerBody(rgba, sw, sh);
      },
    }),
    [],
  );

  /**
   * 为一组照片准备「构图输入」：人脸几何 + 下半身分割结果（含原图尺寸），逐张缓存于 frameData。
   * 已缓存的跳过；分割失败则 lower 留空（后续回退旧近似）。每 8 张让出一帧避免界面卡顿。
   * 自动构图 / 实时核查 / 多尺寸导出三个调用点共用这一份缓存。
   */
  const ensureFrameData = useCallback(
    (targets: PhotoItem[]) => ensureFrames(targets.map(toFramingTarget), frameData.current, frameDeps),
    [frameDeps],
  );

  /** 自动构图：对已勾选且已抠图的照片，按当前尺寸规格（topRatio/headRatio）摆放头部，
   *  并用真实下半身分割结果判断「下方不足」—— 仅在确有背景空隙时自动放大最多 20% 填满。
   *  取脸 → 判下半身 → 算 placement 全在 `planPlacements`（纯逻辑），这里只管 busy 态与写 state。 */
  const applyAutoFraming = async () => {
    const targets = items.filter((it) => checked.has(it.id) && matteCache.current.has(it.id));
    if (targets.length === 0) {
      setSaveMsg('自动构图：没有已勾选且完成抠图的照片');
      return;
    }
    const spec = framingSpecOf(preset);
    setBusy(true);
    setProgress('自动构图：检测人脸与下半身…');
    // 自动构图固定走默认档（mode='default'、fillScale=1），与右侧面板的实时核查互不影响
    const plan = await planPlacements(targets.map(toFramingTarget), frameData.current, { spec }, frameDeps);
    setPlacements((prev) => ({ ...prev, ...plan.placements }));
    setFrameMode('auto');
    setFramingId(null);
    setBusy(false);
    setProgress('');
    setSaveMsg(`自动构图完成：${plan.framed} 张已按${preset.name}规格构图${plan.noFace > 0 ? `，${plan.noFace} 张未检出人脸已跳过（保持原构图）` : ''}`);
  };

  // 当前激活照片（取景态 > 首张已勾选 > 首张）的「规格构图实测 + 逐项核查」预览：
  // 随构图模式/放大填满实时重算，让用户在点「自动构图」前就能看到头部占比、留白与告警。
  useEffect(() => {
    let cancelled = false;
    const id = framingId ?? [...checked][0] ?? items[0]?.id;
    const it = items.find((i) => i.id === id);
    if (!it) {
      setActiveFraming({});
      return;
    }
    void (async () => {
      try {
        // 复用 frameData（人脸 + 下半身）。未缓存时先备一次，之后不再重复跑模型。
        if (!frameData.current.has(it.id)) await ensureFrameData([it]);
        if (cancelled) return;
        const fd = frameData.current.get(it.id);
        // 与自动构图/导出走同一条参数装配（placementForFrame），避免面板读数与实际构图分叉
        const r = placementForFrame(fd, framingSpec, specMode, fillScale);
        if (!fd?.head || !fd.w || !fd.h || !r) {
          setActiveFraming({});
          return;
        }
        const head = fd.head;
        const bottomFrac = personBottomFrac(fd);
        const metrics = computeMetrics(head, fd.w, fd.h, r.placement, framingSpec);
        const verification = verifyFraming(metrics, framingSpec);
        if (!cancelled) {
          setActiveFraming({
            metrics,
            verification,
            segmented: Boolean(bottomFrac),
            fillApplied: r.bottomAnchorScale > 1.001,
          });
        }
      } catch {
        if (!cancelled) setActiveFraming({});
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framingId, checked, items, framingSpec, specMode, fillScale]);

  // 批量默认启用自动构图：每次抠图完成（mattesVer 递增）且开关打开时，自动按规格构图。
  useEffect(() => {
    if (batchAutoFrame && mattesVer > 0) {
      void applyAutoFraming();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mattesVer, batchAutoFrame]);

  const allChecked = items.length > 0 && checked.size === items.length;

  return (
    <div className="tool-shell">
      {/* ===== 工具级顶栏（只保留工具标识；原爱印的试用/剩余天数/开通按钮不复刻） ===== */}
      <div className="icw-topbar">
        <div className="icw-brand">
          <span className="icw-logo">📷</span>
          <span className="icw-brand-name">
            证件照批量处理<em>（增强模型）</em>
          </span>
        </div>
      </div>

      <div className="idp">
      {/* 左栏：工具栏 + 照片缩略图网格 */}
      <IdPhotoLeft
        items={items}
        checked={checked}
        setChecked={setChecked}
        allChecked={allChecked}
        toggleAll={toggleAll}
        clearAll={clearAll}
        inputRef={inputRef}
        folderRef={folderRef}
        addFiles={addFiles}
        removeItem={removeItem}
        matteCache={matteCache}
        errors={errors}
        issues={issues}
        activeId={activeId}
        setActiveId={setActiveId}
        resultUrls={resultUrls}
        demoThumbs={demoThumbs}
        loadDemo={loadDemo}
      />

      {/* 中栏：当前照片大图 / 排版预览 */}
      <IdPhotoCenter
        tab={tab}
        setTab={setTab}
        dragOver={dragOver}
        setDragOver={setDragOver}
        addFiles={addFiles}
        busy={busy}
        progress={progress}
        saveMsg={saveMsg}
        setSaveMsg={setSaveMsg}
        activeItem={activeItem}
        activeIndex={activeIndex}
        total={total}
        activeResult={activeResult}
        activeError={activeError}
        stepPhoto={stepPhoto}
        guideOn={guideOn}
        sizeMark={sizeMark}
        presetName={presetName}
        presetW={presetW}
        presetH={presetH}
        pxW={pxW}
        pxH={pxH}
        framingId={framingId}
        setFramingId={setFramingId}
        previewRef={previewRef}
        sheets={sheets}
      />

      {/* 右栏：设置（设置项走 options + setOption，运行时状态仍逐个具名传） */}
      <IdPhotoRight
        options={options}
        setOption={setOption}
        addExportSize={addExportSize}
        toggleExportSize={toggleExportSize}
        isDefaultOptions={isDefaultOptions}
        resetOptions={resetOptions}
        pxW={pxW}
        pxH={pxH}
        exportCount={exportCount}
        frameMode={frameMode}
        setFrameMode={setFrameMode}
        setPlacements={setPlacements}
        setFramingId={setFramingId}
        applyAutoFraming={applyAutoFraming}
        framingSpec={framingSpec}
        activeFraming={activeFraming}
        onEngineChange={onEngineChange}
        items={items}
        bg={bg}
        checked={checked}
        advMsg={advMsg}
        manualOpen={manualOpen}
        setManualOpen={setManualOpen}
        layout={layout}
      />

      {/* 底部状态栏：左「本批概览」/ 中「显示开关」/ 右「导出动作」，三段用竖线分开。
          对应三种心智（在看什么 · 怎么显示 · 要不要导），比全部挤成一行更好扫。 */}
      <footer className="idp-bottom">
        <div className="idp-bottom-l">
          <span className="idp-bottom-sum">
            {exportSizeIds.length > 1
              ? `将导出 ${exportSizeIds.length} 规格 × ${picked.length} 张 = ${exportSizeIds.length * picked.length} 份 · JPG`
              : `将导出 ${picked.length} 张 · ${preset.name} · JPG`}
          </span>
          {activeItem && (
            <span className="muted idp-bottom-cur" title={activeItem.file.name}>
              当前 照片 {activeIndex + 1}
              {activeResult ? ` · ${pxW}×${pxH}px` : ' · 处理中'}
            </span>
          )}
          {failCount > 0 && (
            <span className="idp-bottom-warn" title="抠图或合成失败的照片不会导出，换张照片或改参数可重试">
              {failCount} 张失败
            </span>
          )}
        </div>
        <div className="idp-bottom-m">
          <label>
            <input type="checkbox" checked={sizeMark} onChange={(e) => setOption('sizeMark', e.target.checked)} /> 尺寸标注
          </label>
          <label>
            <input type="checkbox" checked={guideOn} onChange={(e) => setOption('guideOn', e.target.checked)} /> 人像定位线
          </label>
        </div>
        <div className="idp-bottom-r">
          <button className="btn" disabled={sheets.length === 0} onClick={exportSheet}>
            排版导 PDF
          </button>
          <button className="btn" disabled={sheets.length === 0} onClick={doPrint}>
            打印
          </button>
          <button className="btn primary" disabled={picked.length === 0} onClick={exportAll}>
            开始导出
          </button>
        </div>
      </footer>

      {/* P3：取景微调编辑器（仅当某张证件照处于取景态时显示），红框内画面可左右拖动 */}
      {framingId && matteCache.current.get(framingId) && (
        <FramingEditor
          matteBlob={matteCache.current.get(framingId)!}
          bgHex={bg.id === 'custom' ? customHex : bg.hex}
          pxW={pxW}
          pxH={pxH}
          initial={placements[framingId]}
          onChange={(dx, dy, rotation) =>
            setPlacements((prev) => ({
              ...prev,
              [framingId]: { dx, dy, rotation, zoom: prev[framingId]?.zoom },
            }))
          }
          onReset={() =>
            setPlacements((prev) => {
              const n = { ...prev };
              delete n[framingId];
              return n;
            })
          }
          onClose={() => setFramingId(null)}
        />
      )}
      </div>
    </div>
  );
}
