import { useRef, useState } from 'react';
import {
  mergePdfs,
  splitPdf,
  rotatePdf,
  unifyPageSize,
  pdfToImages,
  PAPER_SIZES_PT,
  type FitMode,
} from '../lib/pdfOps';
import { sendToBatchPrint } from '../lib/handoff';
import { useHotkeyActions } from '../lib/hotkeys';
import {
  saveBytes,
  saveBlob,
  saveBatch,
  outcomeMessage,
  batchMessage,
  revealIfWanted,
  type SaveOutcome,
} from '../lib/exporter';
import JSZip from 'jszip';

type Tab = 'merge' | 'split' | 'rotate' | 'unify' | 'images';

const TABS: { id: Tab; name: string; desc: string }[] = [
  { id: 'merge', name: '合并', desc: '多个 PDF 按顺序合成一个' },
  { id: 'split', name: '拆分', desc: '按页码范围拆成多个文件' },
  { id: 'rotate', name: '旋转', desc: '整篇或指定页旋转 90/180/270' },
  { id: 'unify', name: '统一大小', desc: '把页面缩放统一到同一纸张' },
  { id: 'images', name: '转图片', desc: '每页导出为 JPG / PNG' },
];

async function readPdf(f: File): Promise<Uint8Array> {
  return new Uint8Array(await f.arrayBuffer());
}

// 导出统一走 exporter：桌面端 tmp + rename 原子写盘，浏览器环境回退下载。
// 保持为纯函数不带 UI 副作用，成功/失败提示由组件内的 doSave 统一处理。
async function download(data: Uint8Array | Blob, name: string): Promise<SaveOutcome> {
  return data instanceof Blob
    ? saveBlob(data, name)
    : saveBytes(data, name, { filters: [{ name: 'PDF 文档', extensions: ['pdf'] }] });
}

