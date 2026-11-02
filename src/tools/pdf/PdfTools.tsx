// PDF 工具箱主界面：左侧分类导航 + 工具列表，右侧文件输入 / 参数 / 自定义面板 / 结果。
// 全部本地执行，无网络请求；UI 与工作台设计令牌保持一致。
import { useEffect, useRef, useState } from 'react';
import { PDFDocument } from 'pdf-lib';
import { useHotkeyActions } from '../../lib/hotkeys';
import { sendToBatchPrint } from '../../lib/handoff';
import {
  saveBytes,
  saveBlob,
  saveBatch,
  outcomeMessage,
  batchMessage,
  revealIfWanted,
  type SaveOutcome,
} from '../../lib/exporter';
import {
  mergePdfFiles,
  interleaveMerge,
  splitPdfMulti,
  splitByBookmarks,
  explodeBookmarks,
  reorderPages,
  reversePages,
  padEvenPages,
  deletePages,
  removeBlankPages,
  nupLayout,
  bookletImpose,
  imagesToPdf,
  createBlankPdf,
  addPageNumbers,
  batesNumbers,
  textWatermark,
  imageWatermark,
  seamStamp,
  compressPdf,
  decryptPdf,
  encryptPdf,
  packZip,
  splitSpreadPages,
  formatBytes,
  type MultiOut,
  type SplitMode,
  type BlankPad,
  type BookletSize,
  type ImagePageSize,
  type NumberTemplate,
} from '../../lib/pdfTools';
import { unifyPageSize, rotatePdf, rotatePdfByPage, PAPER_SIZES_PT, type FitMode } from '../../lib/pdfOps';
import {
  analyzeBlankPages,
  cropWhiteBorders,
  deskewPdf,
  rebuildPdfAsImages,
  flattenPdf,
  pdfToImagesZip,
  extractImagesZip,
  bookletSplit,
  type PageFilter,
  type SplitDir,
} from '../../lib/pdfRaster';
import { annotatePdf, type AnnotItem, type AnnotKind } from '../../lib/pdfAnnot';
import { CATS, TOOLS, TOOL_MAP, defaultParams, type CatId, type ParamValue, type ToolDef } from './defs';
import { ParamRows } from './ParamPanel';
import {
  ReorderPanel,
  RotatePanel,
  BookmarkPanel,
  WmPosPanel,
  AnnotatePanel,
  MetadataPanel,
  SignaturePanel,
} from './CustomPanels';

interface FileEntry {
  name: string;
  data: Uint8Array;
  size: number;
}

type Out =
  | { kind: 'single'; name: string; data: Uint8Array; note?: string }
  | { kind: 'multi'; files: MultiOut[]; note?: string }
  | { kind: 'zip'; name: string; blob: Blob; note?: string };

function stemOf(name: string): string {
  return name.replace(/\.pdf$/i, '');
}

