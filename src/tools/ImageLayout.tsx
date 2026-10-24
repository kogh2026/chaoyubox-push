import { useEffect, useMemo, useRef, useState } from 'react';
import { PAPER_SIZES, type PaperSize } from '../lib/cardLayout';
import { exportGridPdf, renderGridPage } from '../lib/gridExport';

interface LoadedImg {
  name: string;
  img: HTMLImageElement;
  dataUrl: string;
}

const PREVIEW_SCALE = 3.4;
const CELL_DPI = 300;

function loadImage(file: File): Promise<LoadedImg> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ name: file.name, img, dataUrl: url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    img.src = url;
  });
}

// 把单张源图绘制到指定像素尺寸的单元格（cover 裁切 / contain 留白）
function drawInto(pxW: number, pxH: number, img: HTMLImageElement, fit: 'cover' | 'contain'): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(pxW));
  c.height = Math.max(1, Math.round(pxH));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  const sr = img.naturalWidth / img.naturalHeight;
  const tr = pxW / pxH;
  let dw = pxW;
  let dh = pxH;
  let dx = 0;
  let dy = 0;
  if (fit === 'cover') {
    if (sr > tr) {
      dw = pxH * sr;
      dh = pxH;
      dx = (pxW - dw) / 2;
    } else {
      dw = pxW;
      dh = pxW / sr;
      dy = (pxH - dh) / 2;
    }
  } else {
    if (sr > tr) {
      dw = pxW;
      dh = pxW / sr;
      dy = (pxH - dh) / 2;
    } else {
      dh = pxH;
      dw = pxH * sr;
      dx = (pxW - dw) / 2;
    }
  }
  ctx.drawImage(img, dx, dy, dw, dh);
  return c;
}

