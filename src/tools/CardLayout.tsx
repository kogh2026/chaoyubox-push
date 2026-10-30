import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CARD_TYPES,
  cardTypeOf,
  paperSize,
  pagePlacements,
  paginate,
  renderCardPage,
  type PaperId,
  type Orient,
  type Pos,
  type ColorMode,
  type LayoutCfg,
} from '../lib/idCardLayout';
import { resolveCardGrid, LAYOUT_ALGOS, type LayoutAlgo } from '../lib/layoutStrategies';
import { exportPagesPdf } from '../lib/sheetPdf';
import { exportVectorSheetPdf, saveVectorSheetPdf } from '../lib/vectorSheetPdf';
import {
  saveBytes,
  saveBatch,
  saveDataUrl,
  bytesOf,
  outcomeMessage,
  batchMessage,
  revealIfWanted,
  type SaveOutcome,
} from '../lib/exporter';
import { detectCards, FULL_QUAD, warpToCorrected, type Quad } from '../lib/cardDetect';
import { detectCardQuadWithML } from '../lib/cardDetectMl';
import {
  cardCorrectAvailable,
  correctImageWithModel,
  disposeCardCorrectWorker,
  type ModelCardEntry,
} from '../lib/cardCorrectClient';
import { useHotkeyActions } from '../lib/hotkeys';
import { presetPrintOpts, printPdfBytes } from '../lib/printers';
import { disposeOcrWorker, recognizeCardType } from '../lib/cardOcr';
import ManualCropModal from './ManualCropModal';

interface CardItem {
  key: number;
  name: string;
  img: HTMLImageElement;
  dataUrl: string;
  type: string; // CARD_TYPES id
  rotation: number; // 0/90/180/270
  checked: boolean;
  copies: number; // 份数（≥1）
  quad: Quad; // 自动检测角点（归一化）
  confidence: number; // 自动检测置信度 0..1
  manual: boolean; // 已应用手动角点校正
  auto?: boolean; // 已应用自动校正（识别置信度高时）
  corrected?: { img: HTMLImageElement; dataUrl: string };
  /** OCR 状态（P1-B）：识别中/已识别/失败 */
  ocr?: 'running' | 'done' | 'fail';
  ocrHits?: string[]; // 命中的关键词
  /** 用户手动改过类型：之后 OCR 不再覆盖 */
  typeManual?: boolean;
}

let KEY = 1;

const NEED_CHECK = 0.6; // 置信度低于该值标记「需检查」

/** 读文件 → HTMLImageElement（objectURL 由调用方接管） */
function loadImageEl(file: File): Promise<{ img: HTMLImageElement; objectUrl: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, objectUrl: url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    img.src = url;
  });
}

function baseItem(
  file: File,
  objectUrl: string,
  img: HTMLImageElement,
  quad: Quad,
  confidence: number,
  multiIdx?: { i: number; n: number },
): CardItem {
  return {
    key: KEY++,
    name: multiIdx ? (multiIdx.n > 1 ? `${file.name}（${multiIdx.i + 1}/${multiIdx.n}）` : file.name) : file.name,
    img,
    dataUrl: objectUrl,
    type: 'idcard',
    rotation: 0,
    checked: true,
    copies: 1,
    quad,
    confidence,
    manual: false,
  };
}

/** 经典 CV 路径：一张图 → 0..N 条卡（检测+多卡拆分） */
function itemsFromCv(file: File, objectUrl: string, img: HTMLImageElement): CardItem[] {
  const det = detectCards(img);
  const cards = det.cards;
  if (cards.length === 0) {
    // 没检出可用卡面：保留整图 + 低置信，交给用户手动框选
    return [baseItem(file, objectUrl, img, FULL_QUAD, 0.4)];
  }
  return cards.map((c, i) => baseItem(file, objectUrl, img, c.quad, c.confidence, { i, n: cards.length }));
}

/** 增强模型路径（爱印记卡矫正 FP32）：一张图 → 0..N 条已校正卡面；未检出返回 [] */
async function itemsFromModel(
  file: File,
  objectUrl: string,
  img: HTMLImageElement,
): Promise<CardItem[]> {
  const entries: ModelCardEntry[] = await correctImageWithModel(img);
  return entries.map((e, i) => {
    const it = baseItem(file, objectUrl, img, e.quad, e.confidence, { i, n: entries.length });
    it.corrected = e.corrected;
    it.auto = true; // 模型路径直接产出校正图
    return it;
  });
}

// 按证件类型计算校正输出尺寸（长边 1100px，保持卡面比例）
function correctedSize(type: string): { ow: number; oh: number } {
  const t = cardTypeOf(type);
  const long = 1100;
  const land = t.w >= t.h;
  return {
    ow: land ? long : Math.round((long * t.w) / t.h),
    oh: land ? Math.round((long * t.h) / t.w) : long,
  };
}

