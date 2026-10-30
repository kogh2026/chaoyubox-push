import { useEffect, useRef, useState } from 'react';
import { detectFaces } from '../lib/faceDetect';
import {
  GUIDE_FLASH_MS,
  alongUnit,
  centerLabel,
  centerOffsetMm,
  centeredOffsetX,
  eyeMidBoxX,
  eyeRollDeg,
  faceAxis,
  fallbackFaceInfo,
  isCentered,
  isLevel,
  snapOffset,
  snapRotation,
  tiltLabel,
} from '../lib/framingGuides';

// ---------- P3：红色取景框编辑器 ----------
// 固定显示框（红框，即目标证件照比例），内部人物图用 cover 缩放后超出框体，可左右/上下拖动，
// 边界 clamp 保证位移后画面始终覆盖红框（不露白），松手提交目标像素偏移，导出时套用。
//
// 居中参考线（规格复刻自爱印 v0.5.0，参数见 framingGuides.ts）：
//   - 拖动画面时出现「居中线模式」：画布中心垂直线 + 脸中轴线 + 眼位圆点；
//   - 拖动底部圆钮时出现「摆正模式」：过眼位的水平线 + 沿眼向的倾角线；
//   - 距居中/水平 ≤ 6 屏幕像素（旋转 0.6°）自动吸附，按住 Alt 一律不吸附；
//   - 徽标：命中绿底「居中 · 按住 Alt 不吸附」，未命中黑底「X.X mm 偏右/左」；
//   - 快捷键：A = 水平居中，T = 旋转回正（摆正眼睛），触发后参考线短暂显示 1.2s。
interface FaceGuideInfo {
  /** 眼睛中点（原图像素坐标） */
  eyeMid: { x: number; y: number };
  /** 脸宽（原图像素） */
  faceWidth: number;
  /** 眼线自然倾角（度，右低为正） */
  rollDeg: number;
}

function GuideLine(props: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  dashed: boolean;
}) {
  const { x1, y1, x2, y2, color, dashed } = props;
  const dash = dashed ? '6 4' : undefined;
  return (
    <>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(0,0,0,0.35)" strokeDasharray={dash} strokeWidth={3} vectorEffect="non-scaling-stroke" />
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeDasharray={dash} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </>
  );
}

const GUIDE_GREEN = 'rgb(16 185 129)';

