// 证件照「按规格自动构图 + 放大填满 + 逐项核查」React 面板（复刻爱印右侧人像构图区）。
// 纯展示 + 受控：所有几何与判定来自 src/lib/specFraming（已在 Node 回归）。
// 内联样式，避免依赖全局 CSS，保证在浅色主题下可独立渲染。

import { type CSSProperties } from 'react';
import {
  formatRatioReadout,
  BOTTOM_FILL_HARD_MAX,
  type FramingSpec,
  type FramingMode,
  type FramingMetrics,
  type FramingVerification,
} from '../lib/specFraming';

export interface SpecFramingPanelProps {
  /** 当前尺寸规格（含 topRatio/headRatio/safeRatio 与 mm/px） */
  spec: FramingSpec;
  /** 构图模式 */
  mode: FramingMode;
  onModeChange: (m: FramingMode) => void;
  /** 自定义构图的放大填满系数（1.0..1.35） */
  fillScale: number;
  onFillScaleChange: (v: number) => void;
  /** 当前照片实测指标（可选，未检测人脸时为 undefined） */
  metrics?: FramingMetrics;
  /** 逐项核查结果（可选） */
  verification?: FramingVerification;
  /** 下半身分割是否命中（true=实测人物底部；false/undefined=回退整图底部近似） */
  segmented?: boolean;
  /** 本次构图是否真的触发了放大填满 */
  fillApplied?: boolean;
}

const MODE_OPTIONS: { id: FramingMode; label: string; hint: string }[] = [
  { id: 'default', label: '默认构图', hint: '按规格摆放头部；人物下方不足时自动放大最多 20% 填满' },
  { id: 'custom', label: '自定义构图', hint: '按规格摆放头部，放大填满由下方滑杆控制' },
  { id: 'spec', label: '按规格要求', hint: '严格落到规格比例，不做放大填满' },
  { id: 'keep', label: '保持原图', hint: '不自动构图，整图居中' },
];

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
  margin: '6px 0',
  fontSize: 13,
};
const labelStyle: CSSProperties = { color: '#475569', fontWeight: 600 };
const valStyle: CSSProperties = { fontVariantNumeric: 'tabular-nums', color: '#0f172a' };

