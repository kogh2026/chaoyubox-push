import { useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import {
  DEFAULT_DPI,
  type CanvasLike,
} from '../lib/cardLayout';
import { bytesOf, outcomeMessage, revealIfWanted, saveBytes } from '../lib/exporter';
import { withJpegDpi } from '../lib/dpiTag';
import type { ComposeResult, PhotoItem } from './idphotoTypes';

/**
 * 中栏：**当前选中照片**的大图预览 + 排版预览。
 *
 * 与改造前的区别：以前这里把所有合成结果铺成网格（一张照片一行卡片，缩略图大小），
 * 现在只画一张 —— 左栏点哪张、这里就放大看哪张，右上角可切「原图」对比，
 * 底部工具条负责上一张/下一张、缩放、取景微调与单张保存。
 * 尺寸标注（左 35mm / 右 413px / 下 295px）与爱印一致：标注跟着图走，随缩放一起放大。
 *
 * 仍然是纯展示 + 两个纯 UI 局部状态（缩放、原图对比）；照片与结果是父组件的。
 */
export interface IdPhotoCenterProps {
  tab: 'photo' | 'sheet';
  setTab: Dispatch<SetStateAction<'photo' | 'sheet'>>;
  dragOver: boolean;
  setDragOver: Dispatch<SetStateAction<boolean>>;
  addFiles: (list: FileList | null) => void;
  busy: boolean;
  progress: string;
  saveMsg: string;
  setSaveMsg: Dispatch<SetStateAction<string>>;
  /** 当前在中栏查看的照片（左栏点击切换）；null = 还没导入 */
  activeItem: PhotoItem | null;
  /** 该照片在列表中的下标（0 起）；无选中为 -1 */
  activeIndex: number;
  /** 照片总数（「3 / 52」的分母与上一张/下一张的可用性） */
  total: number;
  /** 当前照片的合成成品；null = 还在抠图/合成 */
  activeResult: ComposeResult | null;
  /** 当前照片的合成/抠图错误文案 */
  activeError: string;
  /** 上一张 / 下一张（循环） */
  stepPhoto: (dir: -1 | 1) => void;
  /** 人像定位线开关（预览叠加构图辅助线） */
  guideOn: boolean;
  /** 尺寸标注开关（mm / px 标尺） */
  sizeMark: boolean;
  /** 当前规格名（标尺文案里带上，例如「1 寸」），让人一眼确认规格而不是只看到数字 */
  presetName: string;
  /** 当前规格的毫米尺寸，用于两侧标尺文案 */
  presetW: number;
  presetH: number;
  /** 当前规格的像素尺寸 */
  pxW: number;
  pxH: number;
  framingId: string | null;
  setFramingId: Dispatch<SetStateAction<string | null>>;
  /** 排版预览用的 canvas */
  previewRef: RefObject<HTMLCanvasElement>;
  sheets: CanvasLike[];
}

/** 缩放档位：1 = 适应窗口。步进 25%，上限 3× 足够看清发丝边缘 */
const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

export default function IdPhotoCenter({
  tab,
  setTab,
  dragOver,
  setDragOver,
  addFiles,
  busy,
  progress,
  saveMsg,
  setSaveMsg,
  activeItem,
  activeIndex,
  total,
  activeResult,
  activeError,
  stepPhoto,
  guideOn,
  sizeMark,
  presetName,
  presetW,
  presetH,
  pxW,
  pxH,
  framingId,
  setFramingId,
  previewRef,
  sheets,
}: IdPhotoCenterProps) {
  /** 缩放（1 = 适应窗口）。切照片不重置 —— 逐张对比时保持同一倍率更有用 */
  const [zoom, setZoom] = useState(1);
  /** 原图对比：点右上角「原图」切成导入原图，再点回成品（同爱印的常驻切换） */
  const [showOrig, setShowOrig] = useState(false);

  const zoomBy = (d: number) =>
    setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((z + d) * 100) / 100)));

  return (
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
      <div className="idp-canvas-head">
        <div className="idp-tabs">
          <button className={tab === 'photo' ? 'on' : ''} onClick={() => setTab('photo')}>
            证件照
          </button>
          <button className={tab === 'sheet' ? 'on' : ''} onClick={() => setTab('sheet')}>
            排版照
          </button>
        </div>
        {tab === 'photo' && activeResult && (
          <button
            type="button"
            className={'idp-orig' + (showOrig ? ' on' : '')}
            title={showOrig ? '回到成品预览' : '查看导入的原图（对比用）'}
            onClick={() => setShowOrig((v) => !v)}
          >
            {showOrig ? '成品' : '原图'}
          </button>
        )}
      </div>
      {busy && progress && <div className="progress-text">{progress}</div>}
      {saveMsg && <div className="progress-text">{saveMsg}</div>}
      {tab === 'photo' ? (
        activeItem ? (
          activeResult ? (
            <>
              <div className="idp-stage-wrap">
                <div className="idp-stage-preview">
                  <div className="idp-pv-inner" style={{ zoom }}>
                    <figure
                      className="idp-photo-card big"
                      style={{ aspectRatio: `${presetW} / ${presetH}` }}
                    >
                      <img
                        src={showOrig ? activeItem.url : activeResult.url}
                        alt={activeResult.name}
                        decoding="async"
                        draggable={false}
                      />
                      {guideOn && (
                        <div className="idp-guide" aria-hidden>
                          <span className="idp-guide-h" title="头部定位线" />
                          <span className="idp-guide-s" title="肩部定位线" />
                        </div>
                      )}
                      {showOrig && <span className="idp-pv-tag">原图</span>}
                    </figure>
                    {/* 尺寸标注：毫米与像素合成一行放在照片正下方。
                        爱印把 mm / px 分列照片两侧，但两侧被翻页箭头占着，合成一行既不遮挡、
                        也仍然一眼看完「这是 25×35 mm = 295×413 px」 */}
                    {sizeMark && (
                      <span className="idp-ruler idp-ruler-b">
                        {presetName} · {presetW} × {presetH} mm · {pxW} × {pxH} px
                      </span>
                    )}
                  </div>
                </div>
                {/* 翻页做成画布两侧的悬浮箭头（同看图工具的习惯）：既省工具条宽度，
                    也让「逐张切换」出现在用户视线停留的地方 */}
                <button
                  type="button"
                  className="idp-pv-nav prev"
                  disabled={total < 2}
                  aria-label="上一张"
                  title="上一张"
                  onClick={() => stepPhoto(-1)}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="idp-pv-nav next"
                  disabled={total < 2}
                  aria-label="下一张"
                  title="下一张"
                  onClick={() => stepPhoto(1)}
                >
                  ›
                </button>
                <span className="idp-pv-count" title={activeItem.file.name}>
                  {activeIndex + 1} / {total}
                </span>
              </div>
              <div className="idp-pv-bar">
                <button type="button" className="idp-zi" title="缩小" onClick={() => zoomBy(-ZOOM_STEP)}>
                  −
                </button>
                <b className="idp-pv-zoom">{Math.round(zoom * 100)}%</b>
                <button type="button" className="idp-zi" title="放大" onClick={() => zoomBy(ZOOM_STEP)}>
                  +
                </button>
                <button
                  type="button"
                  className="link"
                  disabled={zoom === 1}
                  onClick={() => setZoom(1)}
                  title="回到适应窗口"
                >
                  适应
                </button>
                <span className="idp-pv-sep" />
                {/* 类名保持 .idp-act-view / .idp-act-save：取景编辑器冒烟与导出特征测试按这两处点击 */}
                <button
                  type="button"
                  className={'idp-act-view' + (framingId === activeResult.id ? ' on' : '')}
                  title="取景微调（拖动调整构图）"
                  onClick={() => setFramingId(framingId === activeResult.id ? null : activeResult.id)}
                >
                  ⛶ 取景微调
                </button>
                <button
                  type="button"
                  className="idp-act-save"
                  title="保存这张"
                  onClick={async () => {
                    const data = withJpegDpi(await bytesOf(activeResult.blob), DEFAULT_DPI);
                    const o = await saveBytes(data, `证件照_${activeResult.name}`);
                    setSaveMsg(o.ok ? outcomeMessage(o) : o.code === 'cancelled' ? '' : o.error || '保存失败');
                    void revealIfWanted(o.path);
                  }}
                >
                  ↓ 保存这张
                </button>
              </div>
            </>
          ) : (
            /* 还没出片：先显示原图 + 进度，避免「导入后一片空白」；这张卡片刻意不带
               .idp-photo-card —— 那道类名是「成品已就绪」的信号，被自动化门禁依赖 */
            <div className="idp-stage-preview">
              <div className="idp-pv-inner" style={{ zoom }}>
                <figure className="idp-photo-wait" style={{ aspectRatio: `${presetW} / ${presetH}` }}>
                  <img src={activeItem.url} alt={activeItem.file.name} draggable={false} />
                  <figcaption className={activeError ? 'err' : ''}>
                    {activeError || progress || '正在抠图…'}
                  </figcaption>
                </figure>
              </div>
            </div>
          )
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
  );
}
