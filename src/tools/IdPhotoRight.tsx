import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { BG_OPTIONS, type BgOption } from '../lib/matting';
import { PAPER_SIZES, PHOTO_PRESETS, type LayoutResult } from '../lib/cardLayout';
import { matteEngineUsable, type MatteEngine } from '../lib/mattingPool';
import type { FramingMetrics, FramingSpec, FramingVerification } from '../lib/specFraming';
import type { PhotoOptions, SetPhotoOption } from '../lib/idphotoOptions';
import SpecFramingPanel from '../components/SpecFramingPanel';
import type { PhotoItem } from './idphotoTypes';

/** 编号小标题区块（右栏五步复用），消除重复的 <section><h3><i> 结构 */
function StepSection({ n, title, children }: { n?: number; title: string; children: ReactNode }) {
  return (
    <section className="idp-step">
      <h3>
        {n !== undefined && <i>{n}</i>}
        {title}
      </h3>
      {children}
    </section>
  );
}

/** 批量耗时估算（4 核实测，50 张 12MP：精细 288s / 快速 45s，见 .tmp/bench-batch50） */
function fmtBatch(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  return s < 90 ? `${s} 秒` : `${Math.round(s / 60)} 分钟`;
}

/** 单张抠图耗时（秒）实测值，仅用于给用户一个量级正确的预估 */
const SEC_PER_PHOTO_ISNET = 5.8;
const SEC_PER_PHOTO_MODNET = 0.9;

/** 档位显示名：数值表（WHITEN_LEVELS / BEAUTY_LEVELS）留在 IdPhoto，只有这里要显示中文 */
const WHITEN_NAMES: Record<string, string> = {
  natural: '自然',
  rosy: '红润',
  fair: '白皙',
  ultra: '超白',
};

const BEAUTY_NAMES: Record<string, string> = {
  off: '关',
  natural: '自然',
  standard: '标准',
  refined: '精致',
};

/** 取景偏移（目标像素）+ 旋转角，按照片 id 存 */
export type PlacementValue = { dx: number; dy: number; zoom?: number; rotation?: number };

/**
 * 右栏：规格 / 构图 / 抠图 / 人像优化 / 排版 五步设置。
 *
 * 纯展示，但确实是全应用 props 最宽的一块 —— 它是**设置项面板**，26 个独立
 * 选项各自一个 state，在没有收敛成 `PhotoOptions`（拆分方案步骤 7）之前，
 * 这里就是「宽而浅」的样子。宁可如实传 40 个具名 prop，也不在这轮塞个
 * `options` 大对象 + `setOption(key, v)` 分发器：那是步骤 7 的活，提前做等于
 * 把 reducer 藏进 panel，反而更难回滚。
 */
export interface IdPhotoRightProps {
  /** 25 个设置项的收敛对象（步骤 7：原先散成 25 个 useState + 各自 setter） */
  options: PhotoOptions;
  /** 单键写入；键与值类型强绑定，写错键名/值类型在 tsc 阶段就报错 */
  setOption: SetPhotoOption;
  /** 换主规格时并进导出集合（幂等） */
  addExportSize: (id: string) => void;
  /** 勾/取消一个导出规格（reducer 里保证恒保留至少一个） */
  toggleExportSize: (id: string) => void;
  /** 当前设置是否全为出厂默认（决定「恢复默认」按钮是否可点） */
  isDefaultOptions: boolean;
  /** 恢复出厂默认：同时清掉已落盘的设置 */
  resetOptions: () => void;

  // ---- 以下为运行时状态 / 派生值 / 动作，不属于设置项 ----
  /** 当前规格的像素尺寸，只用于展示「295 × 413 px · 300DPI」 */
  pxW: number;
  pxH: number;
  /** 已勾选且有成品的张数（导出份数估算；合成范围比它宽，不能用结果总数） */
  exportCount: number;
  frameMode: 'auto' | 'default';
  setFrameMode: Dispatch<SetStateAction<'auto' | 'default'>>;
  setPlacements: Dispatch<SetStateAction<Record<string, PlacementValue>>>;
  setFramingId: Dispatch<SetStateAction<string | null>>;
  applyAutoFraming: () => Promise<void>;
  framingSpec: FramingSpec;
  activeFraming: {
    metrics?: FramingMetrics;
    verification?: FramingVerification;
    segmented?: boolean;
    fillApplied?: boolean;
  };
  onEngineChange: (next: MatteEngine) => void;
  items: PhotoItem[];
  /** 当前底色的完整选项（名称/色值/渐变），供「当前」一行展示 */
  bg: BgOption;
  checked: Set<string>;
  advMsg: string;
  manualOpen: boolean;
  setManualOpen: Dispatch<SetStateAction<boolean>>;
  layout: LayoutResult;
}