export default function FramingEditor({
  matteBlob,
  bgHex,
  pxW,
  pxH,
  initial,
  onChange,
  onReset,
  onClose,
}: {
  matteBlob: Blob;
  bgHex: string;
  pxW: number;
  pxH: number;
  initial?: { dx: number; dy: number; rotation?: number };
  onChange: (dx: number, dy: number, rotation: number) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const boxH = 340;
  const boxW = Math.round((boxH * pxW) / pxH);
  const [dims, setDims] = useState<{ nw: number; nh: number } | null>(null);
  const [srcUrl, setSrcUrl] = useState('');
  const [off, setOff] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(initial?.rotation ?? 0);
  const [face, setFace] = useState<FaceGuideInfo | null>(null);
  const [dragKind, setDragKind] = useState<'move' | 'rotate' | null>(null);
  const [flash, setFlash] = useState<'center' | 'rotate' | null>(null);
  const drag = useRef<{
    kind: 'move' | 'rotate';
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    centeredOffX: number;
    startAngle: number;
    startRotation: number;
  } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const flashTimer = useRef<number | null>(null);

  const showGuide = (mode: 'center' | 'rotate') => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    setFlash(mode);
    flashTimer.current = window.setTimeout(() => setFlash(null), GUIDE_FLASH_MS);
  };
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const url = URL.createObjectURL(matteBlob);
    const img = new Image();
    img.onload = () => {
      if (cancelled) {
        URL.revokeObjectURL(url);
        return;
      }
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      const scale = Math.max(boxW / nw, boxH / nh);
      const drawW = nw * scale;
      const drawH = nh * scale;
      const baseX = (boxW - drawW) / 2;
      const baseY = (boxH - drawH) / 2;
      const initX = baseX + (initial?.dx ?? 0) * (boxW / pxW);
      const initY = baseY + (initial?.dy ?? 0) * (boxH / pxH);
      const cx = Math.min(0, Math.max(boxW - drawW, initX));
      const cy = Math.min(0, Math.max(boxH - drawH, initY));
      setDims({ nw, nh });
      setOff({ x: cx, y: cy });
      setRotation(initial?.rotation ?? 0);
      setSrcUrl(url);
      // 人脸几何（参考线/吸附基准）：检测失败则没有参考线，也不做中线吸附
      detectFaces(img)
        .then((found) => {
          if (cancelled || !found || found.length === 0) return;
          const f = found[0];
          const eyeMid = {
            x: ((f.kp[0].x + f.kp[1].x) / 2) * nw,
            y: ((f.kp[0].y + f.kp[1].y) / 2) * nh,
          };
          setFace({
            eyeMid,
            faceWidth: f.box.w * nw,
            rollDeg: eyeRollDeg(
              { x: f.kp[0].x * nw, y: f.kp[0].y * nh },
              { x: f.kp[1].x * nw, y: f.kp[1].y * nh },
            ),
          });
        })
        .catch(() => undefined);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
    return () => {
      cancelled = true;
      URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matteBlob, boxW, boxH, pxW, pxH]);

  const drawSize = dims
    ? (() => {
        const scale = Math.max(boxW / dims.nw, boxH / dims.nh);
        return { w: dims.nw * scale, h: dims.nh * scale };
      })()
    : { w: boxW, h: boxH };

  // 参考线/吸附基准：有人脸用人脸几何；检测不到（动物/背影等）回退图像中心，
  // 保证参考线在任何照片上都可用（中线吸附退化为几何居中，水平线即图像中线）。
  const guide = face ?? (dims ? fallbackFaceInfo(dims.nw, dims.nh) : null);

  /** 提交当前取景（框内偏移 → 目标像素 + 旋转角） */
  const commit = (o: { x: number; y: number }, rot: number) => {
    const scale = dims ? Math.max(boxW / dims.nw, boxH / dims.nh) : 1;
    const drawW = dims ? dims.nw * scale : boxW;
    const drawH = dims ? dims.nh * scale : boxH;
    const baseX = (boxW - drawW) / 2;
    const baseY = (boxH - drawH) / 2;
    const dxTarget = Math.min(0, Math.max(boxW - drawW, o.x - baseX)) * (pxW / boxW);
    const dyTarget = Math.min(0, Math.max(boxH - drawH, o.y - baseY)) * (pxH / boxH);
    onChange(Math.round(dxTarget), Math.round(dyTarget), Math.round(rot * 10) / 10);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    // 吸附基准：让眼睛中点落到框水平中心所需的 off.x（与爱印 Mh 同义）
    const centered = guide ? centeredOffsetX(guide.eyeMid.x, drawSize.w / (dims?.nw ?? 1), boxW) : null;
    drag.current = {
      kind: 'move',
      sx: e.clientX,
      sy: e.clientY,
      ox: off.x,
      oy: off.y,
      centeredOffX: centered ?? off.x,
      startAngle: 0,
      startRotation: rotation,
    };
    setDragKind('move');
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || drag.current.kind !== 'move' || !dims) return;
    const scale = Math.max(boxW / dims.nw, boxH / dims.nh);
    const drawW = dims.nw * scale;
    const drawH = dims.nh * scale;
    let nx = drag.current.ox + (e.clientX - drag.current.sx);
    const ny = drag.current.oy + (e.clientY - drag.current.sy);
    // 中线吸附：6 屏幕像素内落至居中位；按住 Alt 不吸附（爱印同参数）
    nx = snapOffset(nx, drag.current.centeredOffX, 6, e.altKey);
    nx = Math.min(0, Math.max(boxW - drawW, nx));
    const clampedY = Math.min(0, Math.max(boxH - drawH, ny));
    setOff({ x: nx, y: clampedY });
  };
  const onPointerUp = () => {
    if (!drag.current || drag.current.kind !== 'move') {
      drag.current = null;
      setDragKind(null);
      return;
    }
    drag.current = null;
    setDragKind(null);
    commit(off, rotation);
  };

  // ---- 旋转钮（拖动摆正；Shift 按 15° 吸附，Alt 不吸附水平） ----
  const onRotateDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const rect = boxRef.current?.getBoundingClientRect();
    const px = (rect?.left ?? 0) + off.x + drawSize.w / 2;
    const py = (rect?.top ?? 0) + off.y + drawSize.h / 2;
    drag.current = {
      kind: 'rotate',
      sx: px,
      sy: py,
      ox: off.x,
      oy: off.y,
      centeredOffX: 0,
      startAngle: Math.atan2(e.clientY - py, e.clientX - px),
      startRotation: rotation,
    };
    setDragKind('rotate');
  };
  const onRotateMove = (e: React.PointerEvent) => {
    if (!drag.current || drag.current.kind !== 'rotate') return;
    const delta = ((Math.atan2(e.clientY - drag.current.sy, e.clientX - drag.current.sx) - drag.current.startAngle) * 180) / Math.PI;
    // 水平角 = 让眼线回到水平所需的旋转（= −眼线自然倾角）
    const levelAngle = guide ? -guide.rollDeg : 0;
    const next = snapRotation(drag.current.startRotation + delta, levelAngle, e.altKey, e.shiftKey);
    setRotation(next);
  };
  const onRotateUp = () => {
    if (!drag.current || drag.current.kind !== 'rotate') {
      drag.current = null;
      setDragKind(null);
      return;
    }
    drag.current = null;
    setDragKind(null);
    commit(off, rotation);
  };

  // ---- 快捷键：A=水平居中，T=旋转回正；方向键微调 1px（Shift 10px） ----
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const key = e.key.toLowerCase();
      if (key === 'a' && !e.altKey) {
        // 水平居中：有脸吸附脸中轴，无脸落到几何中心；Alt 不动作（不吸附语义）
        const scale = dims ? drawSize.w / dims.nw : 1;
        const target = guide ? centeredOffsetX(guide.eyeMid.x, scale, boxW) : (boxW - drawSize.w) / 2;
        const next = { x: Math.min(0, Math.max(boxW - drawSize.w, target)), y: off.y };
        setOff(next);
        commit(next, rotation);
        showGuide('center');
        e.preventDefault();
        return;
      }
      if (key === 't' && !e.altKey) {
        // 旋转回正：摆正眼睛（Alt 则回到 0°，不吸附水平）
        const target = e.altKey ? 0 : guide ? -guide.rollDeg : 0;
        setRotation(target);
        commit(off, target);
        showGuide('rotate');
        e.preventDefault();
        return;
      }
      const step = (e.shiftKey ? 10 : 1) * (boxW / pxW); // 模板像素 → 框内像素
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!dir) return;
      e.preventDefault();
      const next = {
        x: Math.min(0, Math.max(boxW - drawSize.w, off.x + dir[0] * step)),
        y: Math.min(0, Math.max(boxH - drawSize.h, off.y + dir[1] * step)),
      };
      setOff(next);
      commit(next, rotation);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guide, dims, off, rotation, drawSize.w, drawSize.h, boxW, pxW]);

  // ---- 参考线几何 ----
  const imgScale = dims ? drawSize.w / dims.nw : 1;
  const guideVisible = (dragKind !== null || flash !== null) && !!guide;
  const mode: 'center' | 'rotate' = dragKind === 'rotate' || flash === 'rotate' ? 'rotate' : 'center';
  let guideSvg: React.ReactNode = null;
  let guidePill: { text: string; ok: boolean } | null = null;
  if (guideVisible && guide) {
    const em = {
      x: eyeMidBoxX(off.x, guide.eyeMid.x, imgScale),
      y: off.y + guide.eyeMid.y * imgScale,
    };
    const dotR = Math.max(2, boxW * 0.012);
    const okDot = (
      <circle cx={em.x} cy={em.y} fill="#fff" r={dotR} stroke="rgba(0,0,0,0.35)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    );
    if (mode === 'center') {
      const mm = centerOffsetMm(em.x, boxW, pxW);
      const ok = isCentered(mm);
      const color = ok ? GUIDE_GREEN : '#fff';
      const axis = faceAxis(guide.eyeMid, guide.faceWidth, imgScale, off.x, off.y, boxH);
      guideSvg = (
        <>
          <GuideLine x1={boxW / 2} y1={0} x2={boxW / 2} y2={boxH} color={color} dashed={!ok} />
          <GuideLine x1={axis.x} y1={axis.topY} x2={axis.x} y2={axis.bottomY} color={color} dashed={false} />
          {okDot}
        </>
      );
      guidePill = { text: ok ? `${centerLabel(mm)} · 按住 Alt 不吸附` : centerLabel(mm), ok };
    } else {
      const tilt = rotation + guide.rollDeg;
      const ok = isLevel(tilt);
      const color = ok ? GUIDE_GREEN : '#fff';
      const half = boxW * 0.36;
      // 当前眼向量 = 原始眼向量（含自然倾角）再旋转 rotation 度
      const vdx = guide.faceWidth * imgScale;
      const evy = vdx * Math.tan((guide.rollDeg * Math.PI) / 180);
      const len = Math.hypot(vdx, evy) || 1;
      const rad = (rotation * Math.PI) / 180;
      const ux = (vdx * Math.cos(rad) - evy * Math.sin(rad)) / len;
      const uy = (vdx * Math.sin(rad) + evy * Math.cos(rad)) / len;
      const seg = alongUnit(em.x, em.y, ux, uy, half);
      guideSvg = (
        <>
          <GuideLine x1={0} y1={em.y} x2={boxW} y2={em.y} color={color} dashed={!ok} />
          <GuideLine x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2} color={color} dashed={false} />
          {okDot}
        </>
      );
      guidePill = { text: ok ? `${tiltLabel(tilt)} · 按住 Alt 不吸附` : tiltLabel(tilt), ok };
    }
  }

  return (
    <div
      className="idp-framing-mask"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="idp-framing" onPointerDown={(e) => e.stopPropagation()}>
        <div className="idp-framing-bar">
          <b>取景微调</b>
          <span className="muted">拖动调整构图 · 拖下方圆钮摆正 · A 居中 / T 回正</span>
          <button className="link" onClick={onClose}>关闭</button>
        </div>
        <div className="idp-framing-wrap">
          <div
            ref={boxRef}
            className="idp-framing-box"
            style={{ width: boxW, height: boxH }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            <div className="idp-framing-bg" style={{ background: bgHex }} />
            {srcUrl && (
              <img
                src={srcUrl}
                alt=""
                style={{
                  position: 'absolute',
                  left: off.x,
                  top: off.y,
                  width: drawSize.w,
                  height: drawSize.h,
                  transform: rotation ? `rotate(${rotation}deg)` : undefined,
                  pointerEvents: 'none',
                  userSelect: 'none',
                }}
              />
            )}
            {guideVisible && (
              <div className="idp-guide-layer">
                <svg
                  aria-hidden="true"
                  className="idp-guide-svg"
                  viewBox={`0 0 ${boxW} ${boxH}`}
                  preserveAspectRatio="xMidYMid meet"
                >
                  {guideSvg}
                </svg>
                {guidePill && (
                  <span
                    className="idp-guide-pill"
                    style={{ background: guidePill.ok ? '#059669' : 'rgba(0,0,0,0.65)' }}
                  >
                    {guidePill.text}
                  </span>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            aria-label="拖动旋转人物"
            title="拖动旋转人物；Shift 按 15° 吸附，按住 Alt 不吸附水平"
            className="idp-rotate-knob"
            onPointerDown={onRotateDown}
            onPointerMove={onRotateMove}
            onPointerUp={onRotateUp}
            onPointerCancel={onRotateUp}
          >
            ↻
          </button>
        </div>
        <div className="idp-framing-foot">
          <button
            className="btn"
            onClick={() => {
              onReset();
              setOff({ x: (boxW - drawSize.w) / 2, y: (boxH - drawSize.h) / 2 });
              setRotation(0);
            }}
          >
            重置居中
          </button>
          <button className="btn primary" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}
