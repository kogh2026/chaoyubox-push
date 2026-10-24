import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BG_OPTIONS,
  matte,
  composePhoto,
  blobToImage,
  downloadBlob,
  mmToPx,
  type BgOption,
  type RetouchOpts,
} from '../lib/matting';
import {
  PAPER_SIZES,
  PHOTO_PRESETS,
  computeLayout,
  buildSheetImages,
  renderPreview,
  type PaperSize,
  type PhotoPreset,
} from '../lib/cardLayout';
import { exportSheetPdf } from '../lib/sheetPdf';

interface Result {
  name: string;
  blob: Blob;
  url: string;
}

const SHEET_MARGIN = 5;
const PREVIEW_SCALE = 3.4;

// 生成两张示例照片（本地画布绘制人像剪影，供"先试一张"）
function makeDemoPhoto(variant: number): File {
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
  // 头
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.ellipse(c.width / 2, 210, 92, 112, 0, 0, Math.PI * 2);
  ctx.fill();
  // 头发
  ctx.fillStyle = variant === 0 ? '#2a2320' : '#4a3325';
  ctx.beginPath();
  ctx.ellipse(c.width / 2, 158, 96, 74, 0, Math.PI, 0);
  ctx.fill();
  // 肩
  ctx.fillStyle = shirt;
  ctx.beginPath();
  ctx.ellipse(c.width / 2, 520, 170, 130, 0, 0, Math.PI * 2);
  ctx.fill();
  return new File([new Blob()], `示例照片${variant + 1}.jpg`, { type: 'image/jpeg' });
}

