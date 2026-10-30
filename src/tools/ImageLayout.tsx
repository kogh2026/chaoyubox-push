import { useEffect, useMemo, useRef, useState } from 'react';
import { useHotkeyActions } from '../lib/hotkeys';
import { presetPrintOpts, printPdfBytes } from '../lib/printers';
import { exportPagesPdf } from '../lib/sheetPdf';
import { saveBytes, saveBlob, outcomeMessage, revealIfWanted, type SaveOutcome } from '../lib/exporter';
import {
  DEFAULT_SHEET_LAYOUT,
  PER_PAGE_CHOICES,
  SHEET_PAPER_MM,
  checkSheets,
  detectBlankRows,
  layoutSheets,
  normalizeLayout,
  type SheetIssue,
  type SheetLayout,
  type SheetPaperId,
  type SheetSource,
} from '../lib/photoSheet';
import { EXPORT_PX_PER_MM, renderSheetPage, renderSheetPageToCanvas } from '../lib/photoSheetRender';

/** 预览精度：2.2 px/mm ≈ 56dpi，A4 约 462×653，够看清裁切线又不卡 */
const PREVIEW_PX_PER_MM = 2.2;

interface Loaded {
  id: string;
  name: string;
  img: HTMLImageElement;
  url: string;
  /** 份数；null = 排满这一页（仅排满模式有意义） */
  copies: number | null;
  /** 从这张起另起一组：这一组用这套覆盖设置 */
  section: Partial<SheetLayout> | null;
  /** 逐行空白标记（长图自动分段用） */
  blankRows: Uint8Array | null;
}

let seq = 0;

function loadImage(file: File): Promise<{ img: HTMLImageElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    img.src = url;
  });
}

/** 长图才需要空白行扫描；宽度压到 400px 以内，50 张长图也不至于卡住 */
function scanBlankRows(img: HTMLImageElement): Uint8Array | null {
  const ratio = img.naturalHeight / Math.max(1, img.naturalWidth);
  if (ratio <= 2.5) return null;
  const w = Math.min(400, img.naturalWidth);
  const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  try {
    const data = ctx.getImageData(0, 0, w, h).data;
    return detectBlankRows(data, w, h);
  } catch {
    return null;
  }
}

/** 顺时针旋转 90°：直接换一张位图，排版引擎只认宽高，不用改任何几何 */
function rotateImage(img: HTMLImageElement): Promise<HTMLImageElement> {
  const c = document.createElement('canvas');
  c.width = img.naturalHeight;
  c.height = img.naturalWidth;
  const ctx = c.getContext('2d');
  if (!ctx) return Promise.resolve(img);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  return new Promise((resolve) => {
    const out = new Image();
    out.onload = () => resolve(out);
    out.onerror = () => resolve(img);
    out.src = c.toDataURL('image/jpeg', 0.95);
  });
}

