import { useMemo, useRef, useState } from 'react';
import { jsPDF } from 'jspdf';
import { analyzeFile, type ColorMode, type FileAnalysis } from '../lib/pdfAnalyze';
import { quote, sheetCount, formatCents, type FileRow, type PageMode, type Quote } from '../lib/quote';
import { useSettings, priceRowOf, presetFromPriceRow, detectFromName, reclassify } from '../lib/appSettings';
import { RED_STAMP_THRESHOLD } from '../lib/pdfAnalyze';
import { useHotkeyActions } from '../lib/hotkeys';

/* ===== 打印记录（localStorage） ===== */
interface PrintRecord {
  t: number;
  files: number;
  faces: number;
  totalCents: number;
}
const REC_KEY = 'chaoyu.print.records.v1';
function loadRecords(): PrintRecord[] {
  try {
    return JSON.parse(localStorage.getItem(REC_KEY) ?? '[]') as PrintRecord[];
  } catch {
    return [];
  }
}
function saveRecords(r: PrintRecord[]) {
  localStorage.setItem(REC_KEY, JSON.stringify(r));
}

const MODE_LABEL: Record<PageMode, string> = {
  bw: '黑白',
  dot: '点彩',
  color: '彩色',
  none: '不打印',
};

/** 页级模式循环：自动→黑白→点彩→彩色→不打印→自动 */
function cycleMode(cur: PageMode, manual: boolean | undefined): PageMode {
  if (!manual) return 'bw';
  return cur === 'bw' ? 'dot' : cur === 'dot' ? 'color' : cur === 'color' ? 'none' : 'bw';
}

function exportQuotePdf(q: Quote) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  doc.setFontSize(16);
  doc.text('打印报价单', 14, 16);
  doc.setFontSize(10);
  doc.text(`日期：${new Date().toLocaleString()}`, 14, 24);
  let y = 36;
  doc.setFontSize(9);
  doc.text('文件', 14, y);
  doc.text('纸张', 90, y);
  doc.text('面数', 110, y);
  doc.text('黑白', 128, y);
  doc.text('点彩', 146, y);
  doc.text('彩色', 164, y);
  doc.text('小计', 184, y);
  y += 4;
  doc.line(14, y, 196, y);
  y += 6;
  q.lines.forEach((l) => {
    doc.text(l.name.slice(0, 40), 14, y);
    doc.text(l.paper, 90, y);
    doc.text(String(l.faces * l.copies), 110, y);
    doc.text(String(l.bwPages * l.copies), 128, y);
    doc.text(String(l.dotPages * l.copies), 146, y);
    doc.text(String(l.colorPages * l.copies), 164, y);
    doc.text(formatCents(l.lineCents), 184, y);
    y += 6;
    if (y > 280) {
      doc.addPage();
      y = 20;
    }
  });
  y += 4;
  doc.line(14, y, 196, y);
  y += 8;
  doc.setFontSize(13);
  doc.text(`合计：${formatCents(q.totalCents)}（${q.totalPages} 面）`, 14, y);
  doc.save('打印报价单.pdf');
}

function toRow(a: FileAnalysis, autoColor: boolean, dotThreshold: number, bpAutoDetect: boolean, papers: string[]): FileRow {
  const det = bpAutoDetect ? detectFromName(a.name) : {};
  const perPage = a.perPage.map((p) => {
    let mode: PageMode = autoColor ? reclassify(p.colorRatio, dotThreshold) : 'bw';
    if (det.forceMode) mode = det.forceMode;
    return { ...p, mode };
  });
  // 识别出的尺寸在价格表里就直接采用（A3/A4/A5…）
  const detected = a.detectedSize && papers.includes(a.detectedSize) ? a.detectedSize : undefined;
  return {
    name: a.name,
    pages: a.pages,
    paper: detected ?? 'A4',
    size: a.detectedSize || undefined,
    perPage,
    thumbs: a.thumbs,
    copies: det.copies ?? 1,
    duplex: det.duplex ?? false,
    modeOverride: undefined,
  };
}