// 导出统一走 exporter：桌面端 tmp + rename 原子写盘（拿得到真实路径与失败原因），
// 浏览器预览环境回退到传统的 <a download>。不再包一层同名 download 空壳。

const PREVIEW_PX = 3; // 预览 像素/毫米
const EXPORT_DPI = 300;

export default function CardLayout() {
  const [items, setItems] = useState<CardItem[]>([]);
  const [paperId, setPaperId] = useState<PaperId>('a4');
  const [orient, setOrient] = useState<Orient>('p');
  const [perPage, setPerPage] = useState<number | 'auto'>(2);
  const [shrink, setShrink] = useState(true);
  const [pos, setPos] = useState<Pos>('center');
  const [offY, setOffY] = useState(0);
  const [offX, setOffX] = useState(0);
  const [gap, setGap] = useState(4); // 图片间距 mm（爱印 0–60）
  const [algo, setAlgo] = useState<LayoutAlgo>('grid'); // T0 布局策略
  const [showGuide, setShowGuide] = useState(true); // T1 预览参考线（不烧入导出）
  const [cropMarks, setCropMarks] = useState(false); // T1 蚂蚁线裁切口（烧入导出）
  const [autoCorrect, setAutoCorrect] = useState(true); // T3 识别置信度高时自动校正
  const [enhanceModel, setEnhanceModel] = useState(true); // 增强模型（爱印记卡矫正 FP32）：主路径
  const [useML, setUseML] = useState(false); // T3 可选 ML 增强（经典 CV 不足时的备选实验路径）
  const [colorMode, setColorMode] = useState<ColorMode>('enhance');
  const [sat, setSat] = useState(100);
  const [sharpen, setSharpen] = useState(0);
  const [wmOn, setWmOn] = useState(false);
  const [wmText, setWmText] = useState('超誉工作台');
  const [sortMode, setSortMode] = useState<'import' | 'name'>('import');
  const [pageIdx, setPageIdx] = useState(0);
  const [notice, setNotice] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [cropKey, setCropKey] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);

  const paper = useMemo(() => paperSize(paperId, orient), [paperId, orient]);
  const checked = useMemo(() => items.filter((i) => i.checked), [items]);

  const cfg: LayoutCfg = useMemo(
    () => ({ perPage, gap, shrink, pos, offX, offY }),
    [perPage, gap, shrink, pos, offX, offY],
  );

  // 本页所有卡按"最大卡尺寸"统一网格（混合类型时取大者，保证不裁切）
  const maxCard = useMemo(() => {
    let w = 0;
    let h = 0;
    for (const it of checked) {
      const t = cardTypeOf(it.type);
      w = Math.max(w, t.w);
      h = Math.max(h, t.h);
    }
    return { w: w || 85.6, h: h || 54 };
  }, [checked]);

  const grid = useMemo(
    () => resolveCardGrid(algo, paper.w, paper.h, maxCard.w, maxCard.h, cfg),
    [algo, paper, maxCard, cfg],
  );
  // 份数展开：每张图按 copies 复制进排版序列（T1）
  const expanded = useMemo(
    () => checked.flatMap((it) => Array.from({ length: Math.max(1, it.copies) }, () => it)),
    [checked],
  );
  const pages = useMemo(() => paginate(expanded.length, grid.perPage), [expanded.length, grid.perPage]);
  const placements = useMemo(() => pagePlacements(paper.w, paper.h, grid, cfg), [paper, grid, cfg]);
  const cur = Math.min(pageIdx, Math.max(0, pages.length - 1));

  const curPageImgs = useMemo(() => {
    const p = pages[cur] ?? [];
    return p.map((idx) => ({
      img: expanded[idx].corrected?.img ?? expanded[idx].img,
      rotation: expanded[idx].rotation,
    }));
  }, [pages, cur, expanded]);

  // 快捷键接入：导入/打印/导出（能力自动登记供设置页展示）
  useHotkeyActions('id-card', '证卡拼版助手', {
    import: () => inputRef.current?.click(),
    print: doPrint,
    export: doExportPdf,
  });

  // 重绘预览
  useEffect(() => {
    const cv = previewRef.current;
    if (!cv) return;
    if (pages.length === 0) {
      const ctx = cv.getContext('2d');
      cv.width = Math.round(paper.w * PREVIEW_PX);
      cv.height = Math.round(paper.h * PREVIEW_PX);
      ctx?.clearRect(0, 0, cv.width, cv.height);
      return;
    }
    renderCardPage(cv, paper.w, paper.h, placements, curPageImgs, PREVIEW_PX, {
      colorMode,
      sat,
      sharpen,
      wm: { on: wmOn, text: wmText },
      cropMarks,
    });
    // T1 预览参考线（仅预览层，绝不写入导出文件）
    if (showGuide) {
      const ctx = cv.getContext('2d');
      if (ctx) {
        ctx.save();
        ctx.strokeStyle = 'rgba(37, 99, 235, 0.55)';
        ctx.fillStyle = 'rgba(37, 99, 235, 0.55)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        placements.forEach((p) => {
          const x = p.x * PREVIEW_PX;
          const y = p.y * PREVIEW_PX;
          const w = p.w * PREVIEW_PX;
          const h = p.h * PREVIEW_PX;
          // 头像中心参考线（约 38% 高度，对应双眼水平）
          const headY = y + h * 0.38;
          ctx.beginPath();
          ctx.moveTo(x, headY);
          ctx.lineTo(x + w, headY);
          ctx.stroke();
          // 竖向居中参考线
          ctx.beginPath();
          ctx.moveTo(x + w / 2, y);
          ctx.lineTo(x + w / 2, y + h);
          ctx.stroke();
          // 头像框（下巴到头顶）轻标注
          ctx.setLineDash([]);
          ctx.globalAlpha = 0.35;
          ctx.strokeRect(x + w * 0.28, y + h * 0.12, w * 0.44, h * 0.5);
          ctx.globalAlpha = 1;
          ctx.setLineDash([4, 3]);
        });
        ctx.restore();
      }
    }
  }, [paper, placements, curPageImgs, pages.length, colorMode, sat, sharpen, wmOn, wmText, cropMarks, showGuide]);

  useEffect(() => {
    if (pageIdx > pages.length - 1) setPageIdx(Math.max(0, pages.length - 1));
  }, [pages.length, pageIdx]);

  async function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setBusy(true);
    const files = Array.from(list).filter((f) => f.type.startsWith('image/'));
    const modelReady = enhanceModel && cardCorrectAvailable();
    const added: CardItem[] = [];
    for (let fi = 0; fi < files.length; fi += 1) {
      const f = files[fi];
      try {
        const { img, objectUrl } = await loadImageEl(f);
        if (modelReady) {
          // 增强模型主路径：直接产出已校正卡面（含多卡拆分与 90° 摆正）
          if (files.length > 1) setMsg(`增强识别中 ${fi + 1}/${files.length}：${f.name}`);
          try {
            const its = await itemsFromModel(f, objectUrl, img);
            if (its.length > 0) {
              added.push(...its);
              continue;
            }
            // 模型正常但没检出 → 回退经典 CV
          } catch {
            // 模型/Worker 失败 → 回退经典 CV
          }
        }
        const its = itemsFromCv(f, objectUrl, img);
        for (const it of its) {
          // T3：识别置信度高时自动透视矫正；开启旧版 ML 且经典检测不足时尝试增强。
          // 任一失败或不满足阈值 → 不自动处理，保持原图，由用户手动裁切兜底。
          if (autoCorrect) {
            if (it.confidence >= NEED_CHECK) {
              try {
                const { ow, oh } = correctedSize(it.type);
                const corrected = await warpToCorrected(it.img, it.quad, ow, oh, { upright: true, autoFlip: true });
                it.corrected = corrected;
                it.auto = true;
              } catch {
                /* 自动矫正失败 → 保持原图，手动兜底 */
              }
            } else if (useML) {
              try {
                const ml = await detectCardQuadWithML(it.img);
                if (ml.confidence >= NEED_CHECK) {
                  const { ow, oh } = correctedSize(it.type);
                  const corrected = await warpToCorrected(it.img, ml.quad, ow, oh, { upright: true, autoFlip: true });
                  it.quad = ml.quad;
                  it.confidence = ml.confidence;
                  it.corrected = corrected;
                  it.auto = true;
                }
              } catch {
                /* ML 增强失败 → 保持原图，手动兜底 */
              }
            }
          }
          added.push(it);
        }
      } catch {
        /* 读取失败忽略 */
      }
    }
    setItems((prev) => [...prev, ...added]);
    setBusy(false);
    setMsg('');
    // 导入完成后立刻排队做证件类型识别（后台逐张进行，不阻塞继续添加）
    enqueueOcr(added);
  }

  function update(key: number, patch: Partial<CardItem>) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }

  // ---------- 证件类型自动识别（P1-B）：本地 OCR（chi_sim 预装，离线可用） ----------
  // 导入后逐张排队识别（并发 1，避免 OCR 抢 CPU 把界面拖卡）；识别结果只作默认值，
  // 用户手动改过类型（typeManual）就不再被覆盖。
  const ocrQueueRef = useRef<number[]>([]);
  const ocrBusyRef = useRef(false);
  const itemsRef = useRef<CardItem[]>([]);
  itemsRef.current = items;
  const [ocrMsg, setOcrMsg] = useState('');

  async function applyOcr(key: number) {
    const it = itemsRef.current.find((x) => x.key === key);
    if (!it) return;
    update(key, { ocr: 'running' });
    try {
      // 优先识别「已校正的卡面」：摆正+裁净后文字更整齐，类型判得更准
      const r = await recognizeCardType(it.corrected?.dataUrl ?? it.dataUrl);
      const target = it.typeManual || r.hits.length === 0 ? it.type : r.type;
      const patch: Partial<CardItem> = { ocr: 'done', ocrHits: r.hits };
      if (target !== it.type) {
        patch.type = target;
        // 类型变了：已自动校正过的卡面按新的证件比例重做，避免导出比例不符
        if (it.corrected) {
          try {
            const { ow, oh } = correctedSize(target);
            patch.corrected = await warpToCorrected(it.img, it.quad, ow, oh, { upright: true, autoFlip: true });
          } catch {
            /* 重算失败就保留旧校正图，导出仍可用 */
          }
        }
      }
      update(key, patch);
    } catch {
      update(key, { ocr: 'fail' });
    }
  }

  async function pumpOcr() {
    if (ocrBusyRef.current) return;
    ocrBusyRef.current = true;
    try {
      while (ocrQueueRef.current.length > 0) {
        const key = ocrQueueRef.current.shift()!;
        const it = itemsRef.current.find((x) => x.key === key);
        setOcrMsg(it ? `正在识别：${it.name}` : '正在识别证件类型…');
        await applyOcr(key);
      }
    } finally {
      ocrBusyRef.current = false;
      setOcrMsg('');
    }
  }

  function enqueueOcr(list: CardItem[], force = false) {
    const keys = list
      .filter((x) => force || (x.ocr !== 'done' && x.ocr !== 'running'))
      .map((x) => x.key);
    if (keys.length === 0) return;
    ocrQueueRef.current.push(...keys);
    void pumpOcr();
  }

  // 退出时释放 OCR Worker（chi_sim + wasm 常驻内存，不用了要及时还回去）
  useEffect(() => {
    return () => {
      void disposeOcrWorker();
      disposeCardCorrectWorker(); // 增强模型 Worker（41MB 模型常驻）
    };
  }, []);

  function move(key: number, dir: -1 | 1) {
    setItems((prev) => {
      const i = prev.findIndex((it) => it.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  function remove(key: number) {
    setItems((prev) => prev.filter((it) => it.key !== key));
  }
  function applySort(mode: 'import' | 'name') {
    setSortMode(mode);
    setItems((prev) =>
      [...prev].sort((a, b) =>
        mode === 'name' ? a.name.localeCompare(b.name, 'zh-Hans-CN') : 0,
      ),
    );
  }
  const allChecked = items.length > 0 && checked.length === items.length;
  function toggleAll() {
    setItems((prev) => prev.map((it) => ({ ...it, checked: !allChecked })));
  }

  // 按导出质量渲染全部页
  const renderAll = useCallback(
    (pxPerMm: number): HTMLCanvasElement[] =>
      pages.map((_, pi) => {
        const cv = document.createElement('canvas');
        const imgs = (pages[pi] ?? []).map((idx) => ({
          img: expanded[idx].corrected?.img ?? expanded[idx].img,
          rotation: expanded[idx].rotation,
        }));
        renderCardPage(cv, paper.w, paper.h, placements, imgs, pxPerMm, {
          colorMode,
          sat,
          sharpen,
          wm: { on: wmOn, text: wmText },
          cropMarks,
        });
        return cv;
      }),
    [pages, expanded, paper, placements, colorMode, sat, sharpen, wmOn, wmText, cropMarks],
  );

  // 导出优先走矢量拼版（A2：去重 + 矢量裁切口/水印，体积更小且放大不糊）；
  // 若环境不支持画布编码，则回退整页位图路径，行为与旧版一致。
  function doExportPdf() {
    if (pages.length === 0) return;
    setBusy(true);
    setMsg('');
    const fileName = `证卡拼版_${paper.name}_${pages.length}页.pdf`;
    const vectorPages = pages.map((pg) =>
      (pg ?? []).map((idx) => ({
        img: expanded[idx]?.corrected?.img ?? expanded[idx]?.img,
        rotation: expanded[idx]?.rotation ?? 0,
      })),
    );
    setTimeout(() => {
      saveVectorSheetPdf(
        {
          paper,
          placements,
          pages: vectorPages,
          style: { colorMode, sat, sharpen, cropMarks, wm: { on: wmOn, text: wmText } },
          dpi: EXPORT_DPI,
        },
        fileName,
      )
        .then((r) => report(r))
        .catch(() => {
          // 矢量导出失败回退整页位图（300DPI），保证用户一定能拿到文件
          try {
            const bytes = exportPagesPdf(paper.w, paper.h, renderAll(EXPORT_DPI / 25.4), fileName);
            if (bytes) report(saveBytes(bytes, fileName));
            else setMsg('导出失败：矢量与位图两条路径都不可用');
          } catch (e) {
            // 回退路径自身也可能抛（画布被污染等）：必须落到界面，否则只有一条控制台告警
            setMsg(`导出失败：${e instanceof Error ? e.message : String(e)}`);
          }
        })
        .finally(() => setBusy(false));
    }, 30);
  }

  // 打印：与导出同源的矢量拼版 PDF → 主进程 PDFium 静默直出（纸张跟随 PDF）；
  // 矢量编码不可用时回退 300DPI 整页位图，保证任何环境下都能出纸
  async function doPrint() {
    const api = (window as unknown as { electronAPI?: { print?: (o: unknown) => void } })
      .electronAPI;
    if (pages.length === 0) {
      if (api?.print) api.print({ ...presetPrintOpts(), copies: 1 });
      else window.print();
      return;
    }
    setBusy(true);
    setMsg('正在生成打印任务…');
    const vectorPages = pages.map((pg) =>
      (pg ?? []).map((idx) => ({
        img: expanded[idx]?.corrected?.img ?? expanded[idx]?.img,
        rotation: expanded[idx]?.rotation ?? 0,
      })),
    );
    try {
      let bytes: Uint8Array | null = null;
      try {
        bytes = await exportVectorSheetPdf({
          paper,
          placements,
          pages: vectorPages,
          style: { colorMode, sat, sharpen, cropMarks, wm: { on: wmOn, text: wmText } },
          dpi: EXPORT_DPI,
        });
      } catch {
        bytes = exportPagesPdf(paper.w, paper.h, renderAll(EXPORT_DPI / 25.4), '证卡拼版_打印.pdf');
      }
      if (!bytes) {
        setMsg('打印失败：无法生成打印文件');
        return;
      }
      // 证卡是小纸张、字小，栅格化提到 400DPI
      const r = await printPdfBytes(bytes, { ...presetPrintOpts(), dpi: 400, copies: 1 });
      setMsg(r.ok ? '已发送到打印机' : `打印失败：${r.reason || r.error || '未知原因'}`);
    } catch (e) {
      setMsg(`打印失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // 多页导出在这个 cbar 信息位反馈结果，不新增 UI
  const [msg, setMsg] = useState('');

  // 导出后统一反馈：桌面端报真实路径/失败原因，浏览器环境只说「已开始下载」
  function report(r: SaveOutcome | Promise<SaveOutcome>) {
    void Promise.resolve(r).then((v) => {
      setMsg(outcomeMessage(v));
      void revealIfWanted(v.path, v.fallback);
    });
  }

  function exportImages(type: 'png' | 'jpeg') {
    if (pages.length === 0) return;
    setBusy(true);
    setMsg('');
    setTimeout(async () => {
      try {
        if (type === 'png') {
          // 多页 PNG：一次选目录批量写入，桌面端不再一个个弹保存框
          const cvs = renderAll(EXPORT_DPI / 25.4);
          const payload = await Promise.all(
            cvs.map(async (cv, i) => ({
              name: `证卡拼版_第${i + 1}页.png`,
              data: await bytesOf(cv.toDataURL('image/png')),
            })),
          );
          // 多页 PNG：多的时候几十张，写盘期间给出进度而不是让用户干等
          const res = await saveBatch(payload, {
            onProgress: (p) => setMsg(`正在写入第 ${p.done}/${p.total} 页…`),
          });
          setMsg(res.cancelled ? '已取消保存' : batchMessage(res));
          void revealIfWanted(res.dir ?? undefined);
        } else {
          const cv = previewRef.current;
          if (cv) report(saveDataUrl(cv.toDataURL('image/jpeg', 0.92), `证卡拼版_第${cur + 1}页.jpg`));
        }
      } catch (e) {
        setMsg(`导出失败：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    }, 30);
  }

  // 右侧汇总
  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of checked) m.set(it.type, (m.get(it.type) ?? 0) + 1);
    return Array.from(m.entries()).map(([t, n]) => `${n}张${cardTypeOf(t).name}`);
  }, [checked]);
  const scaleNote =
    grid.scale < 1 ? `空间已缩小至 ${Math.round(grid.scale * 100)}%` : '空间未缩小';

  const cropItem =
    cropKey != null ? items.find((it) => it.key === cropKey) ?? null : null;

  return (
    <div className="icw">
      {/* ===== 左栏：照片卡列表 ===== */}
      <section className="icw-col icw-left">
        <div className="icw-toolbar">
          <label className="chk">
            <input type="checkbox" checked={allChecked} onChange={toggleAll} />
            全选 {items.length} 张
          </label>
          <button className="btn" onClick={() => inputRef.current?.click()}>
            添加照片
          </button>
          <button className="btn" disabled={items.length === 0} onClick={() => enqueueOcr(items, true)}>
            识别类型
          </button>
          <select value={sortMode} onChange={(e) => applySort(e.target.value as 'import' | 'name')}>
            <option value="import">导入顺序</option>
            <option value="name">按文件名</option>
          </select>
          <button
            className="btn danger"
            disabled={items.length === 0}
            onClick={() => {
              setItems([]);
              setPageIdx(0);
            }}
          >
            清空
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              handleFiles(e.target.files);
              // 清空 value：同一批文件「清空列表后再次导入」时 change 才会再次触发
              e.currentTarget.value = '';
            }}
          />
        </div>

        {notice && items.length === 0 && (
          <div className="notice-card">
            <div className="notice-head">
              <b>手动模式说明</b>
              <button className="link" onClick={() => setNotice(false)}>
                知道了
              </button>
            </div>
            <p>
              已内置<b>证件边缘自动检测</b>（本地算法，离线可用）：导入时自动找出卡面四角、做透视校正，
              并自动摆正横竖方向与纠正<b>上下颠倒</b>的翻拍，一张图里有多张证件时会自动拆成多条。
              检测置信度低时照片会标为<b>「需检查」</b>。
              点卡片操作行的<b>裁切按钮</b>可手动拖动角点、旋转、实时预览并应用校正，应用后排版与导出均使用矫正后的结果。
            </p>
          </div>
        )}

        {ocrMsg && <div className="ph-ocr-global muted">{ocrMsg}</div>}

        <div
          className={'icw-cards' + (dragOver ? ' over' : '')}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            handleFiles(e.dataTransfer.files);
          }}
        >
          {items.length === 0 && (
            <div className="empty-preview" onClick={() => inputRef.current?.click()}>
              {busy ? '读取中…' : '点击或拖拽证件照片到此处（可多选）'}
            </div>
          )}
          {items.map((it, i) => {
            const t = cardTypeOf(it.type);
            const needs = !it.manual && !it.auto && it.confidence < NEED_CHECK;
            const badge = it.auto ? '已校正' : needs ? '需检查' : it.checked ? '可导出' : '已排除';
            const shown = it.corrected?.dataUrl ?? it.dataUrl;
            return (
              <div key={it.key} className={'ph-card' + (it.checked ? ' on' : '')}>
                <label className="ph-check" title="参与排版">
                  <input
                    type="checkbox"
                    checked={it.checked}
                    onChange={(e) => update(it.key, { checked: e.target.checked })}
                  />
                </label>
                <span
                  className={'ph-badge ' + (needs ? 'warn' : 'ok')}
                  title={`自动检测置信度 ${Math.round(it.confidence * 100)}%`}
                >
                  {badge}
                </span>
                <div className="ph-imgbox">
                  <img
                    src={shown}
                    alt={it.name}
                    style={{ transform: `rotate(${it.rotation}deg)` }}
                  />
                  <span className="ph-ratio">
                    {Math.round(t.w)}×{Math.round(t.h)}
                  </span>
                </div>
                {it.manual && <div className="ph-msg">已应用手动角点校正。</div>}
                <select
                  className="ph-type"
                  value={it.type}
                  onChange={(e) => update(it.key, { type: e.target.value, typeManual: true })}
                >
                  {CARD_TYPES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <div className="ph-ocr">
                  {it.ocr === 'running' ? (
                    <span className="muted">识别中…</span>
                  ) : it.ocr === 'done' ? (
                    <span className={it.ocrHits && it.ocrHits.length > 0 ? 'ok' : 'muted'}>
                      {it.ocrHits && it.ocrHits.length > 0
                        ? `已识别：${CARD_TYPES.find((c) => c.id === it.type)?.name ?? it.type}`
                        : '未识别出，请手动选择'}
                    </span>
                  ) : it.ocr === 'fail' ? (
                    <span className="warn">识别失败</span>
                  ) : (
                    <span className="muted">未识别</span>
                  )}
                  <button
                    className="link"
                    disabled={it.ocr === 'running'}
                    onClick={() => enqueueOcr([it], true)}
                    title={it.ocrHits && it.ocrHits.length ? `命中：${it.ocrHits.join('、')}` : '重新识别'}
                  >
                    重新识别
                  </button>
                </div>
                <div className="ph-copies">
                  <span>份数</span>
                  <button
                    title="减少份数"
                    disabled={(it.copies ?? 1) <= 1}
                    onClick={() => update(it.key, { copies: Math.max(1, (it.copies ?? 1) - 1) })}
                  >
                    −
                  </button>
                  <em>{(it.copies ?? 1)}</em>
                  <button
                    title="增加份数"
                    onClick={() => update(it.key, { copies: (it.copies ?? 1) + 1 })}
                  >
                    ＋
                  </button>
                </div>
                <div className="ph-ops">
                  <button title="上移" disabled={i === 0} onClick={() => move(it.key, -1)}>
                    ↑
                  </button>
                  <button
                    title="下移"
                    disabled={i === items.length - 1}
                    onClick={() => move(it.key, 1)}
                  >
                    ↓
                  </button>
                  <button
                    title="旋转90°"
                    onClick={() => update(it.key, { rotation: (it.rotation + 90) % 360 })}
                  >
                    ⟳
                  </button>
                  <button title="手动裁切 / 角点校正" onClick={() => setCropKey(it.key)}>
                    ⛶
                  </button>
                  <button title="删除" className="del" onClick={() => remove(it.key)}>
                    🗑
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ===== 中栏：画布 ===== */}
      <section className="icw-center">
        <div className="icw-cbar">
          <span className="icw-cbar-info">
            {paper.name}·共 {pages.length} 页 PDF
            <em>｜{busy ? '处理中…' : msg || `${expanded.length} 张待排版（含份数）`}</em>
          </span>
          <span className="icw-cbar-btns">
            <button className="btn primary" disabled={pages.length === 0 || busy} onClick={doExportPdf}>
              导 PDF
            </button>
            <button className="btn" disabled={pages.length === 0 || busy} onClick={doPrint}>
              打印
            </button>
            <button
              className="btn"
              disabled={pages.length === 0 || busy}
              onClick={() => exportImages('png')}
            >
              导出图片
            </button>
            <button
              className="btn"
              disabled={pages.length === 0 || busy}
              onClick={() => exportImages('jpeg')}
            >
              另存图片
            </button>
          </span>
        </div>
        {pages.length > 0 && (
          <div className="icw-pager">
            <button disabled={cur === 0} onClick={() => setPageIdx(cur - 1)}>
              ‹
            </button>
            <span>
              {cur + 1} / {pages.length}
            </span>
            <button disabled={cur >= pages.length - 1} onClick={() => setPageIdx(cur + 1)}>
              ›
            </button>
          </div>
        )}
        <div className="icw-canvas-wrap">
          <canvas ref={previewRef} className="sheet-canvas icw-canvas" />
          {pages.length === 0 && (
            <div className="empty-preview icw-empty">导入照片后在此显示排版预览</div>
          )}
        </div>
      </section>

      {/* ===== 右栏：排版设置 ===== */}
      <section className="icw-col icw-right">
        <div className="icw-summary">
          <b>{typeCounts.length ? typeCounts.join(' + ') : '未选择照片'}</b>
          <span>
            {paper.name} {orient === 'p' ? '竖放' : '横放'} · {scaleNote}
          </span>
        </div>

        <div className="icw-sec">
          <h4>纸张尺寸</h4>
          <div className="seg">
            {(['a4', 'a5', 'a3'] as PaperId[]).map((id) => (
              <button
                key={id}
                className={'seg-btn' + (paperId === id ? ' active' : '')}
                onClick={() => setPaperId(id)}
              >
                {id.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="seg" style={{ marginTop: 6 }}>
            <button
              className={'seg-btn' + (orient === 'p' ? ' active' : '')}
              onClick={() => setOrient('p')}
            >
              ▯ 竖向
            </button>
            <button
              className={'seg-btn' + (orient === 'l' ? ' active' : '')}
              onClick={() => setOrient('l')}
            >
              ▭ 横向
            </button>
          </div>
        </div>

        <div className="icw-sec">
          <h4>每页张数</h4>
          <div className="cnt-grid">
            {([1, 2, 3, 4] as const).map((n) => (
              <button
                key={n}
                className={'cnt-btn' + (perPage === n ? ' active' : '')}
                onClick={() => setPerPage(n)}
              >
                {n}张
              </button>
            ))}
            <button
              className={'cnt-btn' + (perPage === 'auto' ? ' active' : '')}
              onClick={() => setPerPage('auto')}
              title="自动铺满一页"
            >
              更多
            </button>
          </div>
          <label className="chk" style={{ marginTop: 6 }}>
            <input
              type="checkbox"
              checked={shrink}
              onChange={(e) => setShrink(e.target.checked)}
            />
            放不下时缩小排版
          </label>
        </div>

        <div className="icw-sec">
          <h4>布局算法</h4>
          <div className="seg">
            {LAYOUT_ALGOS.map((a) => (
              <button
                key={a.id}
                className={'seg-btn' + (algo === a.id ? ' active' : '')}
                onClick={() => setAlgo(a.id)}
              >
                {a.name}
              </button>
            ))}
          </div>
          <label className="chk" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={showGuide} onChange={(e) => setShowGuide(e.target.checked)} />
            预览参考线（头肩定位，不烧入导出）
          </label>
          <label className="chk" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={cropMarks} onChange={(e) => setCropMarks(e.target.checked)} />
            导出蚂蚁线裁切口
          </label>
        </div>

        <div className="icw-sec">
          <h4>证件识别</h4>
          <label className="chk">
            <input
              type="checkbox"
              checked={enhanceModel}
              onChange={(e) => setEnhanceModel(e.target.checked)}
              disabled={!cardCorrectAvailable()}
            />
            增强模型（AI 卡面精定位{cardCorrectAvailable() ? '·已内置' : '·桌面端可用'}）
          </label>
          <label className="chk" style={{ marginTop: 6 }}>
            <input
              type="checkbox"
              checked={autoCorrect}
              onChange={(e) => setAutoCorrect(e.target.checked)}
            />
            识别置信度高时自动校正
          </label>
          <label className="chk" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={useML} onChange={(e) => setUseML(e.target.checked)} />
            抠图增强识别（实验·经典检测不足时）
          </label>
          <p className="hint">
            增强模型=爱印同款「卡证矫正 FP32」：整图神经网络定位卡面四角+自动摆正，失败或未检出时自动回退本地边缘检测。不准时点卡片的 ⛶ 手动裁切修正。
          </p>
        </div>

        <div className="icw-sec">
          <h4>版面位置</h4>
          <div className="seg">
            {(
              [
                ['tl', '左上'],
                ['center', '居中'],
                ['br', '右下'],
              ] as [Pos, string][]
            ).map(([v, label]) => (
              <button
                key={v}
                className={'seg-btn' + (pos === v ? ' active' : '')}
                onClick={() => setPos(v)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="slider-row">
            <span>上下移缩</span>
            <input
              type="range"
              min={-79}
              max={79}
              value={offY}
              onChange={(e) => setOffY(Number(e.target.value))}
            />
            <em>{offY} mm</em>
          </div>
          <div className="slider-row">
            <span>左右移缩</span>
            <input
              type="range"
              min={-80}
              max={80}
              value={offX}
              onChange={(e) => setOffX(Number(e.target.value))}
            />
            <em>{offX} mm</em>
          </div>
        </div>

        <div className="icw-sec">
          <h4>图片间距</h4>
          <div className="slider-row">
            <span>间距</span>
            <input
              type="range"
              min={0}
              max={60}
              value={gap}
              onChange={(e) => setGap(Number(e.target.value))}
            />
            <em>{gap} mm</em>
          </div>
        </div>

        <div className="icw-sec">
          <h4>色彩模式</h4>
          <div className="seg">
            {(
              [
                ['enhance', '打印增强'],
                ['bw', '黑白'],
                ['color', '彩色'],
              ] as [ColorMode, string][]
            ).map(([v, label]) => (
              <button
                key={v}
                className={'seg-btn' + (colorMode === v ? ' active' : '')}
                onClick={() => setColorMode(v)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="slider-row">
            <span>浓度</span>
            <input
              type="range"
              min={0}
              max={100}
              value={sat}
              onChange={(e) => setSat(Number(e.target.value))}
            />
            <em>{sat}%</em>
          </div>
          <div className="slider-row">
            <span>锐度</span>
            <input
              type="range"
              min={-15}
              max={15}
              value={sharpen}
              onChange={(e) => setSharpen(Number(e.target.value))}
            />
            <em>{sharpen}</em>
          </div>
        </div>

        <div className="icw-sec">
          <label className="chk">
            <input type="checkbox" checked={wmOn} onChange={(e) => setWmOn(e.target.checked)} />
            添加水印
          </label>
          {wmOn && (
            <input
              className="wm-text"
              value={wmText}
              onChange={(e) => setWmText(e.target.value)}
              placeholder="水印文字"
            />
          )}
        </div>

        <div className="hint">
          每页 {grid.perPage} 张 · 网格 {grid.cols}×{grid.usedRows}（最大可容 {grid.capacity} 张）。
          「打印」输出当前页；多页请用「导 PDF」。
        </div>
      </section>

      {cropItem && (
        <ManualCropModal
          name={cropItem.name}
          dataUrl={cropItem.corrected?.dataUrl ?? cropItem.dataUrl}
          initialQuad={cropItem.corrected ? FULL_QUAD : cropItem.quad}
          cardW={cardTypeOf(cropItem.type).w}
          cardH={cardTypeOf(cropItem.type).h}
          onCancel={() => setCropKey(null)}
          onApply={(r) => {
            update(cropItem.key, { corrected: r, manual: true });
            setCropKey(null);
          }}
        />
      )}
    </div>
  );
}