export default function ImageLayout() {
  const [items, setItems] = useState<Loaded[]>([]);
  const [layout, setLayout] = useState<SheetLayout>(DEFAULT_SHEET_LAYOUT);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pageIdx, setPageIdx] = useState(0);
  const [mode, setMode] = useState<'grid' | 'stitch'>('grid');
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // 拼接长图（保留既有能力：分享用）
  const [stitchDir, setStitchDir] = useState<'v' | 'h'>('v');
  const [stitchGap, setStitchGap] = useState(0);
  const stitchRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sources: SheetSource[] = useMemo(
    () =>
      items.map((it) => ({
        blankRows: it.blankRows,
        copies: it.copies,
        height: it.img.naturalHeight,
        id: it.id,
        name: it.name,
        section: it.section,
        width: it.img.naturalWidth,
      })),
    [items],
  );

  const result = useMemo(() => layoutSheets(sources, layout), [sources, layout]);
  const issues: SheetIssue[] = useMemo(() => checkSheets(result, sources), [result, sources]);

  /** 当前选中的图属于哪一组：有 section 的那张是组首，其余跟随前一张 */
  const groupLayout = useMemo(() => {
    const idx = items.findIndex((it) => it.id === activeId);
    if (idx < 0) return layout;
    for (let i = idx; i >= 0; i -= 1) {
      const sec = items[i].section;
      if (sec) return normalizeLayout({ ...layout, ...sec });
      if (i === 0) break;
    }
    return layout;
  }, [activeId, items, layout]);

  /** 改参数：分组内的图改到它自己的 section 上，第一组改全局 */
  function patch(next: Partial<SheetLayout>) {
    const idx = items.findIndex((it) => it.id === activeId);
    const target = idx >= 0 ? (() => {
      for (let i = idx; i >= 0; i -= 1) {
        if (items[i].section) return i;
        if (i === 0) break;
      }
      return -1;
    })() : -1;
    if (target >= 0) {
      const merged = normalizeLayout({ ...groupLayout, ...next });
      setItems((prev) =>
        prev.map((it, i) => (i === target ? { ...it, section: merged } : it)),
      );
    } else {
      setLayout((prev) => normalizeLayout({ ...prev, ...next }));
    }
  }

  function patchFill(next: Partial<SheetLayout['fill']>) {
    patch({ fill: { ...groupLayout.fill, ...next } });
  }

  const imageById = useMemo(() => new Map(items.map((it) => [it.id, it.img] as const)), [items]);
  const previewPage = result.pages[Math.min(pageIdx, Math.max(0, result.pages.length - 1))];
  /** 当前页所属分组：统计文案要显示「这一页」的网格，而不是第一组的 */
  const currentSection =
    result.sections.find((s) => pageIdx >= s.firstPage && pageIdx < s.firstPage + s.pageCount) ??
    result.sections[0];

  useEffect(() => {
    if (!previewRef.current) return;
    if (!previewPage) {
      const c = previewRef.current;
      c.width = 1;
      c.height = 1;
      return;
    }
    renderSheetPage(previewRef.current, previewPage, {
      border: groupLayout.border,
      imageOf: (id) => imageById.get(id) ?? null,
      pxPerMm: PREVIEW_PX_PER_MM,
      watermark: null,
    });
  }, [previewPage, imageById, groupLayout.border]);

  async function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setBusy(true);
    const loaded: Loaded[] = [];
    for (const f of Array.from(list)) {
      if (!f.type.startsWith('image/')) continue;
      try {
        const { img, url } = await loadImage(f);
        seq += 1;
        loaded.push({
          blankRows: scanBlankRows(img),
          copies: null,
          id: `s${seq}`,
          img,
          name: f.name,
          section: null,
          url,
        });
      } catch {
        /* 单张读失败不影响其余 */
      }
    }
    setItems((prev) => [...prev, ...loaded]);
    if (!activeId && loaded.length > 0) setActiveId(loaded[0].id);
    setBusy(false);
  }

  function removeItem(id: string) {
    setItems((prev) => {
      const i = prev.findIndex((it) => it.id === id);
      const next = prev.filter((it) => it.id !== id);
      if (activeId === id) setActiveId(next[Math.min(i, next.length - 1)]?.id ?? null);
      return next;
    });
  }

  function move(id: string, delta: number) {
    setItems((prev) => {
      const i = prev.findIndex((it) => it.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function rotate(id: string) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    const img = await rotateImage(it.img);
    setItems((prev) =>
      prev.map((x) =>
        x.id === id ? { ...x, blankRows: scanBlankRows(img), img } : x,
      ),
    );
  }

  function toggleSection(id: string) {
    // 以「这张图所在组」的现值另起一组，而不是用面板当前显示的 layout —— 点别的图的「组」时
    // activeId 可能不是它，用面板值会把 A 组的设置带到 B 组去
    const idx = items.findIndex((it) => it.id === id);
    let base = layout;
    for (let i = idx; i >= 0 && idx >= 0; i -= 1) {
      if (items[i].section) {
        base = normalizeLayout({ ...layout, ...items[i].section });
        break;
      }
      if (i === 0) break;
    }
    setItems((prev) =>
      prev.map((it) =>
        it.id === id ? { ...it, section: it.section ? null : { ...base } } : it,
      ),
    );
  }

  // 导出后统一反馈：桌面端报真实路径/失败原因，浏览器环境只说已开始下载
  function report(r: SaveOutcome | Promise<SaveOutcome>) {
    void Promise.resolve(r).then((v) => {
      setMsg(v.ok ? outcomeMessage(v) : v.code === 'cancelled' ? '' : v.error || '保存失败');
      void revealIfWanted(v.path, v.fallback);
    });
  }

  /** 拼版 PDF 字节：逐页按 300dpi 出图 → 写满整页。导出与打印同源 */
  function layoutPdfBytes(): { bytes: Uint8Array | null; fileName: string } {
    const fileName = `图片拼版_${SHEET_PAPER_MM[layout.paper].label}.pdf`;
    if (result.pages.length === 0) return { bytes: null, fileName };
    const pages = result.pages.map((page) =>
      renderSheetPageToCanvas(page, {
        border: layout.border,
        imageOf: (id) => imageById.get(id) ?? null,
        pxPerMm: EXPORT_PX_PER_MM,
        watermark: null,
      }),
    );
    const bytes = exportPagesPdf(result.pages[0].widthMm, result.pages[0].heightMm, pages, fileName);
    return { bytes, fileName };
  }

  function exportPdf() {
    if (result.pages.length === 0) return;
    const { bytes, fileName } = layoutPdfBytes();
    if (bytes) report(saveBytes(bytes, fileName));
  }

  async function doPrint() {
    const { bytes } = layoutPdfBytes();
    if (!bytes) {
      window.print();
      return;
    }
    setMsg('正在发送到打印机…');
    const r = await printPdfBytes(bytes, { ...presetPrintOpts(), copies: 1, dpi: 400 });
    setMsg(r.ok ? '已发送到打印机' : `打印失败：${r.reason || r.error || '未知原因'}`);
  }

  /* ---------- 拼接长图（保留既有能力） ---------- */
  const buildStitch = (): HTMLCanvasElement | null => {
    if (items.length === 0) return null;
    const base = 1080;
    const gapPx = (stitchGap / 25.4) * 96;
    if (stitchDir === 'v') {
      const hs = items.map((s) => (base * s.img.naturalHeight) / s.img.naturalWidth);
      const c = document.createElement('canvas');
      c.width = base;
      c.height = Math.round(hs.reduce((a, b) => a + b, 0) + gapPx * (items.length - 1));
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      let y = 0;
      items.forEach((s, i) => {
        ctx.drawImage(s.img, 0, y, base, hs[i]);
        y += hs[i] + gapPx;
      });
      return c;
    }
    const ws = items.map((s) => (base * s.img.naturalWidth) / s.img.naturalHeight);
    const c = document.createElement('canvas');
    c.height = base;
    c.width = Math.round(ws.reduce((a, b) => a + b, 0) + gapPx * (items.length - 1));
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    let x = 0;
    items.forEach((s, i) => {
      ctx.drawImage(s.img, x, 0, ws[i], base);
      x += ws[i] + gapPx;
    });
    return c;
  };

  useEffect(() => {
    if (mode !== 'stitch' || !stitchRef.current) return;
    const c = buildStitch();
    if (!c) return;
    stitchRef.current.width = c.width;
    stitchRef.current.height = c.height;
    stitchRef.current.getContext('2d')!.drawImage(c, 0, 0);
  }, [mode, items, stitchDir, stitchGap]);

  function exportStitch() {
    const c = buildStitch();
    if (!c) return;
    c.toBlob((b) => {
      if (b) report(saveBlob(b, '拼接长图.png'));
    }, 'image/png');
  }

  useHotkeyActions('image-layout', '图片拼版', {
    export: exportPdf,
    import: () => inputRef.current?.click(),
    print: doPrint,
  });

  const paperLabel = `${SHEET_PAPER_MM[layout.paper].label} ${groupLayout.orientation === 'portrait' ? '竖版' : '横版'}`;
  const groupCount = items.filter((it) => it.section).length + (items.length > 0 ? 1 : 0);

  return (
    <div className="il">
      <aside className="il-left">
        <div className="il-left-head">
          <button className="btn primary sm" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? '读取中…' : '添加图片'}
          </button>
          <button
            className="btn sm"
            disabled={items.length === 0}
            onClick={() => {
              setItems([]);
              setActiveId(null);
            }}
          >
            清空
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <div
          className={'il-list' + (dragOver ? ' over' : '')}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setDragOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void handleFiles(e.dataTransfer.files);
          }}
        >
          {items.length === 0 && <p className="il-empty">拖入图片或点「添加图片」</p>}
          {items.map((it, i) => (
            <div
              key={it.id}
              className={'il-item' + (it.id === activeId ? ' on' : '')}
              onClick={() => {
                setActiveId(it.id);
                const sectionIdx = result.sections.findIndex((s) => {
                  const firstId = items[s.firstImage]?.id;
                  return firstId === it.id;
                });
                if (sectionIdx >= 0) setPageIdx(result.sections[sectionIdx].firstPage);
              }}
            >
              <img src={it.url} alt={it.name} />
              <div className="il-item-body">
                <span className="il-item-name" title={it.name}>
                  {commitName(it.name)}
                </span>
                <span className="il-item-meta">
                  图 {i + 1}
                  {it.section ? ' · 组首' : ''}
                </span>
              </div>
              <div className="il-item-ops" onClick={(e) => e.stopPropagation()}>
                <button title="上移" onClick={() => move(it.id, -1)} disabled={i === 0}>
                  ↑
                </button>
                <button title="下移" onClick={() => move(it.id, 1)} disabled={i === items.length - 1}>
                  ↓
                </button>
                <button title="顺时针旋转 90°" onClick={() => void rotate(it.id)}>
                  ↻
                </button>
                <button
                  title={it.section ? '并回上一组' : '从这张起另起一组'}
                  className={it.section ? 'on' : ''}
                  onClick={() => toggleSection(it.id)}
                >
                  组
                </button>
                <button title="删除" onClick={() => removeItem(it.id)}>
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
        <p className="il-tip">
          共 {items.length} 张{groupCount > 1 ? ` · 分 ${groupCount} 组` : ''} · 点图看它那一组的设置
        </p>
      </aside>

      <section className="il-center">
        <div className="il-stage-head">
          <div className="seg">
            <button className={mode === 'grid' ? 'active' : ''} onClick={() => setMode('grid')}>
              排版预览
            </button>
            <button className={mode === 'stitch' ? 'active' : ''} onClick={() => setMode('stitch')}>
              拼接长图
            </button>
          </div>
          {mode === 'grid' && (
            <div className="il-pagebar">
              <button disabled={pageIdx <= 0} onClick={() => setPageIdx((v) => Math.max(0, v - 1))}>
                ‹
              </button>
              <span>
                {result.pages.length === 0 ? '—' : `${Math.min(pageIdx + 1, result.pages.length)} / ${result.pages.length}`}
              </span>
              <button
                disabled={pageIdx >= result.pages.length - 1}
                onClick={() => setPageIdx((v) => Math.min(result.pages.length - 1, v + 1))}
              >
                ›
              </button>
              <span className="il-paper">{paperLabel}</span>
            </div>
          )}
        </div>

        {mode === 'stitch' && (
          <div className="il-stitchbar">
            <div className="seg sm">
              <button className={stitchDir === 'v' ? 'active' : ''} onClick={() => setStitchDir('v')}>
                纵向拼接
              </button>
              <button className={stitchDir === 'h' ? 'active' : ''} onClick={() => setStitchDir('h')}>
                横向拼接
              </button>
            </div>
            <label className="il-chk">
              间隔
              <input
                type="number"
                min={0}
                max={50}
                className="narrow"
                value={stitchGap}
                onChange={(e) => setStitchGap(Math.max(0, Number(e.target.value) || 0))}
              />
              mm
            </label>
          </div>
        )}

        {mode === 'grid' ? (
          <div className="il-stage">
            {previewPage ? (
              <canvas ref={previewRef} className="il-canvas" />
            ) : (
              <p className="il-empty">导入图片后显示排版预览</p>
            )}
          </div>
        ) : (
          <div className="il-stage">
            {items.length > 0 ? (
              <canvas ref={stitchRef} className="il-canvas stitch" />
            ) : (
              <p className="il-empty">导入图片后显示拼接预览</p>
            )}
          </div>
        )}

        {mode === 'grid' && issues.length > 0 && (
          <div className="il-issues">
            <b>{issues.length} 条打印提醒</b>
            <ul>
              {issues.slice(0, 3).map((it, i) => (
                <li key={i}>{it.message}</li>
              ))}
            </ul>
            {issues.length > 3 && <span>还有 {issues.length - 3} 条…</span>}
          </div>
        )}
        {mode === 'grid' && result.pages.length > 0 && (
          <p className="il-sum">
            第 {Math.min(pageIdx + 1, result.pages.length)} 页 · 本页 {previewPage?.parts.length ?? 0} 个 · 共{' '}
            {result.pages.length} 页 · {(currentSection?.grid ?? result.grid).cols} 列 ×{' '}
            {(currentSection?.grid ?? result.grid).rows} 行
            {result.sections.length > 1 ? ` · 第 ${result.sections.indexOf(currentSection!) + 1} 组` : ''}
          </p>
        )}
      </section>

      <aside className="il-right">
        <h3 className="il-h">排版设置</h3>
        <div className="il-row">
          <label>纸张</label>
          <select
            value={layout.paper}
            onChange={(e) => patch({ paper: e.target.value as SheetPaperId })}
          >
            {Object.entries(SHEET_PAPER_MM).map(([id, p]) => (
              <option key={id} value={id}>
                {p.label}
              </option>
            ))}
          </select>
          <div className="seg sm">
            <button
              className={groupLayout.orientation === 'portrait' ? 'active' : ''}
              onClick={() => patch({ orientation: 'portrait' })}
            >
              竖版
            </button>
            <button
              className={groupLayout.orientation === 'landscape' ? 'active' : ''}
              onClick={() => patch({ orientation: 'landscape' })}
            >
              横版
            </button>
          </div>
        </div>

        <div className="il-row">
          <label>每页</label>
          <select
            value={groupLayout.perPage}
            onChange={(e) => patch({ grid: null, perPage: Number(e.target.value) })}
          >
            {PER_PAGE_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n} 个
              </option>
            ))}
            <option value={9}>9 个</option>
            <option value={1}>1 个</option>
          </select>
          <span className="il-hint">自动选最省纸的排法</span>
        </div>

        <div className="il-row">
          <label>行列</label>
          <select
            value={groupLayout.grid ? `${groupLayout.grid.cols}x${groupLayout.grid.rows}` : 'auto'}
            onChange={(e) => {
              if (e.target.value === 'auto') patch({ grid: null });
              else {
                const [cols, rows] = e.target.value.split('x').map(Number);
                patch({ grid: { cols, rows } });
              }
            }}
          >
            <option value="auto">自动</option>
            {[1, 2, 3, 4].map((c) =>
              [1, 2, 3, 4].map((r) => (
                <option key={`${c}x${r}`} value={`${c}x${r}`}>
                  {c} 列 × {r} 行
                </option>
              )),
            )}
          </select>
        </div>

        <div className="il-row">
          <label>左右间距</label>
          <input
            type="range"
            min={0}
            max={30}
            value={groupLayout.gapXMm}
            onChange={(e) => patch({ gapXMm: Number(e.target.value) })}
          />
          <output>{groupLayout.gapXMm} mm</output>
        </div>
        <div className="il-row">
          <label>上下间距</label>
          <input
            type="range"
            min={0}
            max={30}
            value={groupLayout.gapYMm}
            onChange={(e) => patch({ gapYMm: Number(e.target.value) })}
          />
          <output>{groupLayout.gapYMm} mm</output>
        </div>

        <div className="il-row">
          <label>图片下方文字</label>
          <select
            value={groupLayout.caption}
            onChange={(e) => patch({ caption: e.target.value as SheetLayout['caption'] })}
          >
            <option value="none">不显示</option>
            <option value="order">顺序（图 1）</option>
            <option value="filename">文件名</option>
          </select>
        </div>
        <div className="il-row">
          <label>整体对齐</label>
          <div className="seg sm">
            {(['top', 'center', 'bottom'] as const).map((v) => (
              <button key={v} className={groupLayout.align === v ? 'active' : ''} onClick={() => patch({ align: v })}>
                {v === 'top' ? '居上' : v === 'center' ? '居中' : '居下'}
              </button>
            ))}
          </div>
        </div>

        <div className="il-checks">
          {(
            [
              ['splitLong', '长图自动分段', '在空白处切开，不切断文字'],
              ['pageNumbers', '页码', '页脚印「第 1 页 / 共 N 页」'],
              ['border', '图片描边', '浅色截图印在白纸上也能看清'],
            ] as const
          ).map(([key, label, hint]) => (
            <label key={key} className="il-chk" title={hint}>
              <input type="checkbox" checked={groupLayout[key]} onChange={(e) => patch({ [key]: e.target.checked })} />
              {label}
            </label>
          ))}
        </div>

        <h3 className="il-h">排满一页（贴纸 / 标签）</h3>
        <label className="il-chk">
          <input
            type="checkbox"
            checked={groupLayout.fillEnabled}
            onChange={(e) => patch({ fillEnabled: e.target.checked })}
          />
          同一张图重复铺满
        </label>
        {groupLayout.fillEnabled && (
          <>
            <div className="il-row">
              <label>数量</label>
              <select
                value={activeId && items.find((i) => i.id === activeId)?.copies === null ? 'fill' : 'fixed'}
                onChange={(e) => {
                  const id = activeId;
                  if (!id) return;
                  const fill = e.target.value === 'fill';
                  setItems((prev) =>
                    prev.map((it) =>
                      it.id === id ? { ...it, copies: fill ? null : groupLayout.fill.count ?? 4 } : it,
                    ),
                  );
                }}
              >
                <option value="fill">排满一页</option>
                <option value="fixed">指定份数</option>
              </select>
              <input
                type="number"
                min={1}
                max={999}
                className="narrow"
                value={items.find((i) => i.id === activeId)?.copies ?? 4}
                disabled={(items.find((i) => i.id === activeId)?.copies ?? null) === null}
                onChange={(e) => {
                  const id = activeId;
                  const v = Math.max(1, Math.min(999, Number(e.target.value) || 1));
                  if (!id) return;
                  setItems((prev) => prev.map((it) => (it.id === id ? { ...it, copies: v } : it)));
                }}
              />
            </div>
            <div className="il-row">
              <label>尺寸来源</label>
              <div className="seg sm">
                <button
                  className={groupLayout.fill.widthMm === null ? 'active' : ''}
                  onClick={() => patchFill({ widthMm: null })}
                >
                  按数量
                </button>
                <button
                  className={groupLayout.fill.widthMm !== null ? 'active' : ''}
                  onClick={() => patchFill({ widthMm: groupLayout.fill.widthMm ?? 30 })}
                >
                  按宽度
                </button>
              </div>
            </div>
            {groupLayout.fill.widthMm !== null && (
              <div className="il-row">
                <label>每个宽度</label>
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={1}
                  value={groupLayout.fill.widthMm}
                  onChange={(e) => patchFill({ widthMm: Number(e.target.value) })}
                />
                <output>{groupLayout.fill.widthMm} mm</output>
              </div>
            )}
            <div className="il-checks">
              <label className="il-chk">
                <input
                  type="checkbox"
                  checked={groupLayout.fill.cutLines}
                  onChange={(e) => patchFill({ cutLines: e.target.checked })}
                />
                裁切线
              </label>
              <label className="il-chk">
                <input
                  type="checkbox"
                  checked={groupLayout.fill.mirror}
                  onChange={(e) => patchFill({ mirror: e.target.checked })}
                />
                水平镜像
              </label>
              <label className="il-chk">
                <input
                  type="checkbox"
                  checked={groupLayout.fill.sizeLabel}
                  onChange={(e) => patchFill({ sizeLabel: e.target.checked })}
                />
                标注尺寸
              </label>
            </div>
          </>
        )}
      </aside>

      <footer className="il-actions">
        <button className="btn sm" onClick={() => setLayout(DEFAULT_SHEET_LAYOUT)}>
          恢复默认
        </button>
        <span className="il-msg">{msg}</span>
        <div className="il-actions-r">
          {mode === 'grid' ? (
            <>
              <button className="btn" disabled={result.pages.length === 0} onClick={doPrint}>
                打印
              </button>
              <button className="btn primary" disabled={result.pages.length === 0} onClick={exportPdf}>
                保存 PDF
              </button>
            </>
          ) : (
            <button className="btn primary" disabled={items.length === 0} onClick={exportStitch}>
              导出长图 PNG
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

/** 文件名去掉扩展名，列表里省地方 */
function commitName(name: string): string {
  return name.replace(/\.[^.]+$/, '') || name;
}
