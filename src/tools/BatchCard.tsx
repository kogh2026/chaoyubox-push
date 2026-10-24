import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { PAPER_SIZES, computeLayout, type PaperSize } from '../lib/cardLayout';
import { exportGridPdf, renderGridPage } from '../lib/gridExport';

interface RecordT {
  name: string;
  sub?: string;
}

const PREVIEW_SCALE = 3.4;
const CARD_DPI = 300;

function parseText(text: string): RecordT[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[,，\t]+/).map((s) => s.trim());
      return { name: parts[0], sub: parts[1] || undefined };
    });
}

export default function BatchCard() {
  const [text, setText] = useState('');
  const [records, setRecords] = useState<RecordT[]>([]);
  const [template, setTemplate] = useState<'seat' | 'badge'>('seat');
  const [cardW, setCardW] = useState(200);
  const [cardH, setCardH] = useState(140);
  const [fontMm, setFontMm] = useState(40);
  const [bg, setBg] = useState('#ffffff');
  const [fg, setFg] = useState('#c0202a');
  const [avatar, setAvatar] = useState<HTMLImageElement | null>(null);
  const [paperId, setPaperId] = useState('a4');
  const [margin, setMargin] = useState(5);
  const [gap, setGap] = useState(2);
  const [cutLines, setCutLines] = useState(true);
  const avatarRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const thumbRefs = useRef<(HTMLCanvasElement | null)[]>([]);

  const paper: PaperSize = useMemo(
    () => PAPER_SIZES.find((p) => p.id === paperId) ?? PAPER_SIZES[0],
    [paperId],
  );

  const layout = useMemo(
    () => computeLayout(paper.w, paper.h, cardW, cardH, margin, gap),
    [paper, cardW, cardH, margin, gap],
  );

  const totalSheets = useMemo(
    () => (records.length === 0 ? 0 : Math.ceil(records.length / layout.perSheet)),
    [records.length, layout.perSheet],
  );

  function drawCard(rec: RecordT, idx: number): HTMLCanvasElement {
    const pxW = (cardW / 25.4) * CARD_DPI;
    const pxH = (cardH / 25.4) * CARD_DPI;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(pxW));
    cv.height = Math.max(1, Math.round(pxH));
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cv.width, cv.height);
    const fontPx = (fontMm / 25.4) * CARD_DPI;
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (template === 'seat') {
      ctx.font = `bold ${fontPx}px "Microsoft YaHei", sans-serif`;
      ctx.fillText(rec.name, cv.width / 2, cv.height / 2 - (rec.sub ? fontPx * 0.5 : 0));
      if (rec.sub) {
        ctx.font = `${fontPx * 0.42}px "Microsoft YaHei", sans-serif`;
        ctx.fillText(rec.sub, cv.width / 2, cv.height / 2 + fontPx * 0.6);
      }
    } else {
      const aS = Math.min(cv.width, cv.height) * 0.42;
      const ax = (cv.width - aS) / 2;
      const ay = cv.height * 0.08;
      ctx.strokeStyle = fg;
      ctx.lineWidth = Math.max(2, fontPx * 0.05);
      ctx.strokeRect(ax, ay, aS, aS);
      if (avatar) {
        const sr = avatar.naturalWidth / avatar.naturalHeight;
        let dw = aS;
        let dh = aS;
        let dx = ax;
        let dy = ay;
        if (sr > 1) {
          dw = aS * sr;
          dx = ax - (dw - aS) / 2;
        } else {
          dh = aS / sr;
          dy = ay - (dh - aS) / 2;
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(ax, ay, aS, aS);
        ctx.clip();
        ctx.drawImage(avatar, dx, dy, dw, dh);
        ctx.restore();
      } else {
        ctx.fillStyle = fg;
        ctx.font = `${aS * 0.16}px "Microsoft YaHei", sans-serif`;
        ctx.fillText('照片', cv.width / 2, ay + aS / 2);
      }
      ctx.fillStyle = fg;
      ctx.font = `bold ${fontPx * 0.5}px "Microsoft YaHei", sans-serif`;
      ctx.fillText(rec.name, cv.width / 2, ay + aS + fontPx * 0.4);
      ctx.font = `${fontPx * 0.3}px "Microsoft YaHei", sans-serif`;
      ctx.fillText(`No.${String(idx + 1).padStart(3, '0')}`, cv.width / 2, ay + aS + fontPx * 0.8);
    }
    return cv;
  }

  const cardCanvases = useMemo(
    () => records.map((r, i) => drawCard(r, i)),
    [records, template, cardW, cardH, fontMm, bg, fg, avatar],
  );

  const firstPageCells = useMemo(() => cardCanvases.slice(0, layout.perSheet), [cardCanvases, layout.perSheet]);

  useEffect(() => {
    if (!previewRef.current) return;
    renderGridPage(previewRef.current, {
      paper,
      layout,
      itemW: cardW,
      itemH: cardH,
      margin,
      gap,
      cutLines,
      cells: firstPageCells,
      scale: PREVIEW_SCALE,
    });
  }, [paper, layout, cardW, cardH, margin, gap, cutLines, firstPageCells]);

  useEffect(() => {
    cardCanvases.forEach((cv, i) => {
      const t = thumbRefs.current[i];
      if (t) {
        t.width = cv.width;
        t.height = cv.height;
        t.getContext('2d')!.drawImage(cv, 0, 0);
      }
    });
  }, [cardCanvases]);

  function applyText() {
    setRecords(parseText(text));
  }

  function handleXlsx(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];
        const recs: RecordT[] = [];
        for (const row of rows) {
          if (!row || row.length === 0) continue;
          const name = String(row[0] ?? '').trim();
          if (!name) continue;
          recs.push({ name, sub: row[1] != null ? String(row[1]).trim() : undefined });
        }
        setRecords(recs);
      } catch {
        /* ignore */
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function loadAvatar(file: File) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => setAvatar(img);
    img.src = url;
  }

  function exportPdf() {
    if (records.length === 0) return;
    const pages: HTMLCanvasElement[][] = [];
    for (let p = 0; p < totalSheets; p++) {
      pages.push(cardCanvases.slice(p * layout.perSheet, (p + 1) * layout.perSheet));
    }
    exportGridPdf({
      paper,
      layout,
      itemW: cardW,
      itemH: cardH,
      margin,
      gap,
      cutLines,
      pages,
      fileName: `批量制卡_${template}_${records.length}张.pdf`,
    });
  }

  function doPrint() {
    const api = (window as unknown as { electronAPI?: { print?: (o: unknown) => void } }).electronAPI;
    if (api?.print) api.print({ grayscale: false, copies: 1 });
    else window.print();
  }

  return (
    <div className="batch-card">
      <header className="tool-head">
        <h1>批量制卡</h1>
        <p>名单（文本 / Excel）套用模板 → 批量生成席卡 / 工作证 → 网格排版 → 导出 PDF / 打印</p>
      </header>

      <section className="params">
        <div className="param-row">
          <label>模板</label>
          <select value={template} onChange={(e) => setTemplate(e.target.value as 'seat' | 'badge')}>
            <option value="seat">席卡（横向大姓名）</option>
            <option value="badge">工作证（竖版含照片框）</option>
          </select>
          <label>纸张</label>
          <select value={paperId} onChange={(e) => setPaperId(e.target.value)}>
            {PAPER_SIZES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="param-row">
          <label>卡片尺寸(mm)</label>
          <input
            type="number"
            value={cardW}
            min={20}
            onChange={(e) => setCardW(Math.max(20, Number(e.target.value) || 20))}
            className="narrow"
          />
          <span>×</span>
          <input
            type="number"
            value={cardH}
            min={20}
            onChange={(e) => setCardH(Math.max(20, Number(e.target.value) || 20))}
            className="narrow"
          />
          <label>字号(mm)</label>
          <input
            type="number"
            value={fontMm}
            min={5}
            onChange={(e) => setFontMm(Math.max(5, Number(e.target.value) || 5))}
            className="narrow"
          />
        </div>
        <div className="param-row">
          <label>底色</label>
          <input type="color" value={bg} onChange={(e) => setBg(e.target.value)} />
          <label>文字色</label>
          <input type="color" value={fg} onChange={(e) => setFg(e.target.value)} />
          {template === 'badge' && (
            <button className="btn" onClick={() => avatarRef.current?.click()}>
              上传头像
            </button>
          )}
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
          <label className="chk">
            <input type="checkbox" checked={cutLines} onChange={(e) => setCutLines(e.target.checked)} /> 裁剪参考线
          </label>
        </div>
        <input
          ref={avatarRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) loadAvatar(f);
          }}
        />
      </section>

      <section className="params">
        <div className="param-row">
          <label>名单（每行一条）</label>
        </div>
        <textarea
          className="records-area"
          value={text}
          placeholder={'张三\n李四 销售部\n王五 技术部'}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="param-row">
          <button className="btn primary" onClick={applyText}>
            解析名单
          </button>
          <label className="btn" style={{ cursor: 'pointer' }}>
            导入 Excel
            <input
              type="file"
              accept=".xlsx,.xls"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleXlsx(f);
              }}
            />
          </label>
          <span className="muted">已解析 {records.length} 条（Excel 取前两列：姓名 / 副标题）</span>
        </div>
      </section>

      {records.length > 0 && (
        <section className="card-grid">
          {records.slice(0, 24).map((r, i) => (
            <div key={i} className="card-thumb">
              <canvas ref={(el) => {
                thumbRefs.current[i] = el;
              }} />
              <div className="cap">{r.name}</div>
            </div>
          ))}
          {records.length > 24 && <div className="cap muted">…共 {records.length} 张</div>}
        </section>
      )}

      <section className="preview-wrap">
        <div className="preview-info">
          <span>
            每张纸：<b>{layout.cols}</b> 列 × <b>{layout.rows}</b> 行 = <b>{layout.perSheet}</b> 张
          </span>
          {records.length > 0 && (
            <span>
              ，共 <b>{totalSheets}</b> 张纸（{records.length} 张卡）
            </span>
          )}
        </div>
        {records.length > 0 ? (
          <div className="sheet-scroll">
            <canvas ref={previewRef} className="sheet-canvas" />
          </div>
        ) : (
          <div className="empty-preview">解析名单后显示排版预览</div>
        )}
      </section>

      <section className="actions">
        <button className="btn primary" disabled={records.length === 0} onClick={exportPdf}>
          导出 PDF
        </button>
        <button className="btn" disabled={records.length === 0} onClick={doPrint}>
          打印（真实打印机）
        </button>
      </section>

      <div className="hint">
        提示：席卡适合会议 / 宴席桌签（横向大号姓名）；工作证适合活动入场（含照片框与编号）。纯前端生成，名单与照片不出本机。
      </div>
    </div>
  );
}
