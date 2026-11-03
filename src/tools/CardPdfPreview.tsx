import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * PDF 预览（对齐爱印的「PDF 预览」窗口）
 *
 * - 左侧：页缩略图列，点选切换
 * - 中间：当前页画布，支持「适合页面 / 1:1 / 缩放百分比」
 * - 顶栏：保存（走父组件的矢量导出）/ 页码 / 关闭
 *
 * 定位说明：遮罩刻意只覆盖「左栏 + 中栏」，让右侧拼版设置保持可点——
 * 这是原版的行为（预览时还能继续调每页张数、色彩等）。
 */
export interface CardPdfPreviewProps {
  /** 预览用页面位图（低 DPI，仅用于显示；真正导出由父组件重新按 300DPI 生成） */
  pages: HTMLCanvasElement[];
  paperName: string;
  fileName: string;
  /** 父组件正在生成正式文件 */
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
}

const THUMB_W = 104;

export default function CardPdfPreview({
  pages,
  paperName,
  fileName,
  saving,
  onSave,
  onClose,
}: CardPdfPreviewProps) {
  const [cur, setCur] = useState(0);
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [box, setBox] = useState({ w: 0, h: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 页数变少时把当前页拉回范围内
  useEffect(() => {
    setCur((c) => (c >= pages.length ? Math.max(0, pages.length - 1) : c));
  }, [pages.length]);

  // 舞台尺寸：用于计算「适合页面」
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const sync = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const page = pages[cur];

  const thumbUrls = useMemo(
    () =>
      pages.map((p) => {
        const t = document.createElement('canvas');
        t.width = THUMB_W;
        t.height = Math.max(1, Math.round((THUMB_W * p.height) / p.width));
        t.getContext('2d')?.drawImage(p, 0, 0, t.width, t.height);
        return t.toDataURL('image/png');
      }),
    [pages],
  );

  // 把当前页原样画进主画布（CSS 尺寸负责缩放，避免二次重采样发糊）
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !page) return;
    cv.width = page.width;
    cv.height = page.height;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(page, 0, 0);
  }, [page]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const pad = 28;
  const fitScale = page
    ? Math.min(
        (Math.max(box.w, 1) - pad) / page.width,
        (Math.max(box.h, 1) - pad) / page.height,
      )
    : 1;
  const scale = zoom === 'fit' ? Math.max(0.05, fitScale) : zoom / 100;
  const pct = Math.round(scale * 100);

  const stepZoom = (dir: -1 | 1) => {
    const next = Math.min(400, Math.max(20, pct + dir * 10));
    setZoom(next);
  };

  return (
    <div
      className="pv-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="pv-win" role="dialog" aria-label="PDF 预览">
        <header className="pv-bar">
          <div className="pv-title">
            <b>PDF 预览</b>
            <span>
              共 {pages.length} 页 PDF · {paperName} · {fileName}
            </span>
          </div>
          <div className="pv-tools">
            <button className="btn primary" disabled={saving} onClick={onSave}>
              {saving ? '生成中…' : '⤓ 保存'}
            </button>
            <button
              className={'btn' + (zoom === 'fit' ? ' active' : '')}
              onClick={() => setZoom('fit')}
            >
              适合页面
            </button>
            <button className={'btn' + (zoom === 100 ? ' active' : '')} onClick={() => setZoom(100)}>
              1:1
            </button>
            <div className="pv-zoom">
              <button onClick={() => stepZoom(-1)} title="缩小">
                −
              </button>
              <em>{pct}%</em>
              <button onClick={() => stepZoom(1)} title="放大">
                ＋
              </button>
            </div>
            <button className="pv-x" onClick={onClose} title="关闭（Esc）">
              ✕
            </button>
          </div>
        </header>

        <div className="pv-body">
          <aside className="pv-thumbs">
            {thumbUrls.map((src, i) => (
              <button
                key={i}
                className={'pv-thumb' + (i === cur ? ' on' : '')}
                onClick={() => setCur(i)}
                title={`第 ${i + 1} 页`}
              >
                <img src={src} alt={`第 ${i + 1} 页`} />
                <span>{i + 1}</span>
              </button>
            ))}
          </aside>

          <div className="pv-stage" ref={stageRef}>
            {page ? (
              <canvas
                ref={canvasRef}
                className="pv-canvas"
                style={{
                  width: Math.round(page.width * scale),
                  height: Math.round(page.height * scale),
                }}
              />
            ) : (
              <div className="muted">正在生成预览…</div>
            )}
          </div>
        </div>

        <footer className="pv-foot">
          <span>
            第 {pages.length ? cur + 1 : 0} / {pages.length} 页
          </span>
          <span className="muted">预览为显示用低分辨率；点「保存」按 300DPI 正式导出</span>
        </footer>
      </div>
    </div>
  );
}
