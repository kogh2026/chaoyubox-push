import { useCallback, useEffect, useRef, useState } from 'react';
import {
  rotateQuadCW,
  warpImageData,
  quadToPx,
  type Pt,
  type Quad,
} from '../lib/cardDetect';

interface Props {
  name: string;
  dataUrl: string;
  initialQuad: Quad;
  cardW: number; // 证件类型尺寸 mm，决定输出比例
  cardH: number;
  onCancel: () => void;
  onApply: (r: { dataUrl: string; img: HTMLImageElement }) => void;
}

type HandleKind = 'p0' | 'p1' | 'p2' | 'p3' | 'e0' | 'e1' | 'e2' | 'e3' | 'pan';

const CW = 640; // 编辑画布尺寸
const CH = 440;

function clamp01(v: number, lo = 0.01, hi = 0.99): number {
  return Math.max(lo, Math.min(hi, v));
}

export default function ManualCropModal({
  name,
  dataUrl,
  initialQuad,
  cardW,
  cardH,
  onCancel,
  onApply,
}: Props) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [err, setErr] = useState('');
  const [rot, setRot] = useState(0); // 顺时针 1/4 圈数
  const [quad, setQuad] = useState<Quad>(initialQuad);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Pt>({ x: 0, y: 0 });
  const [tick, setTick] = useState(0); // 旋转源重建后触发重绘

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const rotImgRef = useRef<HTMLCanvasElement | null>(null);
  const srcDataRef = useRef<ImageData | null>(null);
  const tfRef = useRef({ ox: 0, oy: 0, s: 1, iw: 1, ih: 1 });
  const dragRef = useRef<null | {
    kind: HandleKind;
    sx: number;
    sy: number;
    startQuad: Quad;
    startPan: Pt;
  }>(null);

  useEffect(() => {
    const im = new Image();
    im.onload = () => setImg(im);
    im.onerror = () => setErr('图片加载失败');
    im.src = dataUrl;
  }, [dataUrl]);

  // 旋转后的源画布 + 缓存像素（供透视矫正采样）
  useEffect(() => {
    if (!img) return;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const c = document.createElement('canvas');
    if (rot % 2 === 0) {
      c.width = iw;
      c.height = ih;
    } else {
      c.width = ih;
      c.height = iw;
    }
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((rot * Math.PI) / 2);
    ctx.drawImage(img, -iw / 2, -ih / 2);
    rotImgRef.current = c;
    try {
      srcDataRef.current = ctx.getImageData(0, 0, c.width, c.height);
    } catch {
      srcDataRef.current = null;
    }
    setTick((t) => t + 1);
  }, [img, rot]);

  // 主画布绘制
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#eef1f6';
    ctx.fillRect(0, 0, CW, CH);
    const ri = rotImgRef.current;
    if (!img || !ri) return;
    const iw = ri.width;
    const ih = ri.height;
    const s = Math.min(CW / iw, CH / ih) * 0.92 * zoom;
    const ox = (CW - iw * s) / 2 + pan.x;
    const oy = (CH - ih * s) / 2 + pan.y;
    tfRef.current = { ox, oy, s, iw, ih };
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(ri, ox, oy, iw * s, ih * s);

    const P = [
      { x: ox + quad.p0.x * iw * s, y: oy + quad.p0.y * ih * s },
      { x: ox + quad.p1.x * iw * s, y: oy + quad.p1.y * ih * s },
      { x: ox + quad.p2.x * iw * s, y: oy + quad.p2.y * ih * s },
      { x: ox + quad.p3.x * iw * s, y: oy + quad.p3.y * ih * s },
    ];
    const pathQuad = () => {
      ctx.beginPath();
      ctx.moveTo(P[0].x, P[0].y);
      ctx.lineTo(P[1].x, P[1].y);
      ctx.lineTo(P[2].x, P[2].y);
      ctx.lineTo(P[3].x, P[3].y);
      ctx.closePath();
    };
    // 四边形外暗色蒙版
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, CW, CH);
    pathQuad();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.38)';
    ctx.fill('evenodd');
    ctx.restore();
    // 虚线裁切框
    ctx.save();
    ctx.setLineDash([7, 5]);
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2;
    pathQuad();
    ctx.stroke();
    ctx.restore();
    // 边中点粗把手（30%..70% 段）
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      const a = P[i];
      const b = P[(i + 1) % 4];
      ctx.beginPath();
      ctx.moveTo(a.x + (b.x - a.x) * 0.32, a.y + (b.y - a.y) * 0.32);
      ctx.lineTo(a.x + (b.x - a.x) * 0.68, a.y + (b.y - a.y) * 0.68);
      ctx.stroke();
    }
    // 角点圆把手
    for (const p of P) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }, [img, quad, zoom, pan, tick]);

  // 矫正预览（小图实时重采样）
  const ratio = cardH / cardW;
  useEffect(() => {
    const cv = previewRef.current;
    const sd = srcDataRef.current;
    if (!cv || !sd) return;
    const pw = 232;
    const ph = Math.max(60, Math.round(pw * ratio));
    cv.width = pw;
    cv.height = ph;
    const w = warpImageData(sd, quadToPx(quad, sd.width, sd.height), pw, ph);
    cv.getContext('2d')?.drawImage(w, 0, 0);
  }, [quad, ratio, tick]);

  const toNorm = useCallback((mx: number, my: number): Pt => {
    const { ox, oy, s, iw, ih } = tfRef.current;
    return { x: (mx - ox) / (iw * s), y: (my - oy) / (ih * s) };
  }, []);

  function pointerPos(e: React.PointerEvent<HTMLCanvasElement>): Pt {
    const cv = canvasRef.current!;
    const r = cv.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * cv.width) / r.width,
      y: ((e.clientY - r.top) * cv.height) / r.height,
    };
  }

  function distToSeg(p: Pt, a: Pt, b: Pt): number {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy || 1;
    let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
  }

  function onDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!img) return;
    const p = pointerPos(e);
    const { ox, oy, s, iw, ih } = tfRef.current;
    const P = [
      { x: ox + quad.p0.x * iw * s, y: oy + quad.p0.y * ih * s },
      { x: ox + quad.p1.x * iw * s, y: oy + quad.p1.y * ih * s },
      { x: ox + quad.p2.x * iw * s, y: oy + quad.p2.y * ih * s },
      { x: ox + quad.p3.x * iw * s, y: oy + quad.p3.y * ih * s },
    ];
    let kind: HandleKind = 'pan';
    for (let i = 0; i < 4; i++)
      if (Math.hypot(p.x - P[i].x, p.y - P[i].y) < 15) {
        kind = `p${i}` as HandleKind;
        break;
      }
    if (kind === 'pan')
      for (let i = 0; i < 4; i++)
        if (distToSeg(p, P[i], P[(i + 1) % 4]) < 13) {
          kind = `e${i}` as HandleKind;
          break;
        }
    dragRef.current = { kind, sx: p.x, sy: p.y, startQuad: quad, startPan: pan };
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
  }

  function onMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = dragRef.current;
    if (!d || !img) return;
    const p = pointerPos(e);
    if (d.kind === 'pan') {
      setPan({ x: d.startPan.x + (p.x - d.sx), y: d.startPan.y + (p.y - d.sy) });
      return;
    }
    if (d.kind[0] === 'p') {
      const n = toNorm(p.x, p.y);
      setQuad((q) => ({
        ...q,
        [d.kind]: { x: clamp01(n.x), y: clamp01(n.y) },
      }) as Quad);
      return;
    }
    // 边把手：沿边法线平移两端点
    const ei = Number(d.kind[1]);
    const key = `p${ei}` as keyof Quad;
    const keyB = `p${(ei + 1) % 4}` as keyof Quad;
    const A = d.startQuad[key];
    const B = d.startQuad[keyB];
    const { ox, oy, s, iw, ih } = tfRef.current;
    const sa = { x: ox + A.x * iw * s, y: oy + A.y * ih * s };
    const sb = { x: ox + B.x * iw * s, y: oy + B.y * ih * s };
    let nx = -(sb.y - sa.y);
    let ny = sb.x - sa.x;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    // 法线朝向远离四边形中心
    const cx = (sa.x + sb.x) / 2;
    const cy = (sa.y + sb.y) / 2;
    const sq = d.startQuad;
    const mx = ox + ((sq.p0.x + sq.p1.x + sq.p2.x + sq.p3.x) / 4) * iw * s;
    const my = oy + ((sq.p0.y + sq.p1.y + sq.p2.y + sq.p3.y) / 4) * ih * s;
    if ((cx - mx) * nx + (cy - my) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const dx = p.x - d.sx;
    const dy = p.y - d.sy;
    const dd = dx * nx + dy * ny;
    const dnx = (dd * nx) / (s * iw);
    const dny = (dd * ny) / (s * ih);
    setQuad((q) => ({
      ...q,
      [key]: { x: clamp01(A.x + dnx), y: clamp01(A.y + dny) },
      [keyB]: { x: clamp01(B.x + dnx), y: clamp01(B.y + dny) },
    }) as Quad);
  }

  function onUp() {
    dragRef.current = null;
  }

  function onWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    e.preventDefault();
    setZoom((z) => Math.max(0.4, Math.min(3.2, z * (e.deltaY < 0 ? 1.1 : 0.9))));
  }

  function resetQuad() {
    let q = initialQuad;
    for (let i = 0; i < rot; i++) q = rotateQuadCW(q);
    setQuad(q);
    setPan({ x: 0, y: 0 });
    setZoom(1);
  }

  function rotate90() {
    setRot((r) => (r + 1) % 4);
    setQuad((q) => rotateQuadCW(q));
  }

  function apply() {
    const sd = srcDataRef.current;
    if (!sd) return;
    const long = 1100;
    const land = cardW >= cardH;
    const ow = land ? long : Math.round((long * cardW) / cardH);
    const oh = land ? Math.round((long * cardH) / cardW) : long;
    const cv = warpImageData(sd, quadToPx(quad, sd.width, sd.height), ow, oh);
    const url = cv.toDataURL('image/jpeg', 0.92);
    const im = new Image();
    im.onload = () => onApply({ dataUrl: url, img: im });
    im.src = url;
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCancel]);

  return (
    <div className="mc-overlay" role="dialog" aria-label="手动裁切">
      <div className="mc-dialog">
        <div className="mc-head">
          <div className="mc-head-l">
            <h3>手动裁切</h3>
            <p className="mc-sub">
              拖动角点或裁切线调整范围；证件缺角时，可以拖出照片、拖到灰色区域补齐。
            </p>
          </div>
          <div className="mc-head-r">
            <div className="mc-zoom">
              <button title="缩小" onClick={() => setZoom((z) => Math.max(0.4, z * 0.88))}>
                −
              </button>
              <span>{Math.round(zoom * 100)}%</span>
              <button title="放大" onClick={() => setZoom((z) => Math.min(3.2, z * 1.12))}>
                ＋
              </button>
            </div>
            <button className="mc-close" title="关闭" onClick={onCancel}>
              ✕
            </button>
          </div>
        </div>

        <div className="mc-body">
          <div className="mc-left">
            {err ? (
              <div className="mc-err">{err}</div>
            ) : (
              <canvas
                ref={canvasRef}
                width={CW}
                height={CH}
                className="mc-canvas"
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerLeave={onUp}
                onWheel={onWheel}
              />
            )}
          </div>
          <div className="mc-right">
            <div className="mc-file" title={name}>
              {name}
            </div>
            <p className="mc-hint">自动边缘检测置信度不足时可通过手动校正兜底。</p>
            <button className="mc-btn" onClick={resetQuad}>
              ⟲ 重置为检测角点
            </button>
            <button className="mc-btn" onClick={rotate90}>
              ↻ 旋转 90°
            </button>
            <div className="mc-prev-sec">
              <span>矫正预览</span>
              <div className="mc-prev-box">
                <canvas ref={previewRef} className="mc-prev" />
              </div>
            </div>
          </div>
        </div>

        <div className="mc-foot">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" disabled={!img || !!err} onClick={apply}>
            应用校正
          </button>
        </div>
      </div>
    </div>
  );
}