export default function ImageLayout() {
  const [images, setImages] = useState<LoadedImg[]>([]);
  const [mode, setMode] = useState<'grid' | 'stitch'>('grid');
  const [paperId, setPaperId] = useState('a4');
  const [cols, setCols] = useState(3);
  const [gap, setGap] = useState(3);
  const [margin, setMargin] = useState(8);
  const [fit, setFit] = useState<'cover' | 'contain'>('cover');
  const [cutLines, setCutLines] = useState(true);
  const [stitchDir, setStitchDir] = useState<'v' | 'h'>('v');
  const [stitchGap, setStitchGap] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const stitchRef = useRef<HTMLCanvasElement>(null);

  const paper: PaperSize = useMemo(
    () => PAPER_SIZES.find((p) => p.id === paperId) ?? PAPER_SIZES[0],
    [paperId],
  );

  // 网格：给定列数，单元格由纸张与列数自动均分
  const grid = useMemo(() => {
    const usableW = paper.w - 2 * margin;
    const usableH = paper.h - 2 * margin;
    const c = Math.max(1, cols);
    const itemW = (usableW - (c - 1) * gap) / c;
    const rows = itemW > 0 ? Math.max(1, Math.floor((usableH + gap) / (itemW + gap))) : 1;
    const itemH = rows > 0 ? (usableH - (rows - 1) * gap) / rows : usableH;
    return { cols: c, rows, perSheet: c * rows, itemW, itemH };
  }, [paper, cols, margin, gap]);

  const totalSheets = useMemo(
    () => (images.length === 0 ? 0 : Math.ceil(images.length / grid.perSheet)),
    [images.length, grid.perSheet],
  );

  const buildCells = (pageIndex: number): HTMLCanvasElement[] => {
    const pxW = (grid.itemW / 25.4) * CELL_DPI;
    const pxH = (grid.itemH / 25.4) * CELL_DPI;
    const arr: HTMLCanvasElement[] = [];
    const start = pageIndex * grid.perSheet;
    for (let i = 0; i < grid.perSheet; i++) {
      const src = images[start + i];
      if (!src) break;
      arr.push(drawInto(pxW, pxH, src.img, fit));
    }
    return arr;
  };

  useEffect(() => {
    if (mode !== 'grid' || !previewRef.current) return;
    renderGridPage(previewRef.current, {
      paper,
      layout: { cols: grid.cols, rows: grid.rows, perSheet: grid.perSheet },
      itemW: grid.itemW,
      itemH: grid.itemH,
      margin,
      gap,
      cutLines,
      cells: buildCells(0),
      scale: PREVIEW_SCALE,
    });
  }, [mode, paper, grid, margin, gap, cutLines, fit, images]);

  const buildStitch = (): HTMLCanvasElement | null => {
    if (images.length === 0) return null;
    const baseW = 1080;
    const innerGap = (stitchGap / 25.4) * 96; // mm -> px(96dpi) 近似
    if (stitchDir === 'v') {
      const heights = images.map((s) => (baseW * s.img.naturalHeight) / s.img.naturalWidth);
      const totalH = heights.reduce((a, b) => a + b, 0) + innerGap * (images.length - 1);
      const c = document.createElement('canvas');
      c.width = baseW;
      c.height = Math.round(totalH);
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      let y = 0;
      images.forEach((s, i) => {
        ctx.drawImage(s.img, 0, y, baseW, heights[i]);
        y += heights[i] + innerGap;
      });
      return c;
    }
    const widths = images.map((s) => (baseW * s.img.naturalWidth) / s.img.naturalHeight);
    const totalW = widths.reduce((a, b) => a + b, 0) + innerGap * (images.length - 1);
    const c = document.createElement('canvas');
    c.width = Math.round(totalW);
    c.height = baseW;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    let x = 0;
    images.forEach((s, i) => {
      ctx.drawImage(s.img, x, 0, widths[i], baseW);
      x += widths[i] + innerGap;
    });
    return c;
  };

  useEffect(() => {
    if (mode !== 'stitch' || !stitchRef.current) return;
    const c = buildStitch();
    if (c) {
      stitchRef.current.width = c.width;
      stitchRef.current.height = c.height;
      stitchRef.current.getContext('2d')!.drawImage(c, 0, 0);
    }
  }, [mode, images, stitchDir, stitchGap]);

  async function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setBusy(true);
    const imgs: LoadedImg[] = [];
    for (const f of Array.from(list)) {
      if (f.type.startsWith('image/')) {
        try {
          imgs.push(await loadImage(f));
        } catch {
          /* ignore */
        }
      }
    }
    setImages((prev) => [...prev, ...imgs]);
    setBusy(false);
  }

  function removeImage(i: number) {
    setImages((prev) => prev.filter((_, idx) => idx !== i));
  }

  function exportPdf() {
    if (images.length === 0) return;
    const pages: HTMLCanvasElement[][] = [];
    for (let p = 0; p < totalSheets; p++) pages.push(buildCells(p));
    exportGridPdf({
      paper,
      layout: { cols: grid.cols, rows: grid.rows, perSheet: grid.perSheet },
      itemW: grid.itemW,
      itemH: grid.itemH,
      margin,
      gap,
      cutLines,
      pages,
      fileName: `图片拼版_${paper.name.split(' ')[0]}.pdf`,
    });
  }

  function exportStitch() {
    const c = buildStitch();
    if (!c) return;
    c.toBlob((b) => {
      if (!b) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = '拼接长图.png';
      a.click();
    }, 'image/png');
  }

  function doPrint() {
    const api = (window as unknown as { electronAPI?: { print?: (o: unknown) => void } }).electronAPI;
    if (api?.print) api.print({ grayscale: true, copies: 1 });
    else window.print();
  }

  return (
    <div className="image-layout">
      <header className="tool-head">
        <h1>图片拼版</h1>
        <p>多张图片网格排版到纸张（打印用），或拼接成一张长图（分享用）。纯前端，不上传。</p>
      </header>

      <section
        className={'dropzone' + (dragOver ? ' over' : '')}
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
        onClick={() => inputRef.current?.click()}
      >
        {busy ? '读取中…' : '点击或拖拽 图片 到此处（可多选）'}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => handleFiles(e.target.files)}
        />
      </section>

      {images.length > 0 && (
        <section className="img-strip">
          {images.map((im, i) => (
            <div key={i} className="thumb">
              <img src={im.dataUrl} alt={im.name} />
              <button className="thumb-x" onClick={() => removeImage(i)} title="移除">
                ×
              </button>
              <span className="thumb-name" title={im.name}>
                {im.name}
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="params">
        <div className="param-row">
          <label>模式</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as 'grid' | 'stitch')}>
            <option value="grid">网格拼版（到纸张）</option>
            <option value="stitch">拼接长图（成一张图）</option>
          </select>
        </div>
        {mode === 'grid' ? (
          <>
            <div className="param-row">
              <label>纸张</label>
              <select value={paperId} onChange={(e) => setPaperId(e.target.value)}>
                {PAPER_SIZES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <label>列数</label>
              <input
                type="number"
                min={1}
                max={12}
                value={cols}
                onChange={(e) => setCols(Math.max(1, Number(e.target.value) || 1))}
                className="narrow"
              />
            </div>
            <div className="param-row">
              <label>边距(mm)</label>
              <input
                type="number"
                value={margin}
                min={0}
                onChange={(e) => setMargin(Math.max(0, Number(e.target.value) || 0))}
                className="narrow"
              />
              <label>间距(mm)</label>
              <input
                type="number"
                value={gap}
                min={0}
                onChange={(e) => setGap(Math.max(0, Number(e.target.value) || 0))}
                className="narrow"
              />
              <label>填充</label>
              <select value={fit} onChange={(e) => setFit(e.target.value as 'cover' | 'contain')}>
                <option value="cover">裁切填满</option>
                <option value="contain">留白居中</option>
              </select>
              <label className="chk">
                <input type="checkbox" checked={cutLines} onChange={(e) => setCutLines(e.target.checked)} /> 裁剪参考线
              </label>
            </div>
          </>
        ) : (
          <div className="param-row">
            <label>方向</label>
            <select value={stitchDir} onChange={(e) => setStitchDir(e.target.value as 'v' | 'h')}>
              <option value="v">纵向拼接</option>
              <option value="h">横向拼接</option>
            </select>
            <label>间隔(mm)</label>
            <input
              type="number"
              value={stitchGap}
              min={0}
              onChange={(e) => setStitchGap(Math.max(0, Number(e.target.value) || 0))}
              className="narrow"
            />
          </div>
        )}
      </section>

      {mode === 'grid' ? (
        <section className="preview-wrap">
          <div className="preview-info">
            <span>
              每张：<b>{grid.cols}</b> 列 × <b>{grid.rows}</b> 行 = <b>{grid.perSheet}</b> 张
            </span>
            {images.length > 0 && (
              <span>
                ，共 <b>{totalSheets}</b> 张纸（{images.length} 张图）
              </span>
            )}
          </div>
          {images.length > 0 ? (
            <div className="sheet-scroll">
              <canvas ref={previewRef} className="sheet-canvas" />
            </div>
          ) : (
            <div className="empty-preview">导入图片后显示排版预览</div>
          )}
        </section>
      ) : (
        <section className="preview-wrap">
          {images.length > 0 ? (
            <div className="stitch-wrap">
              <canvas ref={stitchRef} className="stitch-canvas" />
            </div>
          ) : (
            <div className="empty-preview">导入图片后显示拼接预览</div>
          )}
        </section>
      )}

      <section className="actions">
        {mode === 'grid' ? (
          <>
            <button className="btn primary" disabled={images.length === 0} onClick={exportPdf}>
              导出 PDF
            </button>
            <button className="btn" disabled={images.length === 0} onClick={doPrint}>
              打印（真实打印机）
            </button>
          </>
        ) : (
          <button className="btn primary" disabled={images.length === 0} onClick={exportStitch}>
            导出长图 PNG
          </button>
        )}
      </section>

      <div className="hint">
        提示：网格模式下单元格由纸张与列数自动均分，图片以所选方式填充；拼接长图适合发朋友圈/海报。纯前端处理，图片不会上传服务器。
      </div>
    </div>
  );
}
