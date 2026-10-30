// 自定义交互面板：页面重排 / 逐页旋转 / 书签勾选 / 水印定位 / 批注框选 / 元数据 / 签名报告。
// 这些工具的交互超出通用参数 schema，单独实现。
import { useEffect, useMemo, useRef, useState } from 'react';
import { PDFDocument } from 'pdf-lib';
import { readOutline, outlineSections } from '../../lib/pdfOutline';
import { renderThumbs, releaseThumbs, type Thumb } from '../../lib/pdfRaster';
import { computeWindow } from '../../lib/virtualList';
import { pxToPdf, type AnnotItem, type AnnotKind } from '../../lib/pdfAnnot';
import {
  readMetadata,
  writeMetadata,
  inspectSignatures,
  type PdfMetadata,
  type SignatureReport,
} from '../../lib/pdfTools';

/* ===== 缩略图加载 ===== */

function useThumbs(data: Uint8Array | null, scale: number) {
  const [thumbs, setThumbs] = useState<Thumb[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    let created: Thumb[] = [];
    if (!data) {
      setThumbs([]);
      return;
    }
    setLoading(true);
    setError('');
    renderThumbs(data, scale)
      .then((t) => {
        created = t;
        if (alive) setThumbs(t);
        else releaseThumbs(t); // 已切换/卸载：立即释放 Blob URL
      })
      .catch((e) => {
        if (alive) setError((e as Error)?.message || String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      if (created.length) releaseThumbs(created); // G15：释放上一批缩略图
    };
  }, [data, scale]);
  return { thumbs, loading, error };
}

function pageCountOf(data: Uint8Array): Promise<number> {
  return PDFDocument.load(data, { ignoreEncryption: true }).then((d) => d.getPageCount());
}

/* ===== 1. 整理页序（拖拽 + 插白页） ===== */

export function ReorderPanel({
  data,
  order,
  onOrder,
}: {
  data: Uint8Array;
  order: number[];
  onOrder: (o: number[]) => void;
}) {
  const { thumbs, loading, error } = useThumbs(data, 0.2);
  const dragFrom = useRef<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    onOrder(next);
  }

  function insertBlank(i: number) {
    const next = [...order];
    next.splice(i + 1, 0, -1);
    onOrder(next);
  }

  function remove(i: number) {
    if (order.length <= 1) return;
    onOrder(order.filter((_, j) => j !== i));
  }

  return (
    <div className="pdfx-custom">
      <div className="pdfx-custom-head">
        <b>页面顺序</b>
        <span className="muted">拖动缩略图调整；-1 位置为空白页</span>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => onOrder([...Array(thumbs.length || order.length).keys()])}>
          重置为原顺序
        </button>
      </div>
      {loading && <div className="muted">正在渲染缩略图…</div>}
      {error && <div className="pdfx-err">{error}</div>}
      <div className="pdfx-reorder">
        {order.map((src, i) => (
          <div
            key={i}
            className={'pdfx-pg' + (overIdx === i ? ' over' : '')}
            draggable
            onDragStart={() => {
              dragFrom.current = i;
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setOverIdx(i);
            }}
            onDragLeave={() => setOverIdx((v) => (v === i ? null : v))}
            onDrop={(e) => {
              e.preventDefault();
              const from = dragFrom.current;
              setOverIdx(null);
              dragFrom.current = null;
              if (from === null || from === i) return;
              const next = [...order];
              const [moved] = next.splice(from, 1);
              next.splice(i, 0, moved);
              onOrder(next);
            }}
          >
            {src >= 0 && thumbs[src] ? (
              <img src={thumbs[src].url} alt="" className="pdfx-pg-img" draggable={false} />
            ) : (
              <div className="pdfx-pg-blank">空白页</div>
            )}
            <span className="pdfx-pg-no">{src >= 0 ? `第 ${src + 1} 页` : '空白'}</span>
            <span className="pdfx-pg-ops">
              <button title="上移" disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button title="下移" disabled={i === order.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
              <button title="在后面插入空白页" onClick={() => insertBlank(i)}>
                ＋
              </button>
              <button title="移除" disabled={order.length <= 1} onClick={() => remove(i)}>
                ×
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ===== 2. 逐页旋转 ===== */

const ANGLE_OPTS: [number, string][] = [
  [0, '0°'],
  [90, '90°'],
  [180, '180°'],
  [270, '270°'],
];

// G15：固定行高虚拟滚动（行高 46 = 缩略图 42 + 间距 4）；页数超过阈值才启用，
// 保证小文档的 DOM 结构与样式完全不发生变化。
const ROT_ROW_H = 46;
const ROT_VIRTUAL_MIN = 40;

export function RotatePanel({
  data,
  angles,
  onAngles,
}: {
  data: Uint8Array;
  angles: number[];
  onAngles: (a: number[]) => void;
}) {
  const { thumbs, loading, error } = useThumbs(data, 0.12);
  const n = Math.max(angles.length, thumbs.length);
  const list = useMemo(() => Array.from({ length: n }, (_, i) => angles[i] ?? 0), [n, angles]);

  // 可视窗口：监听滚动容器自身的 scrollTop / clientHeight
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [win, setWin] = useState({ top: 0, h: 340 });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const sync = () => setWin({ top: el.scrollTop, h: el.clientHeight || 340 });
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', sync);
      ro?.disconnect();
    };
  }, [n]);

  function setAll(a: number) {
    onAngles(Array.from({ length: n }, () => a));
  }

  function setOne(i: number, v: number) {
    const next = [...list];
    next[i] = v;
    onAngles(next);
  }

  const rowBody = (i: number) => (
    <>
      <span className="pdfx-rot-no">{i + 1}</span>
      {thumbs[i] && <img className="pdfx-rot-img" src={thumbs[i].url} alt="" />}
      <span className="pdfx-seg">
        {ANGLE_OPTS.map(([v, label]) => (
          <button
            key={v}
            className={'pdfx-seg-b' + (list[i] === v ? ' on' : '')}
            onClick={() => setOne(i, v)}
          >
            {label}
          </button>
        ))}
      </span>
    </>
  );

  const virtual = n > ROT_VIRTUAL_MIN;
  const range = virtual
    ? computeWindow(n, ROT_ROW_H, win.top, win.h, 3)
    : { start: 0, end: n, offsetY: 0, totalHeight: n * ROT_ROW_H };

  return (
    <div className="pdfx-custom">
      <div className="pdfx-custom-head">
        <b>逐页角度</b>
        <span className="muted">共 {n} 页，可单页设置</span>
        <span style={{ flex: 1 }} />
        {ANGLE_OPTS.map(([a, label]) => (
          <button key={a} className="btn" onClick={() => setAll(a)}>
            全部 {label}
          </button>
        ))}
      </div>
      {loading && <div className="muted">正在渲染缩略图…</div>}
      {error && <div className="pdfx-err">{error}</div>}
      <div className="pdfx-rot" ref={boxRef}>
        {virtual ? (
          <div className="pdfx-rot-vlist" style={{ height: range.totalHeight }}>
            {Array.from({ length: range.end - range.start }, (_, k) => range.start + k).map((i) => (
              <div
                key={i}
                className="pdfx-rot-row pdfx-rot-vrow"
                style={{ top: range.offsetY + (i - range.start) * ROT_ROW_H, height: ROT_ROW_H - 4 }}
              >
                {rowBody(i)}
              </div>
            ))}
          </div>
        ) : (
          Array.from({ length: range.end - range.start }, (_, k) => range.start + k).map((i) => (
            <div className="pdfx-rot-row" key={i}>
              {rowBody(i)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ===== 3. 书签勾选 ===== */

interface Section {
  title: string;
  from: number;
  to: number;
  depth: number;
}

export function BookmarkPanel({
  data,
  selected,
  onSelected,
}: {
  data: Uint8Array;
  selected: number[];
  onSelected: (s: number[]) => void;
}) {
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const total = await pageCountOf(data);
        const nodes = await readOutline(data);
        const secs = outlineSections(nodes, total);
        if (!alive) return;
        setSections(secs.map((s) => ({ title: s.title, from: s.from, to: s.to, depth: s.depth })));
      } catch (e) {
        if (alive) setError((e as Error)?.message || String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [data]);

  function toggle(i: number) {
    onSelected(selected.includes(i) ? selected.filter((x) => x !== i) : [...selected, i]);
  }

  if (loading) return <div className="pdfx-custom muted">正在读取书签…</div>;
  if (error) return <div className="pdfx-custom pdfx-err">{error}</div>;
  if (sections.length === 0)
    return <div className="pdfx-custom muted">该文档没有书签，无法按书签拆分</div>;

  return (
    <div className="pdfx-custom">
      <div className="pdfx-custom-head">
        <b>书签章节</b>
        <span className="muted">已选 {selected.length} / {sections.length}</span>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => onSelected(sections.map((_, i) => i))}>
          全选
        </button>
        <button className="btn" onClick={() => onSelected([])}>
          全不选
        </button>
      </div>
      <div className="pdfx-bm">
        {sections.map((s, i) => (
          <label key={i} className="pdfx-bm-row" style={{ paddingLeft: 8 + s.depth * 16 }}>
            <input type="checkbox" checked={selected.includes(i)} onChange={() => toggle(i)} />
            <span className="pdfx-bm-title">{s.title || '（无标题）'}</span>
            <span className="muted">
              P{s.from}
              {s.to > s.from ? `-P${s.to}` : ''}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

/* ===== 4. 水印定位 ===== */

export function WmPosPanel({
  data,
  pos,
  onPos,
}: {
  data: Uint8Array;
  pos: { x: number; y: number };
  onPos: (p: { x: number; y: number }) => void;
}) {
  const { thumbs, loading, error } = useThumbs(data, 0.5);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const first = thumbs[0];

  function applyFromEvent(clientX: number, clientY: number) {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, 1 - (clientY - r.top) / r.height));
    onPos({ x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 });
  }

  return (
    <div className="pdfx-custom">
      <div className="pdfx-custom-head">
        <b>水印位置</b>
        <span className="muted">
          单点水印中心：X {Math.round(pos.x * 100)}% · Y {Math.round(pos.y * 100)}%（左下为原点）
        </span>
        <span style={{ flex: 1 }} />
        {(
          [
            ['居中', 0.5, 0.5],
            ['左上', 0.08, 0.92],
            ['右上', 0.92, 0.92],
            ['左下', 0.08, 0.08],
            ['右下', 0.92, 0.08],
          ] as [string, number, number][]
        ).map(([label, x, y]) => (
          <button key={label} className="btn" onClick={() => onPos({ x, y })}>
            {label}
          </button>
        ))}
      </div>
      {loading && <div className="muted">正在渲染首页…</div>}
      {error && <div className="pdfx-err">{error}</div>}
      {first && (
        <div
          className="pdfx-wmbox"
          ref={boxRef}
          onMouseDown={(e) => {
            dragging.current = true;
            applyFromEvent(e.clientX, e.clientY);
          }}
          onMouseMove={(e) => {
            if (dragging.current) applyFromEvent(e.clientX, e.clientY);
          }}
          onMouseUp={() => {
            dragging.current = false;
          }}
          onMouseLeave={() => {
            dragging.current = false;
          }}
        >
          <img src={first.url} alt="首页预览" draggable={false} />
          <span
            className="pdfx-wm-cross"
            style={{ left: `${pos.x * 100}%`, top: `${(1 - pos.y) * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}

/* ===== 5. 批注框选 ===== */

const ANNOT_SCALE = 0.6;

export function AnnotatePanel({
  data,
  items,
  onItems,
  kind,
  color,
  opacity,
  note,
}: {
  data: Uint8Array;
  items: AnnotItem[];
  onItems: (it: AnnotItem[]) => void;
  kind: AnnotKind;
  color: string;
  opacity: number;
  note: string;
}) {
  const { thumbs, loading, error } = useThumbs(data, ANNOT_SCALE);
  const [page, setPage] = useState(1);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const pageIdx = Math.min(Math.max(1, page), thumbs.length || 1) - 1;
  const thumb = thumbs[pageIdx];

  function relPos(e: { clientX: number; clientY: number }) {
    const el = boxRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  }

  function commit() {
    if (!drag || !thumb) {
      setDrag(null);
      return;
    }
    const el = boxRef.current;
    if (!el) {
      setDrag(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    const rw = Math.abs(drag.x1 - drag.x0) * rect.width;
    const rh = Math.abs(drag.y1 - drag.y0) * rect.height;
    setDrag(null);
    if (rw < 4 || rh < 3) return;
    const p1 = pxToPdf(
      Math.min(drag.x0, drag.x1) * rect.width,
      Math.min(drag.y0, drag.y1) * rect.height,
      ANNOT_SCALE,
      thumb.h / ANNOT_SCALE,
    );
    const p2 = pxToPdf(
      Math.max(drag.x0, drag.x1) * rect.width,
      Math.max(drag.y0, drag.y1) * rect.height,
      ANNOT_SCALE,
      thumb.h / ANNOT_SCALE,
    );
    const [cr, cg, cb] = hexToRgb(color);
    const item: AnnotItem = {
      page: pageIdx + 1,
      kind,
      rect: { x: p1.x, y: p1.y, w: p2.x - p1.x, h: p2.y - p1.y },
      color: [cr, cg, cb],
      opacity: kind === 'square' || kind === 'note' ? undefined : opacity,
      note: kind === 'note' ? note : undefined,
    };
    onItems([...items, item]);
  }

  return (
    <div className="pdfx-custom">
      <div className="pdfx-custom-head">
        <b>划选批注区域</b>
        <span className="muted">
          在预览页上按住拖动；已添加 {items.length} 条
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn" disabled={pageIdx <= 0} onClick={() => setPage(pageIdx)}>
          上一页
        </button>
        <span className="muted">
          {pageIdx + 1} / {thumbs.length || '?'}
        </span>
        <button className="btn" disabled={pageIdx >= thumbs.length - 1} onClick={() => setPage(pageIdx + 2)}>
          下一页
        </button>
      </div>
      {loading && <div className="muted">正在渲染页面…</div>}
      {error && <div className="pdfx-err">{error}</div>}
      {thumb && (
        <div
          className="pdfx-annotbox"
          ref={boxRef}
          style={{ width: thumb.w, height: thumb.h }}
          onMouseDown={(e) => {
            const p = relPos(e);
            if (p) setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
          }}
          onMouseMove={(e) => {
            if (!drag) return;
            const p = relPos(e);
            if (p) setDrag({ ...drag, x1: p.x, y1: p.y });
          }}
          onMouseUp={commit}
          onMouseLeave={() => {
            if (drag) commit();
          }}
        >
          <img src={thumb.url} alt="" draggable={false} />
          {drag && (
            <span
              className="pdfx-annot-rect"
              style={{
                left: `${Math.min(drag.x0, drag.x1) * 100}%`,
                top: `${Math.min(drag.y0, drag.y1) * 100}%`,
                width: `${Math.abs(drag.x1 - drag.x0) * 100}%`,
                height: `${Math.abs(drag.y1 - drag.y0) * 100}%`,
                borderColor: color,
              }}
            />
          )}
        </div>
      )}
      {items.length > 0 && (
        <div className="pdfx-annot-list">
          {items.map((it, i) => (
            <span key={i} className="pdfx-annot-chip">
              第{it.page}页 · {it.kind}
              <button title="删除" onClick={() => onItems(items.filter((_, j) => j !== i))}>
                ×
              </button>
            </span>
          ))}
          <button className="btn" onClick={() => onItems([])}>
            清空
          </button>
        </div>
      )}
      {items.length === 0 && !loading && (
        <div className="muted">还没有批注。选择类型后在上方页面划选。</div>
      )}
    </div>
  );
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.8, 0.8, 0.8];
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/* ===== 6. 文档属性 ===== */

const META_FIELDS: [keyof PdfMetadata, string][] = [
  ['title', '标题'],
  ['author', '作者'],
  ['subject', '主题'],
  ['keywords', '关键词'],
  ['creator', '创建程序'],
  ['producer', '制作程序'],
];

export function MetadataPanel({
  data,
  onSaved,
}: {
  data: Uint8Array;
  onSaved: (out: Uint8Array, note: string) => void;
}) {
  const [meta, setMeta] = useState<PdfMetadata | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    readMetadata(data)
      .then((m) => {
        if (alive) setMeta(m);
      })
      .catch((e) => {
        if (alive) setError((e as Error)?.message || String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [data]);

  async function save() {
    if (!meta) return;
    setSaving(true);
    setError('');
    try {
      const out = await writeMetadata(data, meta);
      onSaved(out, '属性已写入');
    } catch (e) {
      setError((e as Error)?.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="pdfx-custom muted">正在读取属性…</div>;
  if (error) return <div className="pdfx-custom pdfx-err">{error}</div>;
  if (!meta) return null;

  return (
    <div className="pdfx-custom">
      <div className="pdfx-custom-head">
        <b>文档属性</b>
        <span className="muted">留空表示删除该项</span>
        <span style={{ flex: 1 }} />
        <button className="btn primary" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存修改'}
        </button>
      </div>
      <div className="pdfx-meta">
        {META_FIELDS.map(([key, label]) => (
          <label key={key} className="param-row">
            <span>{label}</span>
            <input
              type="text"
              className="pdfx-input"
              style={{ width: 280 }}
              value={meta[key]}
              onChange={(e) => setMeta({ ...meta, [key]: e.target.value })}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

/* ===== 7. 签名检查 ===== */

export function SignaturePanel({ data }: { data: Uint8Array }) {
  const [report, setReport] = useState<SignatureReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run() {
    setBusy(true);
    setError('');
    try {
      setReport(await inspectSignatures(data));
    } catch (e) {
      setError((e as Error)?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pdfx-custom">
      <div className="pdfx-custom-head">
        <b>数字签名</b>
        <span className="muted">只读取签名域信息，不做证书链校验</span>
        <span style={{ flex: 1 }} />
        <button className="btn primary" disabled={busy} onClick={() => void run()}>
          {busy ? '检查中…' : '开始检查'}
        </button>
      </div>
      {error && <div className="pdfx-err">{error}</div>}
      {report && (
        <div className="pdfx-sig">
          <div className="pdfx-sig-note">
            {report.hasForm ? '文档包含 AcroForm 表单域。' : '未发现 AcroForm 表单域。'}
            {report.note ? ` ${report.note}` : ''}
          </div>
          {report.items.length === 0 ? (
            <div className="muted">没有发现签名域</div>
          ) : (
            <table className="file-table">
              <thead>
                <tr>
                  <th>域名</th>
                  <th>已签名</th>
                  <th>签名者</th>
                  <th>原因</th>
                  <th>日期</th>
                  <th>字节范围</th>
                </tr>
              </thead>
              <tbody>
                {report.items.map((it, i) => (
                  <tr key={i}>
                    <td>{it.field || '—'}</td>
                    <td>{it.signed ? '是' : '否'}</td>
                    <td>{it.signer || '—'}</td>
                    <td>{it.reason || '—'}</td>
                    <td>{it.date || '—'}</td>
                    <td className="muted">{it.byteRange || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
