import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CARD_TYPES,
  cardTypeOf,
  paperSize,
  computeCardGrid,
  pagePlacements,
  paginate,
  renderCardPage,
  type PaperId,
  type Orient,
  type Pos,
  type ColorMode,
  type LayoutCfg,
} from '../lib/idCardLayout';
import { exportPagesPdf } from '../lib/sheetPdf';
import { detectCardQuad, FULL_QUAD, type Quad } from '../lib/cardDetect';
import ManualCropModal from './ManualCropModal';

interface CardItem {
  key: number;
  name: string;
  img: HTMLImageElement;
  dataUrl: string;
  type: string; // CARD_TYPES id
  rotation: number; // 0/90/180/270
  checked: boolean;
  quad: Quad; // 自动检测角点（归一化）
  confidence: number; // 自动检测置信度 0..1
  manual: boolean; // 已应用手动角点校正
  corrected?: { img: HTMLImageElement; dataUrl: string };
}

let KEY = 1;

const NEED_CHECK = 0.6; // 置信度低于该值标记「需检查」

function loadImage(file: File): Promise<CardItem> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const det = detectCardQuad(img);
      resolve({
        key: KEY++,
        name: file.name,
        img,
        dataUrl: url,
        type: 'idcard',
        rotation: 0,
        checked: true,
        quad: det.quad,
        confidence: det.confidence,
        manual: false,
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    img.src = url;
  });
}

function download(dataUrl: string, name: string) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name;
  a.click();
}

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
  const [colorMode, setColorMode] = useState<ColorMode>('enhance');
  const [sat, setSat] = useState(100);
  const [sharpen, setSharpen] = useState(0);
  const [wmOn, setWmOn] = useState(false);
  const [wmText, setWmText] = useState('超誉工作台 clone');
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
    () => ({ perPage, gap: 4, shrink, pos, offX, offY }),
    [perPage, shrink, pos, offX, offY],
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
    () => computeCardGrid(paper.w, paper.h, maxCard.w, maxCard.h, cfg),
    [paper, maxCard, cfg],
  );
  const pages = useMemo(() => paginate(checked.length, grid.perPage), [checked.length, grid.perPage]);
  const placements = useMemo(() => pagePlacements(paper.w, paper.h, grid, cfg), [paper, grid, cfg]);
  const cur = Math.min(pageIdx, Math.max(0, pages.length - 1));

  const curPageImgs = useMemo(() => {
    const p = pages[cur] ?? [];
    return p.map((idx) => ({
      img: checked[idx].corrected?.img ?? checked[idx].img,
      rotation: checked[idx].rotation,
    }));
  }, [pages, cur, checked]);

  // 快捷键订阅：App 派发 chaoyu-hotkey，本工具响应导入/导出
  useEffect(() => {
    const onHotkey = (e: Event) => {
      const action = (e as CustomEvent<{ action: string }>).detail?.action;
      if (action === 'import') inputRef.current?.click();
      else if (action === 'export') doExportPdf();
    };
    window.addEventListener('chaoyu-hotkey', onHotkey);
    return () => window.removeEventListener('chaoyu-hotkey', onHotkey);
  }, [pages]);

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
    });
  }, [paper, placements, curPageImgs, pages.length, colorMode, sat, sharpen, wmOn, wmText]);

  useEffect(() => {
    if (pageIdx > pages.length - 1) setPageIdx(Math.max(0, pages.length - 1));
  }, [pages.length, pageIdx]);

  async function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setBusy(true);
    const added: CardItem[] = [];
    for (const f of Array.from(list)) {
      if (f.type.startsWith('image/')) {
        try {
          added.push(await loadImage(f));
        } catch {
          /* ignore */
        }
      }
    }
    setItems((prev) => [...prev, ...added]);
    setBusy(false);
  }

  function update(key: number, patch: Partial<CardItem>) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }
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
          img: checked[idx].corrected?.img ?? checked[idx].img,
          rotation: checked[idx].rotation,
        }));
        renderCardPage(cv, paper.w, paper.h, placements, imgs, pxPerMm, {
          colorMode,
          sat,
          sharpen,
          wm: { on: wmOn, text: wmText },
        });
        return cv;
      }),
    [pages, checked, paper, placements, colorMode, sat, sharpen, wmOn, wmText],
  );

  function doExportPdf() {
    if (pages.length === 0) return;
    setBusy(true);
    setTimeout(() => {
      try {
        exportPagesPdf(
          paper.w,
          paper.h,
          renderAll(EXPORT_DPI / 25.4),
          `证卡拼版_${paper.name}_${pages.length}页.pdf`,
        );
      } finally {
        setBusy(false);
      }
    }, 30);
  }

  function doPrint() {
    const api = (window as unknown as { electronAPI?: { print?: (o: unknown) => void } })
      .electronAPI;
    if (api?.print) api.print({ copies: 1 });
    else window.print();
  }

  function exportImages(type: 'png' | 'jpeg') {
    if (pages.length === 0) return;
    setBusy(true);
    setTimeout(() => {
      try {
        if (type === 'png') {
          renderAll(EXPORT_DPI / 25.4).forEach((cv, i) =>
            download(cv.toDataURL('image/png'), `证卡拼版_第${i + 1}页.png`),
          );
        } else {
          const cv = previewRef.current;
          if (cv) download(cv.toDataURL('image/jpeg', 0.92), `证卡拼版_第${cur + 1}页.jpg`);
        }
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
            onChange={(e) => handleFiles(e.target.files)}
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
              已内置<b>证件边缘自动检测</b>（本地经典算法，非云端模型）：导入时自动检测证件四角，
              检测置信度低时照片会标为<b>「需检查」</b>。点卡片操作行的<b>裁切按钮</b>可手动拖动角点、
              旋转、实时预览并应用校正，应用后排版与导出均使用矫正后的结果。
            </p>
          </div>
        )}

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
            const needs = !it.manual && it.confidence < NEED_CHECK;
            const badge = needs ? '需检查' : it.checked ? '可导出' : '已排除';
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
                  onChange={(e) => update(it.key, { type: e.target.value })}
                >
                  {CARD_TYPES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
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
            <em>｜{busy ? '处理中…' : `${checked.length} 张待排版`}</em>
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