export default function IdPhoto() {
  const [files, setFiles] = useState<File[]>([]);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [tab, setTab] = useState<'photo' | 'sheet'>('photo');
  const [presetId, setPresetId] = useState('1cun');
  const [bgId, setBgId] = useState('white');
  const [customHex, setCustomHex] = useState('#ffffff');
  const [edgeThreshold, setEdgeThreshold] = useState(30);
  const [whitenOn, setWhitenOn] = useState(false);
  const [whitenLevel, setWhitenLevel] = useState<'natural' | 'rosy' | 'fair' | 'ultra'>('natural');
  const [brightness, setBrightness] = useState(0);
  const [paperId, setPaperId] = useState('r6');
  const [sheetMode, setSheetMode] = useState<'multi' | 'single'>('multi');
  const [gapMm, setGapMm] = useState(2);
  const [sizeMark, setSizeMark] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [sheets, setSheets] = useState<HTMLCanvasElement[]>([]);
  const [mattesVer, setMattesVer] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const matteCache = useRef<Map<File, Blob>>(new Map());

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
    const lvl = { natural: 0.15, rosy: 0.22, fair: 0.35, ultra: 0.5 }[whitenLevel];
    return {
      bg: bg.id === 'custom' ? { ...bg, hex: customHex } : bg,
      whiten: whitenOn ? lvl : 0,
      warm: whitenOn && whitenLevel === 'rosy' ? 0.2 : 0,
      brightness,
      edgeThreshold,
    };
  }, [bg, customHex, whitenOn, whitenLevel, brightness, edgeThreshold]);

  const pxW = mmToPx(preset.w, 300);
  const pxH = mmToPx(preset.h, 300);
  const layout = useMemo(
    () => computeLayout(paper.w, paper.h, preset.w, preset.h, SHEET_MARGIN, gapMm),
    [paper, preset, gapMm],
  );

  // ---------- 抠图（按文件缓存，规格/底色变化不重跑） ----------
  useEffect(() => {
    const todo = files.filter((f) => !matteCache.current.has(f));
    if (todo.length === 0) return;
    let cancelled = false;
    (async () => {
      setBusy(true);
      for (let i = 0; i < todo.length; i++) {
        if (cancelled) return;
        setProgress(`抠图 ${i + 1}/${todo.length}：${todo[i].name}`);
        try {
          const blob = await matte(todo[i], (k, c, t) => {
            setProgress(`抠图 ${i + 1}/${todo.length}：${k} ${c}/${t}`);
          });
          matteCache.current.set(todo[i], blob);
        } catch {
          /* 跳过失败项 */
        }
      }
      if (cancelled) return;
      setBusy(false);
      setProgress('');
      setMattesVer((v) => v + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [files]);

  // ---------- 合成（换底/美白/亮度秒级重算） ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: Result[] = [];
      for (let i = 0; i < files.length; i++) {
        if (!checked.has(i)) continue;
        const m = matteCache.current.get(files[i]);
        if (!m) continue;
        try {
          const blob = await composePhoto(m, retouch, pxW, pxH, 'image/jpeg');
          out.push({ name: files[i].name, blob, url: URL.createObjectURL(blob) });
        } catch {
          /* 跳过 */
        }
      }
      if (cancelled) return;
      setResults((prev) => {
        prev.forEach((r) => URL.revokeObjectURL(r.url));
        return out;
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mattesVer, checked, retouch, presetId]);

  // ---------- 排版页构建 ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (results.length === 0) {
        setSheets([]);
        return;
      }
      const imgs = await Promise.all(results.map((r) => blobToImage(r.blob)));
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
  }, [results, layout, preset, sheetMode]);

  // ---------- 预览绘制 ----------
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    renderPreview(canvas, {
      paper,
      layout,
      itemW: preset.w,
      itemH: preset.h,
      margin: SHEET_MARGIN,
      gap: gapMm,
      cutLines: true,
      sheets,
      scale: PREVIEW_SCALE,
    });
    // 尺寸标注
    if (sizeMark && sheets.length > 0) {
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.font = `${Math.max(9, 2.4 * PREVIEW_SCALE)}px sans-serif`;
      const label = `${pxW}×${pxH}px`;
      for (let r = 0; r < layout.rows; r++) {
        for (let c = 0; c < layout.cols; c++) {
          const x = (SHEET_MARGIN + c * (preset.w + gapMm)) * PREVIEW_SCALE;
          const y = (SHEET_MARGIN + r * (preset.h + gapMm)) * PREVIEW_SCALE;
          ctx.fillText(label, x + 2, y + 3.2 * PREVIEW_SCALE);
        }
      }
    }
  }, [paper, layout, preset, sheets, gapMm, sizeMark, pxW, pxH]);

  // ---------- 导入 ----------
  function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const imgs = Array.from(list).filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    setFiles((prev) => {
      const next = [...prev, ...imgs];
      setChecked(new Set(next.map((_, i) => i)));
      return next;
    });
  }

  function removeAt(i: number) {
    const f = files[i];
    matteCache.current.delete(f);
    setFiles((prev) => prev.filter((_, idx) => idx !== i));
    setChecked((prev) => {
      const next = new Set<number>();
      prev.forEach((v) => {
        if (v < i) next.add(v);
        else if (v > i) next.add(v - 1);
      });
      return next;
    });
  }

  function clearAll() {
    matteCache.current.clear();
    setFiles([]);
    setChecked(new Set());
    setResults([]);
    setSheets([]);
  }

  function toggleAll() {
    setChecked((prev) =>
      prev.size === files.length ? new Set() : new Set(files.map((_, i) => i)),
    );
  }

  function loadDemo() {
    const demos = [makeDemoPhoto(0), makeDemoPhoto(1)];
    setFiles((prev) => {
      const next = [...prev, ...demos];
      setChecked(new Set(next.map((_, i) => i)));
      return next;
    });
  }

  // ---------- 导出 ----------
  function exportAll() {
    results.forEach((r, i) => {
      setTimeout(() => {
        const base = r.name.replace(/\.[^.]+$/, '');
        downloadBlob(r.blob, `证件照_${base}_${preset.name}.jpg`);
      }, i * 350);
    });
  }

  function exportSheet() {
    if (sheets.length === 0) return;
    exportSheetPdf({
      paper,
      layout,
      itemW: preset.w,
      itemH: preset.h,
      margin: SHEET_MARGIN,
      gap: gapMm,
      cutLines: true,
      sheets,
      fileName: `证件照排版_${paper.name.split(' ')[0]}_${preset.name}.pdf`,
    });
  }

  function doPrint() {
    const api = (window as unknown as { electronAPI?: { print?: (o: unknown) => void } })
      .electronAPI;
    if (api?.print) api.print({ grayscale: false, copies: 1 });
    else window.print();
  }

  const allChecked = checked.size === files.length && files.length > 0;

  return (
    <div className="idp">
      {/* 左栏：照片列表 */}
      <aside className="idp-left">
        <button className="btn primary block" onClick={() => inputRef.current?.click()}>
          导入照片
        </button>
        <button className="btn block" onClick={() => folderRef.current?.click()}>
          导入文件夹
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*"
          hidden
          onChange={(e) => addFiles(e.target.files)}
        />
        <input
          ref={folderRef}
          type="file"
          multiple
          hidden
          // @ts-expect-error 非标准属性
          webkitdirectory=""
          directory=""
          onChange={(e) => addFiles(e.target.files)}
        />
        <div className="idp-listbar">
          <label>
            <input type="checkbox" checked={allChecked} onChange={toggleAll} /> 全选
          </label>
          <span className="muted">已选 {checked.size}/{files.length}</span>
          <button className="link" onClick={clearAll}>清空</button>
        </div>
        <div className="idp-list">
          {files.map((f, i) => (
            <div key={i} className={'idp-item' + (checked.has(i) ? ' on' : '')}>
              <input
                type="checkbox"
                checked={checked.has(i)}
                onChange={() =>
                  setChecked((prev) => {
                    const n = new Set(prev);
                    if (n.has(i)) n.delete(i);
                    else n.add(i);
                    return n;
                  })
                }
              />
              <img src={URL.createObjectURL(f)} alt={f.name} />
              <span className="idp-item-name" title={f.name}>{f.name}</span>
              <button className="idp-item-x" onClick={() => removeAt(i)} title="移除">×</button>
            </div>
          ))}
          {files.length === 0 && (
            <div className="idp-empty">
              <p>拖拽或点击导入照片</p>
              <p className="muted">支持生活照、证件照，可多张或整个文件夹拖拽进来</p>
            </div>
          )}
        </div>
        <div className="idp-demo">
          <div className="idp-demo-row">
            {[0, 1].map((v) => (
              <div key={v} className="idp-demo-card" onClick={loadDemo}>
                <canvas hidden ref={(el) => {
                  if (el) {
                    const d = makeDemoPhoto(v);
                    const img = new Image();
                    img.onload = () => el.getContext('2d')!.drawImage(img, 0, 0, el.width, el.height);
                    img.src = URL.createObjectURL(d);
                  }
                }} width={72} height={96} />
                <span>演示照片</span>
              </div>
            ))}
          </div>
          <p className="muted">先试一张，看看生成的证件照</p>
        </div>
      </aside>

      {/* 中栏：画布 / 结果 */}
      <main
        className="idp-center"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
        style={dragOver ? { outline: '2px dashed var(--brand)', outlineOffset: -4 } : undefined}
      >
        <div className="idp-tabs">
          <button className={tab === 'photo' ? 'on' : ''} onClick={() => setTab('photo')}>
            证件照
          </button>
          <button className={tab === 'sheet' ? 'on' : ''} onClick={() => setTab('sheet')}>
            排版照
          </button>
        </div>
        {busy && <div className="progress-text">{progress}</div>}
        {tab === 'photo' ? (
          results.length > 0 ? (
            <div className="idp-grid">
              {results.map((r, i) => (
                <figure key={i} className="idp-photo-card">
                  <img src={r.url} alt={r.name} />
                  <figcaption title={r.name}>{r.name}</figcaption>
                  <button className="idp-item-x" onClick={() => downloadBlob(r.blob, `证件照_${r.name}`)} title="下载这张">↓</button>
                </figure>
              ))}
            </div>
          ) : (
            <div className="idp-stage">
              <div className="idp-stage-box">
                <p className="idp-stage-t">导入照片后自动生成证件照</p>
                <p className="muted">支持多选、拖拽和批量处理</p>
              </div>
            </div>
          )
        ) : sheets.length > 0 ? (
          <div className="sheet-scroll">
            <canvas ref={previewRef} className="sheet-canvas" />
          </div>
        ) : (
          <div className="idp-stage">
            <div className="idp-stage-box">
              <p className="idp-stage-t">排版预览</p>
              <p className="muted">生成证件照后，按右侧「多张排版」设置出整版</p>
            </div>
          </div>
        )}
      </main>

      {/* 右栏：设置 */}
      <aside className="idp-right">
        <section className="idp-step">
          <h3><i>1</i> 照片规格</h3>
          <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
            {PHOTO_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <p className="muted">{pxW} × {pxH} px · 300DPI</p>
        </section>

        <section className="idp-step">
          <h3><i>2</i> 背景与抠图</h3>
          <div className="idp-swatches">
            {BG_OPTIONS.map((b) => (
              <button
                key={b.id}
                className={'idp-swatch' + (bgId === b.id ? ' on' : '')}
                title={b.name}
                onClick={() => setBgId(b.id)}
              >
                <span style={b.gradient
                  ? { background: `linear-gradient(135deg,${b.gradient[0]},${b.gradient[1]})` }
                  : { background: b.id === 'custom' ? customHex : b.hex }} />
              </button>
            ))}
          </div>
          {bgId === 'custom' && (
            <label className="idp-row">
              自定义 <input type="color" value={customHex} onChange={(e) => setCustomHex(e.target.value)} />
              <code className="muted">{customHex.toUpperCase()}</code>
            </label>
          )}
          <label className="idp-row">
            当前 <code className="muted">{(bg.id === 'custom' ? customHex : bg.hex).toUpperCase()}</code>
          </label>
          <label className="idp-slider">
            <span>抠图阈值</span>
            <input type="range" min={0} max={50} value={edgeThreshold}
              onChange={(e) => setEdgeThreshold(Number(e.target.value))} />
            <b>{edgeThreshold}</b>
          </label>
          <p className="muted">阈值越大边缘越干净；碎发多可调低。</p>
        </section>

        <section className="idp-step">
          <h3><i>3</i> 人像优化</h3>
          <label className="idp-row">
            <span>美白</span>
            <input type="checkbox" checked={whitenOn} onChange={(e) => setWhitenOn(e.target.checked)} />
          </label>
          {whitenOn && (
            <div className="seg">
              {([['natural', '自然'], ['rosy', '红润'], ['fair', '白皙'], ['ultra', '超白']] as const).map(
                ([id, name]) => (
                  <button key={id} className={'seg-btn' + (whitenLevel === id ? ' active' : '')}
                    onClick={() => setWhitenLevel(id)}>
                    {name}
                  </button>
                ),
              )}
            </div>
          )}
          <label className="idp-slider">
            <span>亮度</span>
            <input type="range" min={-50} max={50} value={brightness}
              onChange={(e) => setBrightness(Number(e.target.value))} />
            <b>{brightness}</b>
          </label>
        </section>

        <section className="idp-step">
          <h3><i>4</i> 多张排版</h3>
          <label className="idp-row">
            相纸尺寸
            <select value={paperId} onChange={(e) => setPaperId(e.target.value)}>
              {PAPER_SIZES.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="idp-row">
            排版方式
            <select value={sheetMode} onChange={(e) => setSheetMode(e.target.value as 'multi' | 'single')}>
              <option value="multi">各张独立</option>
              <option value="single">单张排版（重复第一张）</option>
            </select>
          </label>
          <label className="idp-slider">
            <span>照片间隔</span>
            <input type="range" min={0} max={10} value={gapMm}
              onChange={(e) => setGapMm(Number(e.target.value))} />
            <b>{gapMm} mm</b>
          </label>
          <label className="idp-row">
            尺寸标注
            <input type="checkbox" checked={sizeMark} onChange={(e) => setSizeMark(e.target.checked)} />
          </label>
          <p className="muted">每版 {layout.cols}×{layout.rows} = {layout.perSheet} 张</p>
        </section>
      </aside>

      {/* 底部栏 */}
      <footer className="idp-bottom">
        <div className="idp-bottom-l">
          <label>
            <input type="checkbox" checked={sizeMark} onChange={(e) => setSizeMark(e.target.checked)} /> 尺寸标注
          </label>
          <span className="muted">格式：单张 {results.length} 张（JPG）· 快捷键 Ctrl+O 导入</span>
        </div>
        <div className="idp-bottom-r">
          <button className="btn" disabled={sheets.length === 0} onClick={exportSheet}>
            排版导 PDF
          </button>
          <button className="btn primary" disabled={results.length === 0} onClick={exportAll}>
            导出证件照
          </button>
          <button className="btn" disabled={sheets.length === 0} onClick={doPrint}>
            打印
          </button>
        </div>
      </footer>
    </div>
  );
}