export function SpecFramingPanel(props: SpecFramingPanelProps) {
  const { spec, mode, onModeChange, fillScale, onFillScaleChange, metrics, verification, segmented, fillApplied } = props;
  const isCustom = mode === 'custom';

  const headTarget = formatRatioReadout(spec.headRatio, spec.mmH);
  const topTarget = formatRatioReadout(spec.topRatio, spec.mmH);
  const headActual = metrics ? formatRatioReadout(metrics.headRatio, spec.mmH) : '—';
  const topActual = metrics ? formatRatioReadout(metrics.topRatio, spec.mmH) : '—';

  const deviationTag = (dev: 'match' | 'high' | 'low' | undefined, hasData: boolean) => {
    // 没有实测数据时不得谎称「符合」——否则未导入照片也会显示全部通过
    if (!hasData || dev === undefined) return { text: '—', color: '#94a3b8' };
    if (dev === 'match') return { text: '符合', color: '#16a34a' };
    if (dev === 'high') return { text: '偏大', color: '#dc2626' };
    return { text: '偏小', color: '#dc2626' };
  };
  const hasMetrics = Boolean(metrics && verification);
  const headTag = deviationTag(verification?.headRatioDeviation, hasMetrics);
  const topTag = deviationTag(verification?.topRatioDeviation, hasMetrics);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* 人像构图模式 */}
      <div>
        <div style={labelStyle}>人像构图</div>
        <select
          value={mode}
          onChange={(e) => onModeChange(e.target.value as FramingMode)}
          style={{
            width: '100%',
            marginTop: 4,
            padding: '6px 8px',
            borderRadius: 6,
            border: '1px solid #cbd5e1',
            background: '#fff',
            fontSize: 13,
          }}
        >
          {MODE_OPTIONS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <p style={{ margin: '4px 0 0', fontSize: 11, lineHeight: 1.5, color: '#64748b' }}>
          {MODE_OPTIONS.find((m) => m.id === mode)?.hint}
        </p>
      </div>

      {/* 放大填满（仅自定义构图可用） */}
      <div style={{ opacity: isCustom ? 1 : 0.45, pointerEvents: isCustom ? 'auto' : 'none' }}>
        <div style={rowStyle}>
          <span style={labelStyle}>放大填满</span>
          <span style={valStyle}>{fillScale.toFixed(2)}×</span>
        </div>
        <input
          type="range"
          min={1}
          max={BOTTOM_FILL_HARD_MAX}
          step={0.01}
          value={fillScale}
          disabled={!isCustom}
          onChange={(e) => onFillScaleChange(Number(e.target.value))}
          style={{ width: '100%' }}
        />
        <p style={{ margin: '2px 0 0', fontSize: 11, color: '#64748b' }}>
          上限 {BOTTOM_FILL_HARD_MAX.toFixed(2)}×；默认构图自动最多放大 20%（1.20×）。
        </p>
      </div>

      {/* 读数：头部占比 / 头顶留白（目标 vs 实测，含 mm） */}
      <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 8 }}>
        <div style={rowStyle}>
          <span style={labelStyle}>头部占比</span>
          <span style={valStyle}>
            {headActual}
            <span style={{ color: '#94a3b8', marginLeft: 6 }}>目标 {headTarget}</span>
          </span>
        </div>
        <div style={{ textAlign: 'right', fontSize: 11, marginTop: -4 }}>
          <span style={{ color: headTag.color, fontWeight: 600 }}>{headTag.text}</span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>头顶留白</span>
          <span style={valStyle}>
            {topActual}
            <span style={{ color: '#94a3b8', marginLeft: 6 }}>目标 {topTarget}</span>
          </span>
        </div>
        <div style={{ textAlign: 'right', fontSize: 11, marginTop: -4 }}>
          <span style={{ color: topTag.color, fontWeight: 600 }}>{topTag.text}</span>
        </div>
      </div>

      {/* 下方不足判定依据：真实下半身分割 vs 整图近似 */}
      <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 8 }}>
        <div style={rowStyle}>
          <span style={labelStyle}>下方判定</span>
          <span style={{ ...valStyle, fontSize: 12, color: !hasMetrics ? '#94a3b8' : segmented ? '#0f172a' : '#b45309' }}>
            {!hasMetrics ? '—' : segmented ? '下半身实测' : '整图近似'}
          </span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>放大填满</span>
          <span style={{ ...valStyle, fontSize: 12, color: !hasMetrics ? '#94a3b8' : fillApplied ? '#0f172a' : '#64748b' }}>
            {!hasMetrics ? '—' : fillApplied ? '已触发' : '未触发（下方已足够）'}
          </span>
        </div>
        <p style={{ margin: '2px 0 0', fontSize: 11, lineHeight: 1.5, color: '#64748b' }}>
          {!hasMetrics
            ? '导入照片后按当前规格实时测算。'
            : segmented
              ? '用 MediaPipe selfie-multiclass 分割出人物真实底部，只在人物下方确有空白时才放大。'
              : '未取到人物轮廓，暂按整图底部估算；命中人物时会更少触发放大。'}
        </p>
      </div>

      {/* 逐项核查 */}
      <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 8 }}>
        <div style={labelStyle}>逐项核查</div>
        {!verification ? (
          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#94a3b8' }}>未检测到人脸，暂无实测数据。</p>
        ) : verification.warnings.length === 0 ? (
          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#16a34a', fontWeight: 600 }}>
            ✓ 符合规格（头高 / 留白均在容差内）
          </p>
        ) : (
          <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 12, color: '#dc2626' }}>
            {verification.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default SpecFramingPanel;
