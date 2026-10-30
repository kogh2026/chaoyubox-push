import { useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { ISSUE_LABEL, type PhotoIssue } from '../lib/photoInspect';
import type { PhotoItem } from './idphotoTypes';

/**
 * 左栏：导入工具栏 + 照片缩略图列表 + 演示卡片。
 *
 * 交互模型参考爱印（`_decrypted_assets/ai-id-photo-workspace-CFIuhUxG.js`）：
 * **一列**缩略图，每行 = 勾选框 + 成品缩略图 + 文件名 + 状态；
 * 点行体 = 在中栏大图里查看这张（`setActiveId`），点左侧圆钩 = 勾/取消导出范围。
 * 「看哪张」与「导出哪些」是两件事，因此是两个独立状态，互不牵连。
 *
 * 纯展示：照片、勾选、结果全部由 `IdPhoto` 传入。唯一的本地状态是「正在往列表上拖文件」
 * （纯视觉反馈，既不属于业务状态，也没必要让父组件知道）。
 */
export interface IdPhotoLeftProps {
  items: PhotoItem[];
  /** 已勾选的 id 集合（决定每行圆钩与「已选 N/M」，是**导出范围**，不是当前预览） */
  checked: Set<string>;
  setChecked: Dispatch<SetStateAction<Set<string>>>;
  allChecked: boolean;
  toggleAll: () => void;
  clearAll: () => void;
  /** 「导入照片 / 导入文件夹」两个隐藏 input 的 ref */
  inputRef: RefObject<HTMLInputElement>;
  folderRef: RefObject<HTMLInputElement>;
  addFiles: (list: FileList | null) => void;
  removeItem: (id: string) => void;
  /** 抠图结果缓存：面板只读，用 has() 判断「已处理」角标 */
  matteCache: { readonly current: Map<string, Blob> };
  /** 逐张的合成错误 / 异常检测结果，用于角标与 title 提示 */
  errors: Record<string, string>;
  issues: Record<string, PhotoIssue[]>;
  /** 当前在中栏大图里查看的那张（高亮该行）；null 表示还没选中 */
  activeId: string | null;
  setActiveId: Dispatch<SetStateAction<string | null>>;
  /** id → 成品（换底后 JPEG）的 object URL：有则缩略图显示成品，无则显示原图 */
  resultUrls: Record<string, string>;
  demoThumbs: string[];
  loadDemo: () => void;
}

export default function IdPhotoLeft({
  items,
  checked,
  setChecked,
  allChecked,
  toggleAll,
  clearAll,
  inputRef,
  folderRef,
  addFiles,
  removeItem,
  matteCache,
  errors,
  issues,
  activeId,
  setActiveId,
  resultUrls,
  demoThumbs,
  loadDemo,
}: IdPhotoLeftProps) {
  /** 拖拽高亮：整块列表都是投放区（同中栏画布），拖进来直接追加到当前批次 */
  const [over, setOver] = useState(false);
  return (
    <aside className="idp-left">
      <div className="idp-toolbar">
        {/* 爱印是上下两枚通栏按钮：主操作「导入照片」在上，文件夹入口在下 */}
        <button className="btn primary block" onClick={() => inputRef.current?.click()}>
          导入照片
        </button>
        <button className="btn block" onClick={() => folderRef.current?.click()}>
          导入文件夹
        </button>
        <div className="idp-toolbar-sel">
          <label>
            <input type="checkbox" checked={allChecked} onChange={toggleAll} /> 全选
          </label>
          <span className="muted">已选 {checked.size}/{items.length}</span>
          <button className="link" onClick={clearAll}>清空</button>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*"
        hidden
        onChange={(e) => {
          addFiles(e.target.files);
          e.currentTarget.value = ''; // 同款文件重选时 change 才会再触发
        }}
      />
      <input
        ref={folderRef}
        type="file"
        multiple
        hidden
        // @ts-expect-error 非标准属性
        webkitdirectory=""
        directory=""
        onChange={(e) => {
          addFiles(e.target.files);
          e.currentTarget.value = ''; // 同款文件重选时 change 才会再触发
        }}
      />
      <div
        className={'idp-photos' + (over ? ' over' : '')}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => {
          // 在行与行之间移动也会触发 dragleave；只有真的离开整个列表才收高亮
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        {items.map((it, idx) => {
          const on = checked.has(it.id);
          const isActive = it.id === activeId;
          const err = errors[it.id];
          // 抠图完成即视为「已处理」（缓存是 ref，靠 mattesVer 触发重渲染）
          const done = !err && matteCache.current.has(it.id);
          const thumb = resultUrls[it.id] ?? it.url;
          const issue = err ? undefined : issues[it.id]?.[0];
          const status = err ? '失败' : done ? (resultUrls[it.id] ? '已处理' : '合成中') : '抠图中…';
          return (
            <div
              key={it.id}
              className={'idp-card' + (on ? ' on' : '') + (isActive ? ' act' : '')}
              role="button"
              tabIndex={0}
              aria-label={`查看 ${it.file.name}`}
              title={it.file.name}
              onClick={() => setActiveId(it.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setActiveId(it.id);
                }
              }}
            >
              {/* 圆钩：只改「导出范围」，不切换中栏预览（stopPropagation 挡住整行点击） */}
              <button
                type="button"
                className={'idp-check' + (on ? ' on' : '')}
                role="checkbox"
                aria-checked={on}
                aria-label={`选中 ${it.file.name}`}
                title={on ? '取消勾选（不导出这张）' : '勾选（加入导出）'}
                onClick={(e) => {
                  e.stopPropagation();
                  setChecked((prev) => {
                    const n = new Set(prev);
                    if (n.has(it.id)) n.delete(it.id);
                    else n.add(it.id);
                    return n;
                  });
                }}
              >
                ✓
              </button>
              <div className="idp-card-img">
                {/* 批量 50 张时为 12MP 原图：lazy + async 让视口外的缩略图不参与解码，避免几 GB 解码位图 */}
                <img
                  src={thumb}
                  alt={it.file.name}
                  loading="lazy"
                  decoding="async"
                  data-done={resultUrls[it.id] ? '1' : undefined}
                />
                {err ? (
                  <span className="idp-badge err" title={err}>失败</span>
                ) : done ? (
                  /* 圆点而非文字：状态文字已挪到右侧一行，角标只留「是否出片」的可扫视信号 */
                  <span className="idp-badge done" title="已完成抠图" />
                ) : null}
              </div>
              <div className="idp-card-foot">
                <span className="idp-card-name">
                  照片 {idx + 1}
                  <em title={it.file.name}>{it.file.name}</em>
                </span>
                <span className={'idp-card-status' + (err ? ' err' : done ? ' ok' : '')}>{status}</span>
                {issue && (
                  <span
                    className={'idp-card-issue' + (issue.level === 'error' ? ' err' : '')}
                    title={issue.reason}
                  >
                    {ISSUE_LABEL[issue.code] ?? issue.code}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="idp-card-x"
                title="移除"
                onClick={(e) => {
                  e.stopPropagation();
                  removeItem(it.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        {/* 列表末尾提示：照片少时靠 margin-top:auto 沉到列表底部，
            把剩下来的空白「收口」成一行说明，而不是一片无意义的留白 */}
        {items.length > 0 && (
          <p className="idp-list-end">共 {items.length} 张 · 继续拖入照片或文件夹可追加</p>
        )}
      </div>
      {items.length === 0 && (
        <div className="idp-empty">
          <p>拖拽或点击导入照片</p>
          <p className="muted">支持生活照、证件照，可多张或整个文件夹拖拽进来</p>
        </div>
      )}
      <div className="idp-demo">
        <div className="idp-demo-row">
          {demoThumbs.map((src, v) => (
            <div
              key={v}
              className="idp-demo-card"
              onClick={loadDemo}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  loadDemo();
                }
              }}
            >
              <img src={src} alt={`演示照片 ${v + 1}`} />
              <span>演示照片</span>
            </div>
          ))}
        </div>
        <p className="muted">先试一张，看看生成的证件照</p>
      </div>
    </aside>
  );
}