export default function BatchPrint({ onOpenPrice }: { onOpenPrice?: () => void }) {
  const [rows, setRows] = useState<FileRow[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [autoColor, setAutoColor] = useState(true);
  const [showPreview, setShowPreview] = useState(true);
  const [viewMode, setViewMode] = useState<'list' | 'pages'>('list');
  const [s, update] = useSettings();
  const [dragOver, setDragOver] = useState(false);
  const [setCount, setSetCount] = useState(1); // 整套
  const [records, setRecords] = useState<PrintRecord[]>(() => loadRecords());
  const [showRecords, setShowRecords] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  function showToast(msg: string) {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }
  // handleFiles 里 setToast 改为 showToast
  const [sel, setSel] = useState<{ f: number; p: number }>({ f: 0, p: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const presetFor = (r: FileRow) => presetFromPriceRow(priceRowOf(s, r.paper));

  // 整套 N 套 = 每个文件份数 × N
  const effectiveRows = useMemo(
    () => rows.map((r) => ({ ...r, copies: r.copies * Math.max(1, setCount) })),
    [rows, setCount],
  );
  const q = useMemo(() => quote(effectiveRows, presetFor), [effectiveRows, s]);
  const sheets = useMemo(() => sheetCount(effectiveRows), [effectiveRows]);

  // 快捷键接入：导入/打印/导出（能力自动登记供设置页展示）
  useHotkeyActions('batch-print', '批量打印', {
    import: () => inputRef.current?.click(),
    print: doPrint,
    export: () => {
      if (q) exportQuotePdf(q);
    },
  });

  const autoSplit = useMemo(() => {
    let bw = 0;
    let dot = 0;
    let color = 0;
    rows.forEach((r) =>
      r.perPage.forEach((p) => {
        if (p.mode === 'bw') bw++;
        else if (p.mode === 'dot') dot++;
        else if (p.mode === 'color') color++;
      }),
    );
    return { bw, dot, color };
  }, [rows]);

  const totalFaces = rows.reduce(
    (n, r) => n + r.perPage.filter((p) => p.mode !== 'none').length * r.copies * Math.max(1, setCount),
    0,
  );

  async function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    // 兜底：某些来源（如部分 Windows 拖入场景）file.type 为空，按扩展名再认一次
    const ok = Array.from(list).filter(
      (f) =>
        f.type === 'application/pdf' ||
        f.type.startsWith('image/') ||
        /\.(pdf|png|jpe?g|webp|bmp|gif)$/i.test(f.name),
    );
    if (!ok.length) {
      showToast('未识别到可导入的文件（支持 PDF / 图片）');
      return;
    }
    setAnalyzing(true);
    const papers = s.prices.map((pr) => pr.paper);
    const results: FileRow[] = [];
    for (const f of ok) {
      try {
        // 超时保护：异常 PDF 卡住时也能落一行，不会让列表一直空着
        const a = await Promise.race([
          analyzeFile(f),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('分析超时')), 30000)),
        ]);
        results.push(toRow(a, autoColor, s.dotThreshold, s.bpAutoDetect, papers));
      } catch {
        results.push({
          name: f.name,
          pages: 0,
          paper: 'A4',
          perPage: [],
          thumbs: [],
          copies: 1,
          duplex: false,
        });
      }
    }
    setRows((prev) => [...prev, ...results]);
    setAnalyzing(false);
    const bad = results.filter((r) => r.pages === 0).length;
    if (bad > 0) showToast(`${bad} 个文件读取失败，已按空条目计入`);
  }

  function updateRow(i: number, patch: Partial<FileRow>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  /** 改某一页的模式；同时清掉整篇覆盖，让页级设置生效 */
  function setPageMode(fi: number, pi: number, mode: PageMode) {
    setRows((prev) =>
      prev.map((r, idx) => {
        if (idx !== fi) return r;
        const perPage = r.perPage.map((p, j) => (j === pi ? { ...p, mode, manual: mode !== 'none' } : p));
        return { ...r, perPage, modeOverride: undefined };
      }),
    );
  }

  function setRowModeOverride(i: number, v: ColorMode | 'auto') {
    setRows((prev) =>
      prev.map((r, idx) => {
        if (idx !== i) return r;
        if (v === 'auto') {
          return {
            ...r,
            modeOverride: undefined,
            perPage: r.perPage.map((p) => ({ ...p, mode: reclassify(p.colorRatio, s.dotThreshold), manual: false })),
          };
        }
        return { ...r, modeOverride: v, perPage: r.perPage.map((p) => ({ ...p, manual: false })) };
      }),
    );
  }

  function restoreAuto() {
    setRows((prev) =>
      prev.map((r) => ({
        ...r,
        modeOverride: undefined,
        perPage: autoColor
          ? r.perPage.map((p) => ({ ...p, mode: reclassify(p.colorRatio, s.dotThreshold), manual: false }))
          : r.perPage.map((p) => ({ ...p, mode: 'bw' as PageMode, manual: false })),
      })),
    );
  }

  function toggleAutoColor(on: boolean) {
    setAutoColor(on);
    setRows((prev) =>
      prev.map((r) => ({
        ...r,
        modeOverride: undefined,
        perPage: r.perPage.map((p) =>
          p.manual ? p : { ...p, mode: on ? reclassify(p.colorRatio, s.dotThreshold) : ('bw' as PageMode) },
        ),
      })),
    );
  }

  function sortRows() {
    setRows((prev) => [...prev].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')));
  }

  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
    setSel({ f: 0, p: 0 });
  }

  function pushRecord() {
    if (!q || rows.length === 0) return;
    const next = [
      { t: Date.now(), files: rows.length, faces: q.totalPages, totalCents: q.totalCents },
      ...records,
    ].slice(0, 50);
    setRecords(next);
    saveRecords(next);
  }

  function doPrint() {
    pushRecord();
    const api = (window as unknown as { electronAPI?: { print?: (o: unknown) => void } }).electronAPI;
    if (api?.print) api.print({ copies: setCount });
    else window.print();
  }

  const selRow = rows[sel.f];
  const selPage = selRow?.perPage[sel.p];
  const paperSummary = Object.entries(sheets)
    .map(([p, n]) => `${p} ${n}张`)
    .join(' / ');

  return (
    <div
      className="bp"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        void handleFiles(e.dataTransfer.files);
      }}
    >
      <div className="bp-main">
        {/* 顶部工具栏 */}
        <div className="bp-toolbar">
          <button className="btn primary" onClick={() => inputRef.current?.click()}>
            文件
          </button>
          <button className="btn" onClick={() => folderRef.current?.click()}>
            文件夹
          </button>
          <label className="bp-toggle">
            自动识别份数
            <input
              type="checkbox"
              checked={s.bpAutoDetect}
              onChange={(e) => update({ bpAutoDetect: e.target.checked })}
            />
          </label>
          <label className="bp-toggle">
            自动识别颜色
            <input type="checkbox" checked={autoColor} onChange={(e) => toggleAutoColor(e.target.checked)} />
          </label>
          <button className="btn" onClick={sortRows} disabled={rows.length < 2}>
            排序
          </button>
          <button className="link" onClick={() => setRows([])} disabled={rows.length === 0}>
            清空
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pdf,image/*"
            hidden
            onChange={(e) => handleFiles(e.target.files)}
          />
          <input
            ref={folderRef}
            type="file"
            multiple
            hidden
            // @ts-expect-error 非标准属性
            webkitdirectory=""
            directory=""
            onChange={(e) => handleFiles(e.target.files)}
          />
          <span className="bp-toolbar-spacer" />
          <div className="bp-seg">
            <button className={viewMode === 'list' ? 'on' : ''} onClick={() => setViewMode('list')}>
              列表
            </button>
            <button className={viewMode === 'pages' ? 'on' : ''} onClick={() => setViewMode('pages')}>
              页面
            </button>
          </div>
          <button className="link" onClick={onOpenPrice}>
            价格表
          </button>
          <button className={'btn' + (showPreview ? ' active' : '')} onClick={() => setShowPreview((v) => !v)}>
            预览
          </button>
        </div>

        {/* 列表视图 */}
        {viewMode === 'list' ? (
          <section className="bp-table">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 48 }}>序号</th>
                  <th>文件</th>
                  <th style={{ width: 64 }}>页数</th>
                  <th style={{ width: 76 }}>纸张</th>
                  <th style={{ width: 84 }}>版面</th>
                  <th style={{ width: 88 }}>颜色</th>
                  <th style={{ width: 64 }}>份数</th>
                  <th style={{ width: 90 }}>小计</th>
                  <th style={{ width: 56 }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const line = q?.lines[i];
                  const redPages = r.perPage.filter((p) => p.redRatio! > RED_STAMP_THRESHOLD).length;
                  const colorPages = r.perPage.filter((p) => p.mode === 'color').length;
                  return (
                    <tr key={i} className={sel.f === i ? 'sel' : ''} onClick={() => setSel({ f: i, p: 0 })}>
                      <td className="muted">{i + 1}</td>
                      <td className="fname" title={r.name}>
                        <span className="bp-ficon">📄</span>
                        {r.name}
                        {r.size && <span className="badge size" title="自动识别的纸张尺寸">{r.size}</span>}
                        {redPages > 0 && <span className="badge red">红章 {redPages}页</span>}
                        {colorPages > 0 && <span className="badge pink">彩色 {colorPages}页</span>}
                      </td>
                      <td>{r.pages || '—'}</td>
                      <td>
                        <select
                          value={r.paper}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => updateRow(i, { paper: e.target.value })}
                        >
                          {s.prices.map((pr) => (
                            <option key={pr.paper} value={pr.paper}>
                              {pr.paper}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="bp-duplex" role="group" aria-label="单面或双面">
                          <button
                            type="button"
                            className={!r.duplex ? 'on' : ''}
                            title="单面打印"
                            onClick={() => updateRow(i, { duplex: false })}
                          >
                            单面
                          </button>
                          <button
                            type="button"
                            className={r.duplex ? 'on' : ''}
                            title="双面打印（按双面价计费）"
                            onClick={() => updateRow(i, { duplex: true })}
                          >
                            双面
                          </button>
                        </div>
                      </td>
                      <td>
                        <select
                          value={r.modeOverride ?? 'auto'}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setRowModeOverride(i, e.target.value as ColorMode | 'auto')}
                        >
                          <option value="auto">自动</option>
                          <option value="bw">黑白</option>
                          <option value="dot">点彩</option>
                          <option value="color">彩色</option>
                        </select>
                      </td>
                      <td>
                        <input
                          type="number"
                          min={1}
                          value={r.copies}
                          className="copies"
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => updateRow(i, { copies: Math.max(1, Number(e.target.value) || 1) })}
                        />
                      </td>
                      <td>{line ? formatCents(line.lineCents) : '—'}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <button className="btn danger" onClick={() => removeRow(i)}>
                          移除
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9}>
                      <div className="bp-dropzone">
                        <div className="bp-dropbox">
                          <p className="bp-drop-t">拖入文件或文件夹</p>
                          <p className="muted">
                            支持 PDF、图片批量处理；自动识别 A4 / A3 / A5 等纸张尺寸；文件名带「(5份)」「彩色」「双面」可自动识别
                            {s.bpAutoDetect ? '（已开启）' : '（设置中已关闭）'}。
                          </p>
                          <div className="bp-drop-btns">
                            <button className="btn primary" onClick={() => inputRef.current?.click()}>
                              选择文件
                            </button>
                            <button className="btn" onClick={() => folderRef.current?.click()}>
                              选择文件夹
                            </button>
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {dragOver && <div className="bp-dragmask">松开以导入</div>}
          </section>
        ) : (
          /* 页面视图 */
          <section className="bp-pages">
            <div className="bp-pages-bar">
              <span>
                共 {rows.reduce((n, r) => n + r.pages, 0)} 页 · 打印 {totalFaces} 面
                {autoColor && (
                  <>
                    {' '}
                    · 已自动拆分 {autoSplit.bw} 页黑白 / {autoSplit.dot} 页点彩 / {autoSplit.color} 页彩色
                  </>
                )}
              </span>
              <button className="link" onClick={restoreAuto}>
                恢复自动判定
              </button>
            </div>
            <p className="muted bp-pages-tip">
              点页码看打印效果；点页上的颜色标记可把它设成黑白 / 点彩 / 彩色 / 不打印。
            </p>
            {rows.map((r, fi) => (
              <div key={fi} className="bp-fileblock">
                <div className="bp-fileblock-h">
                  <b>{r.name}</b>
                  {r.size && <span className="badge size">{r.size}</span>}
                  <span className="muted">{r.pages} 页</span>
                  <span className="bp-toolbar-spacer" />
                  <div
                    className="bp-duplex mini"
                    role="group"
                    aria-label="单面或双面"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      className={!r.duplex ? 'on' : ''}
                      title="单面打印"
                      onClick={() => updateRow(fi, { duplex: false })}
                    >
                      单面
                    </button>
                    <button
                      type="button"
                      className={r.duplex ? 'on' : ''}
                      title="双面打印（按双面价计费）"
                      onClick={() => updateRow(fi, { duplex: true })}
                    >
                      双面
                    </button>
                  </div>
                </div>
                <div className="pg-grid">
                  {r.perPage.map((p, pi) => {
                    const pct = Math.round(p.colorRatio * 1000) / 10;
                    return (
                      <div
                        key={pi}
                        className={`pg-card m-${p.mode}${sel.f === fi && sel.p === pi ? ' sel' : ''}`}
                        onClick={() => setSel({ f: fi, p: pi })}
                      >
                        <span className="pg-num">{p.page}</span>
                        {p.mode === 'none' && <span className="pg-exclude">排除</span>}
                        {r.thumbs?.[pi] ? (
                          <img src={r.thumbs[pi]} loading="lazy" alt={`第${p.page}页`} />
                        ) : (
                          <div className="pg-blank" />
                        )}
                        <button
                          className={`pg-chip chip-${p.mode}`}
                          title="点击切换：黑白 → 点彩 → 彩色 → 不打印"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPageMode(fi, pi, cycleMode(p.mode, p.manual));
                          }}
                        >
                          {p.size || r.paper} {MODE_LABEL[p.mode]}
                          {p.mode !== 'none' && ` ${pct}%`}
                        </button>
                      </div>
                    );
                  })}
                  {r.perPage.length === 0 && <p className="muted">没有可显示的页（非 PDF/图片文件）</p>}
                </div>
              </div>
            ))}
            {rows.length === 0 && (
              <div className="bp-dropzone">
                <div className="bp-dropbox">
                  <p className="bp-drop-t">拖入文件或文件夹</p>
                  <p className="muted">导入后这里按页显示，逐页确认黑白 / 点彩 / 彩色。</p>
                </div>
              </div>
            )}
            {dragOver && <div className="bp-dragmask">松开以导入</div>}
          </section>
        )}
      </div>

      {/* 右侧打印预览 */}
      {showPreview && (
        <aside className="bp-preview">
          {selRow && selPage ? (
            <>
              <div className="bp-pv-head">
                <span className="bp-pv-tag">注：</span>
                <span className="bp-pv-name" title={selRow.name}>
                  {selRow.name}
                </span>
                <button className="link" onClick={() => removeRow(sel.f)}>
                  ✕
                </button>
              </div>
              <div className="bp-pv-img">
                {selRow.thumbs?.[sel.p] ? (
                  <img src={selRow.thumbs[sel.p]} alt={`第${selPage.page}页`} />
                ) : (
                  <div className="bp-paper-card empty" />
                )}
              </div>
              <div className="bp-pv-nav">
                <button
                  className="btn"
                  disabled={sel.p <= 0}
                  onClick={() => setSel((v) => ({ ...v, p: Math.max(0, v.p - 1) }))}
                >
                  ‹
                </button>
                <span>
                  第 {selPage.page} / {selRow.pages} 页
                </span>
                <button
                  className="btn"
                  disabled={sel.p >= selRow.perPage.length - 1}
                  onClick={() => setSel((v) => ({ ...v, p: Math.min(selRow.perPage.length - 1, v.p + 1) }))}
                >
                  ›
                </button>
              </div>
              <p className="muted bp-pv-info">
                {selPage.size || selRow.paper} 原尺寸·{MODE_LABEL[selPage.mode]}（彩色占{' '}
                {Math.round(selPage.colorRatio * 1000) / 10}%）
                {(selPage.redRatio ?? 0) > 0.004 && ' · 检测到红章'}
                {selRow.duplex ? ' · 双面' : ' · 单面'}
              </p>
              <div className="bp-pv-actions">
                <button
                  className={'btn' + (selPage.mode === 'none' ? ' active' : '')}
                  onClick={() =>
                    setPageMode(sel.f, sel.p, selPage.mode === 'none' ? reclassify(selPage.colorRatio, s.dotThreshold) : 'none')
                  }
                >
                  不打印
                </button>
                <button
                  className={'btn' + (selPage.mode === 'color' ? ' active' : '')}
                  onClick={() => setPageMode(sel.f, sel.p, 'color')}
                >
                  改为彩色
                </button>
              </div>
            </>
          ) : (
            <div className="bp-preview-empty">
              <div className="bp-paper-card empty" />
              <p className="muted">拖动调整文件，这里显示选中页与打印效果</p>
            </div>
          )}
        </aside>
      )}

      {/* 底部操作栏 */}
      <footer className="bp-bottom">
        <span className="muted">
          {rows.length === 0
            ? '还没有文件：导入后自动按价格表拆分黑白 / 点彩 / 彩色。'
            : `${rows.length} 个文件 · 打印 ${totalFaces} 面${paperSummary ? ` / 用纸 ${paperSummary}` : ''}`}
        </span>
        <button className="btn" onClick={() => setShowRecords(true)}>
          记录
        </button>
        <span className="bp-toolbar-spacer" />
        <label className="bp-toggle">
          整套
          <input
            type="number"
            min={1}
            value={setCount}
            className="copies"
            onChange={(e) => setSetCount(Math.max(1, Number(e.target.value) || 1))}
          />
          套
        </label>
        <span className="bp-money">预计 {q ? formatCents(q.totalCents) : '¥0.00'}</span>
        <button
          className="btn"
          disabled={!q || rows.length === 0}
          onClick={() => {
            pushRecord();
            exportQuotePdf(q!);
          }}
        >
          保存 PDF
        </button>
        <button className="btn primary" disabled={rows.length === 0} onClick={doPrint}>
          打印
        </button>
      </footer>

      {/* 记录弹层 */}
      {showRecords && (
        <div className="bp-modal" onClick={() => setShowRecords(false)}>
          <div className="bp-modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>打印记录</h3>
            {records.length === 0 ? (
              <p className="muted">还没有记录；保存 PDF 或打印后会记在这里。</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>文件</th>
                    <th>面数</th>
                    <th>金额</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <tr key={r.t}>
                      <td>{new Date(r.t).toLocaleString()}</td>
                      <td>{r.files}</td>
                      <td>{r.faces}</td>
                      <td>{formatCents(r.totalCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="bp-modal-foot">
              <button
                className="link danger"
                onClick={() => {
                  setRecords([]);
                  saveRecords([]);
                }}
              >
                清空记录
              </button>
              <button className="btn" onClick={() => setShowRecords(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {analyzing && <div className="bp-analyzing">分析中…</div>}
      {toast && <div className="bp-toast">{toast}</div>}
    </div>
  );
}