export default function IdPhotoRight({
  options,
  setOption,
  addExportSize,
  toggleExportSize,
  isDefaultOptions,
  resetOptions,
  pxW,
  pxH,
  exportCount,
  frameMode,
  setFrameMode,
  setPlacements,
  setFramingId,
  applyAutoFraming,
  framingSpec,
  activeFraming,
  onEngineChange,
  items,
  bg,
  checked,
  advMsg,
  manualOpen,
  setManualOpen,
  layout,
}: IdPhotoRightProps) {
  // 读侧解构：面板正文因此与收敛前逐字一致，diff 只落在 setter 调用点
  const {
    presetId,
    exportSizeIds,
    specMode,
    fillScale,
    batchAutoFrame,
    engine,
    bgId,
    customHex,
    edgeThreshold,
    defringeOn,
    monoOn,
    postureOn,
    beautyLevel,
    advOn,
    advSmooth,
    advShine,
    advEye,
    whitenOn,
    whitenLevel,
    brightness,
    paperId,
    sheetMode,
    gapMm,
  } = options;

  /** 「恢复默认」两段式确认：误点一次不至于把一整套参数清空，4 秒不确认自动收回 */
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    if (!confirmReset) return;
    const t = setTimeout(() => setConfirmReset(false), 4000);
    return () => clearTimeout(t);
  }, [confirmReset]);

  return (
    <aside className="idp-right">
      {/* 设置项会跨会话保留（可选项 2）。「恢复默认」是这个能力的出口：
          没有它，记住设置就等于把人锁在一次误操作里。 */}
      <div className="idp-right-h">
        <span className="muted">设置会自动保留</span>
        {confirmReset ? (
          <button
            className="btn danger"
            onClick={() => {
              resetOptions();
              setConfirmReset(false);
            }}
          >
            确认恢复？
          </button>
        ) : (
          <button
            className="btn"
            disabled={isDefaultOptions}
            title={isDefaultOptions ? '当前已是出厂默认' : '把所有设置恢复为出厂默认'}
            onClick={() => setConfirmReset(true)}
          >
            恢复默认
          </button>
        )}
      </div>
      <StepSection n={1} title="照片规格">
        <select
          value={presetId}
          onChange={(e) => {
            const id = e.target.value;
            setOption('presetId', id);
            // 换主规格时把它并进导出集合，避免「勾了 A 却导出 B」
            addExportSize(id);
          }}
        >
          {PHOTO_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <p className="muted">{pxW} × {pxH} px · 300DPI</p>
        <div className="idp-sizes">
          <div className="idp-sizes-h">
            <span>同时导出尺寸</span>
            <span className="muted">每尺寸按自身规格重新构图</span>
          </div>
          <div className="idp-sizes-list">
            {PHOTO_PRESETS.map((p) => {
              const on = exportSizeIds.includes(p.id);
              return (
                <label key={p.id} className={'idp-size' + (on ? ' on' : '')}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggleExportSize(p.id)}
                  />
                  {p.name}
                </label>
              );
            })}
          </div>
          <p className="muted">
            {exportSizeIds.length > 1
              ? `将导出 ${exportSizeIds.length} 个规格 × ${exportCount} 张 = ${exportSizeIds.length * exportCount} 份`
              : '仅导出当前规格'}
          </p>
        </div>
      </StepSection>

      <StepSection n={2} title="人像构图">
        <div className="seg">
          {(
            [
              { id: 'auto', label: '自动构图' },
              { id: 'default', label: '默认构图' },
            ] as const
          ).map((it) => (
            <button
              key={it.id}
              className={'seg-btn' + ((frameMode === 'auto' && it.id === 'auto') || (frameMode === 'default' && it.id === 'default') ? ' active' : '')}
              title={it.id === 'auto' ? '按人脸自动构图：头高约占 60%、发顶距上边 9%，可再拖 ⛶ 微调' : '取消取景偏移，回到整图居中'}
              onClick={() => {
                if (it.id === 'default') {
                  // 全部取消取景偏移，回到居中
                  setPlacements({});
                  setFrameMode('default');
                  setFramingId(null);
                } else {
                  void applyAutoFraming();
                }
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
        <p className="muted">每张右上角 ⛶ 可拖动微调取景。</p>
      </StepSection>

      <StepSection title="规格构图核查">
        <SpecFramingPanel
          spec={framingSpec}
          mode={specMode}
          onModeChange={(m) => setOption('specMode', m)}
          fillScale={fillScale}
          onFillScaleChange={(n) => setOption('fillScale', n)}
          metrics={activeFraming.metrics}
          verification={activeFraming.verification}
          segmented={activeFraming.segmented}
          fillApplied={activeFraming.fillApplied}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 12, color: '#475569' }}>
          <input
            type="checkbox"
            checked={batchAutoFrame}
            onChange={(e) => setOption('batchAutoFrame', e.target.checked)}
          />
          批量默认启用自动构图
        </label>
      </StepSection>

      <StepSection n={3} title="背景与抠图">
        <div className="idp-row">
          <span>抠图质量</span>
          <div className="seg">
            {(
              [
                { id: 'isnet', label: '精细' },
                { id: 'modnet', label: '快速' },
              ] as const
            ).filter((it) => matteEngineUsable(it.id)).map((it) => (
              <button
                key={it.id}
                className={'seg-btn' + (engine === it.id ? ' active' : '')}
                onClick={() => onEngineChange(it.id)}
              >
                {it.label}
              </button>
            ))}
          </div>
        </div>
        <p className="muted">精细发丝更完整，快速更适合大批量处理。</p>
        {engine === 'isnet' && items.length >= 10 && (
          <button type="button" className="idp-tip" onClick={() => onEngineChange('modnet')}>
            已导入 {items.length} 张：「精细」约需 {fmtBatch(items.length * SEC_PER_PHOTO_ISNET)}，
            点这里切「快速」约 {fmtBatch(items.length * SEC_PER_PHOTO_MODNET)}（4 核实测，快约 6 倍）
          </button>
        )}
        <div className="idp-swatches">
          {BG_OPTIONS.map((b) => (
            <button
              key={b.id}
              className={'idp-swatch' + (bgId === b.id ? ' on' : '')}
              title={b.name}
              onClick={() => setOption('bgId', b.id)}
            >
              <span
                style={
                  b.gradient
                    ? { background: `linear-gradient(135deg,${b.gradient[0]},${b.gradient[1]})` }
                    : { background: b.id === 'custom' ? customHex : b.hex }
                }
              />
            </button>
          ))}
        </div>
        {bgId === 'custom' && (
          <label className="idp-row">
            自定义 <input type="color" value={customHex} onChange={(e) => setOption('customHex', e.target.value)} />
            <code className="muted">{customHex.toUpperCase()}</code>
          </label>
        )}
        <label className="idp-row">
          当前 <b>{(bg.id === 'custom' ? '自定义' : bg.name)}</b> <code className="muted">{(bg.id === 'custom' ? customHex : bg.hex).toUpperCase()}</code>
        </label>
        <label className="idp-slider">
          <span>发丝边缘</span>
          <input
            type="range"
            min={0}
            max={50}
            value={edgeThreshold}
            onChange={(e) => setOption('edgeThreshold', Number(e.target.value))}
          />
          <b>{edgeThreshold}</b>
        </label>
        <p className="muted">阈值越大边缘越干净；碎发多可调低。</p>
        <div className="idp-row">
          <div className="seg">
            {(
              [
                { id: false, label: '保留发丝' },
                { id: true, label: '去除边缘' },
              ] as const
            ).map((it) => (
              <button
                key={String(it.id)}
                className={'seg-btn' + (defringeOn === it.id ? ' active' : '')}
                onClick={() => setOption('defringeOn', it.id)}
              >
                {it.label}
              </button>
            ))}
          </div>
        </div>
        <label className="idp-row">
          <input type="checkbox" checked={monoOn} onChange={(e) => setOption('monoOn', e.target.checked)} /> 黑白照片
        </label>
        <label className="idp-row">
          <input type="checkbox" checked={postureOn} onChange={(e) => setOption('postureOn', e.target.checked)} /> 体态纠正
        </label>
        <p className="muted">体态纠正需云端 AI 模型，本地版暂不支持（入口已保留）。</p>
        <p className="muted">去除晕边：把彩色底外沿的发丝色晕中和掉，边缘更干净。</p>
      </StepSection>

      <StepSection n={4} title="人像优化">
        <p className="muted">作用于已勾选的 {checked.size} 张照片</p>
        <label className="idp-row" title="引导滤波匀肤 + 油光抑制 + 黑眼圈三档，脸宽自适应">
          <span>专业匀肤</span>
          <input
            type="checkbox"
            checked={advOn}
            onChange={(e) => setOption('advOn', e.target.checked)}
          />
        </label>
        {advOn && (
          <>
            <label className="idp-slider">
              <span>匀肤</span>
              <input
                type="range"
                min={0}
                max={100}
                value={advSmooth}
                onChange={(e) => setOption('advSmooth', Number(e.target.value))}
              />
              <b>{advSmooth}</b>
            </label>
            <label className="idp-slider">
              <span>去油光</span>
              <input
                type="range"
                min={0}
                max={100}
                value={advShine}
                onChange={(e) => setOption('advShine', Number(e.target.value))}
              />
              <b>{advShine}</b>
            </label>
            <label className="idp-slider">
              <span>去黑眼圈</span>
              <input
                type="range"
                min={0}
                max={100}
                value={advEye}
                onChange={(e) => setOption('advEye', Number(e.target.value))}
              />
              <b>{advEye}</b>
            </label>
            <p className="muted">
              引导滤波按脸宽取半径，眉眼鼻唇自动避开；油光只削高于邻近皮肤的部分，下巴/额头顶光不发灰。
            </p>
            {advMsg && <p className="muted">{advMsg}</p>}
          </>
        )}
        <div className="idp-row">
          <span
            className="idp-tip"
            title="一档同时设置自动调光、磨皮、去油光和美白；拖动任一滑杆即变为自定义。默认「自然」档（可选默认档），可切到「关」关闭；调好的组合可存为我的美颜，下次一键套用。"
          >
            美颜
          </span>
          <div className="seg">
            {(['off', 'natural', 'standard', 'refined'] as const).map((id) => (
              <button
                key={id}
                className={'seg-btn' + (beautyLevel === id ? ' active' : '')}
                // 专业匀肤接管平滑时经典美颜被强制 0（见 retouch.beauty 的装配），
                // 按钮留着可点却毫无效果 = 骗人；这里直接禁用并说明原因
                disabled={advOn}
                title={advOn ? '专业匀肤开启时接管磨皮，经典美颜不可用' : undefined}
                onClick={() => setOption('beautyLevel', id)}
              >
                {BEAUTY_NAMES[id]}
              </button>
            ))}
          </div>
        </div>
        <p className="muted">保真美颜：只抹毛孔/瑕疵，眉眼轮廓不动，脸型不变。</p>
        <p className="muted">
          {advOn
            ? '专业匀肤已接管磨皮，经典美颜暂不可用（关掉上面的开关即可恢复）'
            : beautyLevel === 'off'
              ? '未美颜，可手动调整亮度'
              : '美颜（自然档）已开启，仍可再微调亮度'}
        </p>
        <label className="idp-slider">
          <span>亮度</span>
          <input
            type="range"
            min={-50}
            max={50}
            value={brightness}
            onChange={(e) => setOption('brightness', Number(e.target.value))}
          />
          <b>{brightness}</b>
        </label>
        <div className="idp-row">
          <button type="button" className="link" onClick={() => setManualOpen((v) => !v)}>
            手动微调 {manualOpen ? '∨' : '>'}
          </button>
        </div>
        {manualOpen && (
          <>
            <label className="idp-row">
              <span>美白</span>
              <input type="checkbox" checked={whitenOn} onChange={(e) => setOption('whitenOn', e.target.checked)} />
            </label>
            {whitenOn && (
              <div className="seg">
                {(['natural', 'rosy', 'fair', 'ultra'] as const).map((id) => (
                  <button
                    key={id}
                    className={'seg-btn' + (whitenLevel === id ? ' active' : '')}
                    onClick={() => setOption('whitenLevel', id)}
                  >
                    {WHITEN_NAMES[id]}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </StepSection>

      <StepSection n={5} title="多张排版">
        <label className="idp-row">
          相纸尺寸
          <select value={paperId} onChange={(e) => setOption('paperId', e.target.value)}>
            {PAPER_SIZES.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="idp-row">
          排版方式
          <select
            value={sheetMode}
            onChange={(e) => setOption('sheetMode', e.target.value as 'multi' | 'single')}
          >
            <option value="multi">一人一版</option>
            <option value="single">自动铺满</option>
          </select>
        </label>
        <label className="idp-slider">
          <span>照片间隔</span>
          <input
            type="range"
            min={0}
            max={10}
            value={gapMm}
            onChange={(e) => setOption('gapMm', Number(e.target.value))}
          />
          <b>{gapMm} mm</b>
        </label>
        <p className="muted">每版 {layout.cols}×{layout.rows} = {layout.perSheet} 张</p>
      </StepSection>
    </aside>
  );
}