function fmtSize(n: number): string {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export default function PdfPrep() {
  const [tab, setTab] = useState<Tab>('merge');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  // 各模块文件输入框（快捷键 Ctrl+O 点当前模块的）
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  useHotkeyActions('pdf-prep', 'PDF 预处理', {
    import: () => inputs.current[tab]?.click(),
  });

  // 合并
  const [mergeFiles, setMergeFiles] = useState<File[]>([]);
  const [merged, setMerged] = useState<Uint8Array | null>(null);

  // 拆分 / 旋转 / 统一 / 转图片 共用一个单文件状态
  const [one, setOne] = useState<{ name: string; data: Uint8Array } | null>(null);
  const [range, setRange] = useState('');
  const [angle, setAngle] = useState<90 | 180 | 270>(90);
  const [size, setSize] = useState('A4');
  const [mode, setMode] = useState<FitMode>('contain');
  const [scale, setScale] = useState(2);
  const [imgFmt, setImgFmt] = useState<'image/jpeg' | 'image/png'>('image/jpeg');
  const [splitOut, setSplitOut] = useState<{ name: string; data: Uint8Array }[]>([]);
  const [singleOut, setSingleOut] = useState<Uint8Array | null>(null);

  function fail(e: unknown) {
    setMsg(`失败：${(e as Error)?.message || String(e)}`);
  }

  async function pickOne(f: File | undefined) {
    if (!f) return;
    if (!/\.pdf$/i.test(f.name)) {
      setMsg('只支持 PDF 文件');
      return;
    }
    try {
      setOne({ name: f.name, data: await readPdf(f) });
      setSplitOut([]);
      setSingleOut(null);
      setMsg('');
    } catch (e) {
      fail(e);
    }
  }

  function pickMerge(list: FileList | null) {
    if (!list) return;
    const pdfs = Array.from(list).filter((f) => /\.pdf$/i.test(f.name));
    setMergeFiles((prev) => [...prev, ...pdfs]);
    setMerged(null);
    setMsg(pdfs.length ? '' : '只支持 PDF 文件');
  }

  async function runMerge() {
    if (mergeFiles.length < 2) {
      setMsg('合并至少需要 2 个 PDF');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const inputs = [];
      for (const f of mergeFiles) inputs.push({ name: f.name, data: await readPdf(f) });
      const out = await mergePdfs(inputs);
      setMerged(out);
      setMsg(`合并完成：${mergeFiles.length} 个文件 → 1 个（${fmtSize(out.byteLength)}）`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function runSplit() {
    if (!one) return;
    setBusy(true);
    setMsg('');
    try {
      const out = await splitPdf(one.data, range, one.name);
      setSplitOut(out);
      setMsg(`拆出 ${out.length} 个文件`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function runRotate() {
    if (!one) return;
    setBusy(true);
    setMsg('');
    try {
      const out = await rotatePdf(one.data, angle, range);
      setSingleOut(out);
      setMsg(`旋转完成（${fmtSize(out.byteLength)}）`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function runUnify() {
    if (!one) return;
    const p = PAPER_SIZES_PT.find((x) => x.name === size);
    if (!p) return;
    setBusy(true);
    setMsg('');
    try {
      const out = await unifyPageSize(one.data, { w: p.w, h: p.h }, mode, range);
      setSingleOut(out);
      setMsg(`已统一为 ${size} 竖版（${fmtSize(out.byteLength)}）`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function runImages() {
    if (!one) return;
    setBusy(true);
    setMsg('');
    try {
      const imgs = await pdfToImages(one.data, { scale, format: imgFmt });
      const zip = new JSZip();
      for (const im of imgs) zip.file(im.name, im.blob);
      const blob = await zip.generateAsync({ type: 'blob' });
      const base = one.name.replace(/\.pdf$/i, '');
      const r = await download(blob, `${base}_图片.zip`);
      setMsg(`转换完成：${imgs.length} 张，${outcomeMessage(r)}`);
      void revealIfWanted(r.path);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function saveAllSplit() {
    const res = await saveBatch(splitOut.map((o) => ({ name: o.name, data: o.data })));
    if (res.cancelled) {
      setMsg('已取消保存');
      return;
    }
    setMsg(batchMessage(res));
    void revealIfWanted(res.dir ?? undefined);
  }

  // 单文件导出后给出结果反馈：桌面端报真实路径，失败报真实原因，取消不打扰
  async function doSave(data: Uint8Array | Blob, name: string) {
    const r = await download(data, name);
    if (r.ok) {
      setMsg(outcomeMessage(r));
      void revealIfWanted(r.path);
    } else if (r.code !== 'cancelled') {
      setMsg(r.error || '保存失败');
    }
  }

  const fileRow = (f: { name: string; size: number }, i: number, onDel?: (i: number) => void) => (
    <div className="pp-file" key={i}>
      <span className="pp-file-name" title={f.name}>
        {f.name}
      </span>
      <span className="muted">{fmtSize(f.size)}</span>
      {onDel && (
        <button className="pp-del" onClick={() => onDel(i)} title="移除">
          ×
        </button>
      )}
    </div>
  );

  return (
    <div className="pp">
      {/* ===== 工具级顶栏（只保留工具标识；原爱印的试用/剩余天数/开通按钮不复刻） ===== */}
      <div className="icw-topbar">
        <div className="icw-brand">
          <span className="icw-logo">🛠</span>
          <span className="icw-brand-name">PDF 预处理</span>
        </div>
      </div>

      <div className="pp-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={'pp-tab' + (tab === t.id ? ' on' : '')}
            onClick={() => {
              setTab(t.id);
              setMsg('');
            }}
          >
            <b>{t.name}</b>
            <small>{t.desc}</small>
          </button>
        ))}
      </div>

      <div className="pp-body">
        {tab === 'merge' && (
          <>
            <div className="pp-row">
              <button className="btn primary" onClick={() => inputs.current.merge?.click()}>
                添加 PDF
              </button>
              <input
                ref={(el) => {
                  inputs.current.merge = el;
                }}
                type="file"
                accept=".pdf,application/pdf"
                multiple
                hidden
                onChange={(e) => {
                  pickMerge(e.target.files);
                  e.target.value = '';
                }}
              />
              <span className="muted">按添加顺序合并，至少 2 个</span>
            </div>
            <div className="pp-files">
              {mergeFiles.map((f, i) =>
                fileRow(f, i, (idx) => {
                  setMergeFiles((prev) => prev.filter((_, j) => j !== idx));
                  setMerged(null);
                }),
              )}
              {!mergeFiles.length && <div className="pp-empty">还没添加文件</div>}
            </div>
            <div className="pp-actions">
              <button className="btn primary" disabled={busy || mergeFiles.length < 2} onClick={runMerge}>
                合并为 1 个 PDF
              </button>
              {merged && (
                <>
                  <button className="btn" onClick={() => void doSave(merged, '合并文档.pdf')}>
                    下载
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      sendToBatchPrint([{ name: '合并文档.pdf', data: merged }]);
                      setMsg('已发送到批量打印');
                    }}
                  >
                    发送到批量打印
                  </button>
                </>
              )}
            </div>
          </>
        )}

        {(tab === 'split' || tab === 'rotate' || tab === 'unify' || tab === 'images') && (
          <>
            <div className="pp-row">
              <button className="btn primary" onClick={() => inputs.current[tab]?.click()}>
                选择 PDF
              </button>
              <input
                ref={(el) => {
                  inputs.current[tab] = el;
                }}
                type="file"
                accept=".pdf,application/pdf"
                hidden
                onChange={(e) => {
                  void pickOne(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              {one && <span className="pp-file-name">{one.name}</span>}
              {!one && <span className="muted">先选一个 PDF</span>}
            </div>

            {tab !== 'images' && (
              <div className="pp-row">
                <label className="pp-label">页码范围</label>
                <input
                  className="pp-range"
                  placeholder="空 = 全部页，例：1-3,5,8-10"
                  value={range}
                  onChange={(e) => setRange(e.target.value)}
                />
              </div>
            )}

            {tab === 'split' && (
              <div className="pp-actions">
                <button className="btn primary" disabled={busy || !one} onClick={runSplit}>
                  拆分
                </button>
                {splitOut.length > 0 && (
                  <button className="btn" onClick={() => void saveAllSplit()}>
                    全部下载（{splitOut.length}）
                  </button>
                )}
              </div>
            )}

            {tab === 'rotate' && (
              <>
                <div className="pp-row">
                  <label className="pp-label">角度</label>
                  <div className="pp-seg">
                    {([90, 180, 270] as const).map((a) => (
                      <button
                        key={a}
                        className={'pp-seg-b' + (angle === a ? ' on' : '')}
                        onClick={() => setAngle(a)}
                      >
                        {a}°
                      </button>
                    ))}
                  </div>
                  <span className="muted">顺时针累加，重复旋转会叠加</span>
                </div>
                <div className="pp-actions">
                  <button className="btn primary" disabled={busy || !one} onClick={runRotate}>
                    旋转
                  </button>
                  {singleOut && (
                    <>
                      <button className="btn" onClick={() => void doSave(singleOut, `${one!.name.replace(/\.pdf$/i, '')}_旋转.pdf`)}>
                        下载
                      </button>
                      <button
                        className="btn"
                        onClick={() => {
                          sendToBatchPrint([{ name: `${one!.name.replace(/\.pdf$/i, '')}_旋转.pdf`, data: singleOut }]);
                          setMsg('已发送到批量打印');
                        }}
                      >
                        发送到批量打印
                      </button>
                    </>
                  )}
                </div>
              </>
            )}

            {tab === 'unify' && (
              <>
                <div className="pp-row">
                  <label className="pp-label">目标纸张</label>
                  <select className="pp-select" value={size} onChange={(e) => setSize(e.target.value)}>
                    {PAPER_SIZES_PT.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}（{Math.round(p.w)}×{Math.round(p.h)} pt）
                      </option>
                    ))}
                  </select>
                  <label className="pp-label">方式</label>
                  <select className="pp-select" value={mode} onChange={(e) => setMode(e.target.value as FitMode)}>
                    <option value="contain">等比容纳（留白）</option>
                    <option value="cover">等比填满（裁切）</option>
                    <option value="stretch">拉满（变形）</option>
                  </select>
                </div>
                <div className="pp-actions">
                  <button className="btn primary" disabled={busy || !one} onClick={runUnify}>
                    统一页面大小
                  </button>
                  {singleOut && (
                    <>
                      <button className="btn" onClick={() => void doSave(singleOut, `${one!.name.replace(/\.pdf$/i, '')}_${size}.pdf`)}>
                        下载
                      </button>
                      <button
                        className="btn"
                        onClick={() => {
                          sendToBatchPrint([{ name: `${one!.name.replace(/\.pdf$/i, '')}_${size}.pdf`, data: singleOut }]);
                          setMsg('已发送到批量打印');
                        }}
                      >
                        发送到批量打印
                      </button>
                    </>
                  )}
                </div>
              </>
            )}

            {tab === 'images' && (
              <>
                <div className="pp-row">
                  <label className="pp-label">倍率</label>
                  <select className="pp-select" value={scale} onChange={(e) => setScale(Number(e.target.value))}>
                    <option value={1}>1×（72 dpi，预览用）</option>
                    <option value={1.5}>1.5×（108 dpi）</option>
                    <option value={2}>2×（144 dpi）</option>
                    <option value={3}>3×（216 dpi，打印推荐）</option>
                  </select>
                  <label className="pp-label">格式</label>
                  <select
                    className="pp-select"
                    value={imgFmt}
                    onChange={(e) => setImgFmt(e.target.value as 'image/jpeg' | 'image/png')}
                  >
                    <option value="image/jpeg">JPG（体积小）</option>
                    <option value="image/png">PNG（无损）</option>
                  </select>
                </div>
                <div className="pp-actions">
                  <button className="btn primary" disabled={busy || !one} onClick={runImages}>
                    转换并下载 ZIP
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {busy && <div className="pp-status">处理中…</div>}
        {msg && <div className={'pp-status' + (msg.startsWith('失败') ? ' err' : '')}>{msg}</div>}
      </div>
    </div>
  );
}