function fmtSize(n: number): string {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

// 导出统一走 exporter：桌面端原子写盘并拿到真实路径，浏览器环境回退下载。
// 叫「结果」而不是「PDF」—— 这里也用来存打包出来的 zip。
async function saveResult(data: Uint8Array | Blob, name: string): Promise<SaveOutcome> {
  return data instanceof Blob
    ? saveBlob(data, name)
    : saveBytes(data, name, { filters: [{ name: 'PDF 文档', extensions: ['pdf'] }] });
}

function acceptOf(def: ToolDef): string {
  if (def.accept) return def.accept;
  if (def.input === 'image-multi') return 'image/jpeg,image/png';
  return '.pdf,application/pdf';
}

export default function PdfTools() {
  const [cat, setCat] = useState<CatId>('page');
  const [toolId, setToolId] = useState('merge');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [params, setParams] = useState<Record<string, ParamValue>>({});
  const [wmImg, setWmImg] = useState<{ name: string; data: Uint8Array } | null>(null);
  const [order, setOrder] = useState<number[]>([]);
  const [angles, setAngles] = useState<number[]>([]);
  const [bookmarkSel, setBookmarkSel] = useState<number[]>([]);
  const [wmPos, setWmPos] = useState({ x: 0.5, y: 0.5 });
  const [annotItems, setAnnotItems] = useState<AnnotItem[]>([]);
  const [out, setOut] = useState<Out | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const fileRef = useRef<HTMLInputElement | null>(null);
  const wmRef = useRef<HTMLInputElement | null>(null);

  const def = TOOL_MAP[toolId] ?? TOOLS[0];
  const one = files[0] ?? null;

  useHotkeyActions('pdf-tools', 'PDF 工具箱', {
    import: () => fileRef.current?.click(),
  });

  // 切换工具：重置参数与结果，保留已选文件
  useEffect(() => {
    setParams(defaultParams(def));
    setOut(null);
    setMsg('');
    setWmImg(null);
    setBookmarkSel([]);
    setAnnotItems([]);
    setWmPos({ x: 0.5, y: 0.5 });
  }, [def]);

  // 单文件工具：载入页数，初始化重排顺序与逐页角度
  const oneData = one?.data ?? null;
  useEffect(() => {
    if (!oneData) {
      setOrder([]);
      setAngles([]);
      return;
    }
    let alive = true;
    PDFDocument.load(oneData, { ignoreEncryption: true })
      .then((d) => {
        if (!alive) return;
        const n = d.getPageCount();
        setOrder(Array.from({ length: n }, (_, i) => i));
        setAngles(Array.from({ length: n }, () => 0));
      })
      .catch(() => {
        /* 页数仅用于自定义面板初始化，失败时保持空 */
      });
    return () => {
      alive = false;
    };
  }, [oneData]);

  function onParam(key: string, v: ParamValue) {
    setParams((prev) => ({ ...prev, [key]: v }));
    setOut(null);
  }

  function pickCat(id: CatId) {
    setCat(id);
    const first = TOOLS.find((t) => t.cat === id);
    if (first) setToolId(first.id);
  }

  async function pickFiles(list: FileList | null) {
    if (!list) return;
    const arr = Array.from(list);
    const keep =
      def.input === 'image-multi'
        ? arr.filter((f) => /\.(jpe?g|png)$/i.test(f.name))
        : arr.filter((f) => /\.pdf$/i.test(f.name));
    if (!keep.length) {
      setMsg(def.input === 'image-multi' ? '只支持 JPG / PNG 图片' : '只支持 PDF 文件');
      return;
    }
    const entries: FileEntry[] = [];
    for (const f of keep) entries.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()), size: f.size });
    setFiles((prev) => (def.input === 'single' ? entries.slice(0, 1) : [...prev, ...entries]));
    setOut(null);
    setMsg('');
  }

  async function pickWm(list: FileList | null) {
    const f = list?.[0];
    if (!f) return;
    setWmImg({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
  }

  function moveFile(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= files.length) return;
    const next = [...files];
    [next[i], next[j]] = [next[j], next[i]];
    setFiles(next);
    setOut(null);
  }

  const s = (key: string) => String(params[key] ?? '');
  const n = (key: string) => Number(params[key] ?? 0);
  const b = (key: string) => Boolean(params[key]);
  const suffix = (sfx: string) => `${stemOf(one!.name)}${sfx}.pdf`;

  function canRun(): boolean {
    if (busy) return false;
    if (def.input === 'none') return true;
    if (def.input === 'single') return !!one;
    if (def.run === 'imageWatermark') return files.length > 0 && !!wmImg;
    return files.length > 0;
  }

  // 「文档属性」「签名检查」由各自自定义面板的按钮独立完成，主「执行」按钮对它们无效，隐藏以免误导
  const panelOnlyTool = def.custom === 'metadata' || def.custom === 'signature';

  async function dispatch(): Promise<Out | null> {
    // input==='none' 的工具（如「新建空白文档」）不需要已打开的 PDF，此时 one 为 null；
    // 这类工具的 case 不会读取 doc0，故这里对 one 做空值兜底，避免顶层解引用崩溃。
    const doc0 = one ? one.data : (null as unknown as Uint8Array);
    const inputs = files.map((f) => ({ name: f.name, data: f.data }));
    switch (def.run) {
      case 'merge': {
        const data = await mergePdfFiles(inputs, {
          compatMode: b('compatMode'),
          dpi: n('dpi'),
          pageSize: s('pageSize'),
        });
        return { kind: 'single', name: '合并文档.pdf', data, note: `${files.length} 个文件已合并（${formatBytes(data.byteLength)}）` };
      }
      case 'interleave': {
        const data = await interleaveMerge(inputs);
        return { kind: 'single', name: '交叉合并.pdf', data, note: `已逐页交叉（${formatBytes(data.byteLength)}）` };
      }
      case 'split':
      case 'extract':
      case 'fixedSplit':
      case 'oddEven': {
        const mode: SplitMode =
          def.run === 'split' ? (s('mode') as SplitMode) : def.run === 'extract' ? 'ranges' : def.run === 'fixedSplit' ? 'fixed' : 'oddeven';
        const filesOut = await splitPdfMulti(doc0, one!.name, { mode, ranges: s('range'), fixed: n('fixed') });
        return { kind: 'multi', files: filesOut, note: `拆出 ${filesOut.length} 个文件` };
      }
      case 'splitBookmark': {
        const data = await splitByBookmarks(doc0, bookmarkSel);
        return { kind: 'single', name: '按书签拆分.pdf', data, note: `已拆出 ${bookmarkSel.length} 个章节` };
      }
      case 'explodeBookmark': {
        const filesOut = await explodeBookmarks(doc0, one!.name, {
          addIndex: b('addIndex'),
          useFileNamePrefix: b('useFileNamePrefix'),
          useBookmarkName: b('useBookmarkName'),
          keepHierarchy: b('keepHierarchy'),
          maxDepth: n('maxDepth'),
        });
        return { kind: 'multi', files: filesOut, note: `炸开为 ${filesOut.length} 个文件` };
      }
      case 'delete': {
        const data = await deletePages(doc0, s('range'));
        return { kind: 'single', name: suffix('_已删除'), data, note: '删除完成' };
      }
      case 'reorder': {
        const data = await reorderPages(doc0, { order });
        return { kind: 'single', name: suffix('_整理'), data, note: `已按新顺序重排 ${order.length} 页` };
      }
      case 'reverse': {
        const data = await reversePages(doc0);
        return { kind: 'single', name: suffix('_倒序'), data, note: '页序已倒转' };
      }
      case 'padEven': {
        const data = await padEvenPages(doc0, s('mode') as BlankPad);
        return { kind: 'single', name: suffix('_补齐'), data, note: '已补齐为偶数页' };
      }
      case 'removeBlank': {
        const flags = await analyzeBlankPages(doc0, n('thresholdPct'));
        const removed: number[] = [];
        flags.forEach((f, i) => {
          if (f) removed.push(i + 1);
        });
        if (removed.length === 0) return { kind: 'single', name: one!.name, data: doc0, note: '没有发现空白页，文档未改动' };
        const data = await removeBlankPages(doc0, flags);
        return { kind: 'single', name: suffix('_去空白'), data, note: `已删除空白页：第 ${removed.join('、')} 页` };
      }
      case 'rotate': {
        // 优先使用「逐页角度」面板设置的角度；若所有页都为 0，则退回到全局角度参数
        const anyPerPage = angles.some((a) => a !== 0);
        if (anyPerPage) {
          const data = await rotatePdfByPage(doc0, angles);
          return { kind: 'single', name: suffix('_旋转'), data, note: '已按逐页角度旋转' };
        }
        const angle = Number(s('angle')) as 90 | 180 | 270;
        const data = await rotatePdf(doc0, angle, s('range'));
        return { kind: 'single', name: suffix(`_旋转${angle}`), data, note: '旋转完成' };
      }
      case 'unify': {
        const p = PAPER_SIZES_PT.find((x) => x.name === s('size'));
        if (!p) throw new Error('未知纸张尺寸');
        const data = await unifyPageSize(doc0, { w: p.w, h: p.h }, s('mode') as FitMode, s('range'));
        return { kind: 'single', name: suffix(`_${p.name}`), data, note: `已统一为 ${p.name}` };
      }
      case 'crop': {
        const r = await cropWhiteBorders(doc0, { threshold: n('threshold'), marginMm: n('marginMm') });
        return { kind: 'single', name: suffix('_裁切'), data: r.data, note: `已裁切 ${r.cropped} 页` };
      }
      case 'deskew': {
        const data = await deskewPdf(doc0, { auto: b('auto'), angle: n('angle'), dpi: n('dpi') });
        return { kind: 'single', name: suffix('_纠偏'), data, note: '纠偏完成' };
      }
      case 'spread': {
        const data = await splitSpreadPages(doc0, b('force'));
        return { kind: 'single', name: suffix('_对开切分'), data, note: '切分完成' };
      }
      case 'nup': {
        const data = await nupLayout(doc0, {
          cols: n('cols'),
          rows: n('rows'),
          order: s('order') as 'row' | 'col',
          marginMm: n('marginMm'),
          gapMm: n('gapMm'),
          border: b('border'),
          skipEmpty: b('skipEmpty'),
        });
        return { kind: 'single', name: suffix(`_${n('cols')}x${n('rows')}拼版`), data, note: '拼版完成' };
      }
      case 'booklet': {
        const data = await bookletImpose(doc0, s('size') as BookletSize);
        return { kind: 'single', name: suffix('_骑马订'), data, note: '拼版完成' };
      }
      case 'bookletSplit': {
        const data = await bookletSplit(inputs, s('dir') as SplitDir);
        return { kind: 'single', name: '折页拆分.pdf', data, note: `已处理 ${files.length} 个文件` };
      }
      case 'imgToPdf': {
        const data = await imagesToPdf(inputs, {
          pageSize: s('pageSize') as ImagePageSize,
          landscape: b('landscape'),
          marginMm: n('marginMm'),
          fit: s('fit') as FitMode,
          background: s('background'),
        });
        return { kind: 'single', name: '图片合档.pdf', data, note: `${files.length} 张图片已合成（${formatBytes(data.byteLength)}）` };
      }
      case 'blank': {
        const data = await createBlankPdf({
          preset: s('preset'),
          customW: n('customW'),
          customH: n('customH'),
          landscape: b('landscape'),
          count: n('count'),
          grid: s('grid') as 'none' | 'quad' | 'ruled' | 'dotted',
          lineColor: s('lineColor'),
          lineSpacingMm: n('lineSpacingMm'),
          header: s('header'),
          footer: s('footer'),
        });
        return { kind: 'single', name: `空白文档_${n('count')}页.pdf`, data, note: '已生成' };
      }
      case 'pageNumbers': {
        const data = await addPageNumbers(doc0, {
          template: s('template') as NumberTemplate,
          position: s('position'),
          sizePt: n('sizePt'),
          color: s('color'),
          marginMm: n('marginMm'),
          startAt: n('startAt'),
          range: s('range'),
          font: s('font') as 'regular' | 'bold',
        });
        return { kind: 'single', name: suffix('_页码'), data, note: '页码已添加' };
      }
      case 'toImages': {
        const blob = await pdfToImagesZip(doc0, one!.name, {
          dpi: n('dpi'),
          format: s('format') as 'image/jpeg' | 'image/png',
          quality: n('quality'),
        });
        return { kind: 'zip', name: `${stemOf(one!.name)}_图片.zip`, blob, note: '已打包为 ZIP' };
      }
      case 'extractImages': {
        const blob = await extractImagesZip(doc0, one!.name);
        return { kind: 'zip', name: `${stemOf(one!.name)}_内嵌图片.zip`, blob, note: '已打包为 ZIP' };
      }
      case 'toImageDoc': {
        const filter = s('filter');
        const data = await rebuildPdfAsImages(doc0, {
          dpi: n('dpi'),
          filter: filter === 'none' ? undefined : (filter as PageFilter),
        });
        return { kind: 'single', name: suffix('_图片版'), data, note: '已转为图片版' };
      }
      case 'gray': {
        const data = await rebuildPdfAsImages(doc0, { dpi: n('dpi'), filter: 'gray' });
        return { kind: 'single', name: suffix('_灰度'), data, note: '已转灰度' };
      }
      case 'blueprint': {
        const data = await rebuildPdfAsImages(doc0, { dpi: n('dpi'), blueprint: true });
        return { kind: 'single', name: suffix('_蓝底'), data, note: '已转蓝图' };
      }
      case 'compress': {
        const r = await compressPdf(doc0, s('mode') as 'light' | 'deep', n('dpi'));
        const pct = r.before > 0 ? Math.round((1 - r.after / r.before) * 100) : 0;
        return {
          kind: 'single',
          name: suffix('_压缩'),
          data: r.data,
          note: `${formatBytes(r.before)} → ${formatBytes(r.after)}（${pct >= 0 ? '减小' : '增大'} ${Math.abs(pct)}%）`,
        };
      }
      case 'flatten': {
        const data = await flattenPdf(doc0, n('dpi'));
        return { kind: 'single', name: suffix('_扁平化'), data, note: '已扁平化' };
      }
      case 'textWatermark': {
        const data = await textWatermark(doc0, {
          text: s('text'),
          sizePt: n('sizePt'),
          color: s('color'),
          opacity: n('opacity'),
          angle: n('angle'),
          pos: wmPos,
          tile: b('tile'),
          tileStepMm: n('tileStepMm'),
          range: s('range'),
          bold: b('bold'),
        });
        return { kind: 'single', name: suffix('_水印'), data, note: '水印已添加' };
      }
      case 'imageWatermark': {
        const data = await imageWatermark(doc0, {
          image: wmImg!.data,
          imageName: wmImg!.name,
          scalePct: n('scalePct'),
          opacity: n('opacity'),
          angle: n('angle'),
          pos: wmPos,
          range: s('range'),
        });
        return { kind: 'single', name: suffix('_水印'), data, note: '水印已添加' };
      }
      case 'seam': {
        const data = await seamStamp(doc0, {
          text: s('text'),
          sizePt: n('sizePt'),
          color: s('color'),
          charsPerPage: n('charsPerPage'),
          range: s('range'),
          fan: b('fan'),
        });
        return { kind: 'single', name: suffix('_接缝'), data, note: '接缝标记已添加' };
      }
      case 'annotate': {
        const data = await annotatePdf(doc0, annotItems);
        return { kind: 'single', name: suffix('_批注'), data, note: `已添加 ${annotItems.length} 条批注` };
      }
      case 'bates': {
        const filesOut = await batesNumbers(inputs, {
          prefix: s('prefix'),
          suffix: s('suffix'),
          start: n('start'),
          digits: n('digits'),
          position: s('position'),
          sizePt: n('sizePt'),
          color: s('color'),
          marginMm: n('marginMm'),
          range: s('range'),
          merge: b('merge'),
        });
        return { kind: 'multi', files: filesOut, note: `已编号 ${filesOut.length} 个文件` };
      }
      case 'encrypt': {
        const data = await encryptPdf(doc0, {
          userPassword: s('userPassword'),
          ownerPassword: s('ownerPassword'),
          printing: b('printing'),
          copying: b('copying'),
          modifying: b('modifying'),
          annotating: b('annotating'),
          r3: b('r3'),
        });
        return { kind: 'single', name: suffix('_加密'), data, note: '已加密，请妥善保管密码' };
      }
      case 'decrypt': {
        const data = await decryptPdf(doc0, s('password'));
        return { kind: 'single', name: suffix('_解密'), data, note: '加密已移除' };
      }
      default:
        return null;
    }
  }

  async function run() {
    if (def.input === 'single' && !one) {
      setMsg('请先选择 PDF');
      return;
    }
    if ((def.input === 'multi' || def.input === 'image-multi') && files.length === 0) {
      setMsg(def.input === 'image-multi' ? '请先添加图片' : '请先添加 PDF');
      return;
    }
    if (def.run === 'imageWatermark' && !wmImg) {
      setMsg('请先选择水印图片');
      return;
    }
    if (def.run === 'annotate' && annotItems.length === 0) {
      setMsg('请先在预览页上划选批注区域');
      return;
    }
    setBusy(true);
    setMsg('');
    setOut(null);
    try {
      const r = await dispatch();
      if (r) setOut(r);
      else setMsg('该工具尚未实现');
    } catch (e) {
      setMsg(`失败：${(e as Error)?.message || String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pdfx">
      <aside className="pdfx-side">
        <div className="pdfx-side-title">
          全部工具 <b>{TOOLS.length}</b>
        </div>
        {CATS.map((c) => {
          const list = TOOLS.filter((t) => t.cat === c.id);
          return (
            <div className="pdfx-cat" key={c.id}>
              <button
                className={'pdfx-cat-b' + (cat === c.id ? ' on' : '')}
                onClick={() => pickCat(c.id)}
              >
                <span className="pdfx-cat-ic">{c.icon}</span>
                <span className="pdfx-cat-tx">
                  <b>{c.name}</b>
                  <small>{c.desc}</small>
                </span>
                <span className="pdfx-cat-n">{list.length}</span>
              </button>
              {cat === c.id && (
                <div className="pdfx-tools">
                  {list.map((t) => (
                    <button
                      key={t.id}
                      className={'pdfx-tool' + (toolId === t.id ? ' on' : '')}
                      onClick={() => setToolId(t.id)}
                    >
                      <span className="pdfx-tool-ic">{t.icon}</span>
                      <span className="pdfx-tool-tx">
                        <b>{t.name}</b>
                        <small>{t.desc}</small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div className="pdfx-side-foot muted">全部本地处理，文件不上传</div>
      </aside>

      <section className="pdfx-main">
        <div className="pdfx-head">
          <span className="pdfx-head-ic">{def.icon}</span>
          <div className="pdfx-head-tx">
            <b>{def.name}</b>
            <span className="muted">{def.desc}</span>
          </div>
          {def.hint && <div className="pdfx-head-hint">💡 {def.hint}</div>}
        </div>

        {def.input !== 'none' && (
          <div className="params">
            <div className="param-row">
              <button className="btn primary" onClick={() => fileRef.current?.click()}>
                {def.input === 'single' ? '选择 PDF' : def.input === 'image-multi' ? '添加图片' : '添加 PDF'}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept={acceptOf(def)}
                multiple={def.input !== 'single'}
                hidden
                onChange={(e) => {
                  void pickFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              {def.run === 'imageWatermark' && (
                <>
                  <button className="btn" onClick={() => wmRef.current?.click()}>
                    选择水印图片
                  </button>
                  <input
                    ref={wmRef}
                    type="file"
                    accept="image/jpeg,image/png"
                    hidden
                    onChange={(e) => {
                      void pickWm(e.target.files);
                      e.target.value = '';
                    }}
                  />
                  {wmImg && <span className="tag">{wmImg.name}</span>}
                </>
              )}
              <span className="muted">
                {def.input === 'single'
                  ? one
                    ? `已选择：${one.name}`
                    : '先选一个 PDF'
                  : def.input === 'image-multi'
                    ? `已添加 ${files.length} 张图片`
                    : `已添加 ${files.length} 个文件，按列表顺序处理`}
              </span>
            </div>
            {files.length > 0 && (
              <div className="pdfx-files">
                {files.map((f, i) => (
                  <div className="pp-file" key={`${f.name}-${i}`}>
                    <span className="pp-file-name" title={f.name}>
                      {f.name}
                    </span>
                    <span className="muted">{fmtSize(f.size)}</span>
                    {def.input !== 'single' && (
                      <span className="pdfx-file-ops">
                        <button title="上移" disabled={i === 0} onClick={() => moveFile(i, -1)}>
                          ↑
                        </button>
                        <button title="下移" disabled={i === files.length - 1} onClick={() => moveFile(i, 1)}>
                          ↓
                        </button>
                        <button
                          className="pdfx-file-del"
                          title="移除"
                          onClick={() => {
                            setFiles((prev) => prev.filter((_, j) => j !== i));
                            setOut(null);
                          }}
                        >
                          ×
                        </button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <ParamRows params={def.params} values={params} onChange={onParam} />

        {def.custom === 'reorder' && one && <ReorderPanel data={one.data} order={order} onOrder={setOrder} />}
        {def.custom === 'rotate' && one && <RotatePanel data={one.data} angles={angles} onAngles={setAngles} />}
        {def.custom === 'bookmarks' && one && (
          <BookmarkPanel data={one.data} selected={bookmarkSel} onSelected={setBookmarkSel} />
        )}
        {def.custom === 'wmpos' && one && <WmPosPanel data={one.data} pos={wmPos} onPos={setWmPos} />}
        {def.custom === 'annotate' && one && (
          <AnnotatePanel
            data={one.data}
            items={annotItems}
            onItems={setAnnotItems}
            kind={s('kind') as AnnotKind}
            color={s('color')}
            opacity={n('opacity')}
            note={s('note')}
          />
        )}
        {def.custom === 'metadata' && one && (
          <MetadataPanel
            data={one.data}
            onSaved={(data, note) => {
              setOut({ kind: 'single', name: one.name, data, note });
              setMsg('');
            }}
          />
        )}
        {def.custom === 'signature' && one && <SignaturePanel data={one.data} />}

        <div className="actions">
          {!panelOnlyTool && (
            <button className="btn primary" disabled={!canRun()} onClick={() => void run()}>
              {busy ? '处理中…' : def.input === 'none' ? '生成文档' : '执行'}
            </button>
          )}
          {busy && !panelOnlyTool && <span className="muted">本地处理中，大文件请稍候…</span>}
          {!busy && !panelOnlyTool && def.input !== 'none' && !canRun() && <span className="muted">请先添加文件</span>}
        </div>
        {msg && <div className={'pp-status' + (msg.startsWith('失败') ? ' err' : '')}>{msg}</div>}

        {out && (
          <ResultPanel
            out={out}
            onMsg={setMsg}
            onSent={(name) => setMsg(`已发送到批量打印：${name}`)}
          />
        )}
      </section>
    </div>
  );
}

function ResultPanel({
  out,
  onMsg,
  onSent,
}: {
  out: Out;
  onMsg: (m: string) => void;
  onSent: (name: string) => void;
}) {
  // 以下三个处理函数的调用处都是 onClick={() => void fn()}：
  // 裸 async 的 rejection 会变成 unhandled rejection 且界面零反馈 —— 正是 C 方案要消灭的
  // 「点了就假装成功」。所以这里统一包一层，任何异常都要落到界面上。
  async function packAll(files: MultiOut[]) {
    try {
      const blob = await packZip(files);
      const r = await saveResult(blob, '结果打包.zip');
      onMsg(outcomeMessage(r));
      void revealIfWanted(r.path, r.fallback);
    } catch (e) {
      onMsg(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 单文件导出：桌面端能拿到真实路径与失败原因，不再是「点了就假装成功」
  async function saveOne(data: Uint8Array | Blob, name: string) {
    try {
      const r = await saveResult(data, name);
      onMsg(outcomeMessage(r));
      void revealIfWanted(r.path, r.fallback);
    } catch (e) {
      onMsg(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 批量导出：只弹一次「选择目录」，之后并发原子写入，不再一个个弹保存框
  async function downloadAll(files: MultiOut[]) {
    try {
      const res = await saveBatch(files.map((f) => ({ name: f.name, data: f.data })));
      if (res.cancelled) {
        onMsg('已取消保存');
        return;
      }
      // 一句话说清「成功去哪了 + 失败为什么」。以前这里调用两次 onMsg，
      // 后半句会把前半句（含目标目录）整个顶掉，用户事后不知去哪找文件。
      const summary = batchMessage(res);
      const tail = res.failed.length
        ? `（失败 ${res.failed.length} 个：${res.failed[0].error}${res.failed.length > 1 ? ' 等' : ''}）`
        : '';
      onMsg(summary + tail);
      void revealIfWanted(res.dir ?? undefined, res.fallback);
    } catch (e) {
      onMsg(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (out.kind === 'zip') {
    return (
      <div className="params pdfx-result">
        <div className="param-row">
          <b>结果</b>
          <span className="tag">{out.name}</span>
          <span className="muted">{out.note}</span>
          <span style={{ flex: 1 }} />
          <button className="btn primary" onClick={() => void saveOne(out.blob, out.name)}>
            下载
          </button>
        </div>
      </div>
    );
  }

  if (out.kind === 'single') {
    return (
      <div className="params pdfx-result">
        <div className="param-row">
          <b>结果</b>
          <span className="tag">{out.name}</span>
          <span className="muted">
            {formatBytes(out.data.byteLength)}
            {out.note ? ` · ${out.note}` : ''}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn primary" onClick={() => void saveOne(out.data, out.name)}>
            下载
          </button>
          <button
            className="btn"
            onClick={() => {
              sendToBatchPrint([{ name: out.name, data: out.data }]);
              onSent(out.name);
            }}
          >
            发送到批量打印
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="params pdfx-result">
      <div className="param-row">
        <b>结果</b>
        <span className="muted">
          {out.files.length} 个文件{out.note ? ` · ${out.note}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => void packAll(out.files)}>
          打包 ZIP
        </button>
        <button className="btn primary" onClick={() => void downloadAll(out.files)}>
          全部下载（{out.files.length}）
        </button>
      </div>
      <div className="pdfx-files">
        {out.files.map((f, i) => (
          <div className="pp-file" key={`${f.name}-${i}`}>
            <span className="pp-file-name" title={f.name}>
              {f.name}
            </span>
            <span className="muted">{formatBytes(f.data.byteLength)}</span>
            <button className="pp-del" title="下载" onClick={() => void saveOne(f.data, f.name)}>
              ↓
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
