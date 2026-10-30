import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  DEFAULT_PHOTO_OPTIONS,
  photoOptionsReducer,
  type PhotoOptions,
  type SetPhotoOption,
} from '../lib/idphotoOptions';
import {
  clearPhotoOptions,
  loadPhotoOptions,
  savePhotoOptions,
  toPersisted,
} from '../lib/idphotoOptionsStorage';

/**
 * 设置项状态（步骤 7 的 hooks 封装）+ 落盘（可选项 2）。
 *
 * 为什么 hook 与 reducer 分两个文件：reducer 是纯函数、要在 node 下单测；
 * 放同一个文件会让纯逻辑测试顺带把 React 拽进来（虽能跑，但没必要）。
 * 同理，校验与读写逻辑全在 `lib/idphotoOptionsStorage`（20 条单测），
 * 这里只留「什么时候读、什么时候写」这一点 React 语义 —— 这部分无法在 node 下单测，
 * 属于本功能已知的覆盖边界（见 docs/idphoto-split-plan.md）。
 *
 * 返回的动作全部 `useCallback` 固定引用：它们会被传进子面板，
 * 引用不稳会造成整棵右栏无谓重渲染（63 → 22 个 prop 的意义就在这里）。
 */
export function usePhotoOptions(initial?: PhotoOptions) {
  // 惰性读盘：在首帧渲染前就把「上次的设置」拿到，避免先画默认值再跳变
  const [options, dispatch] = useReducer(
    photoOptionsReducer,
    initial,
    (seed: PhotoOptions | undefined) => seed ?? loadPhotoOptions(),
  );

  /**
   * 「上一次写进存档的内容」指纹（只含落盘字段）。
   * 用它做**值比对**而不是「跳过第 N 次 effect」，原因有三：
   *  - 挂载不写盘：`main.tsx` 开了 StrictMode，dev 下 effect 会跑两遍，
   *    「跳过首次」标志挡不住第二遍，值比对则天然幂等；
   *  - 重复点同一个选项（点已是激活态的色块/档位）不产生无意义写盘；
   *  - 恢复默认后回到默认值 = 与基线相同 → 不写，存档保持为空。
   */
  const lastSaved = useRef<string | null>(null);
  if (lastSaved.current === null) {
    // 首次渲染：把「刚从存档读出来的样子」记为已保存
    lastSaved.current = JSON.stringify(toPersisted(options));
  }

  useEffect(() => {
    const json = JSON.stringify(toPersisted(options));
    if (json === lastSaved.current) return;
    lastSaved.current = json;
    // 立即写而非防抖：localStorage 是同步内存写（约 0.01ms），
    // 而防抖会引入「卸载时最后一次改动丢失」的窗口 —— 宁可多写几次也不要丢设置。
    savePhotoOptions(options);
  }, [options]);

  /** 一次改一个键；键值配对由泛型在编译期校验 */
  const setOption = useCallback<SetPhotoOption>((key, value) => {
    dispatch({ type: 'set', key, value: value as PhotoOptions[keyof PhotoOptions] });
  }, []);

  /** 换主规格时并进导出集合（幂等） */
  const addExportSize = useCallback((id: string) => dispatch({ type: 'add-size', id }), []);

  /** 勾/取消导出规格（恒保留至少一个，规则在 reducer 里） */
  const toggleExportSize = useCallback((id: string) => dispatch({ type: 'toggle-size', id }), []);

  /**
   * 恢复出厂默认：**先清存档、并把指纹对齐到默认值，再重置 state** —— 顺序不能反。
   * 反了的话，重置触发的写盘 effect 会把默认值写成新存档，
   * 于是「恢复默认」只改了显示、存档里仍有一份（下次启动仍是默认，但存档不干净）。
   */
  const resetOptions = useCallback(() => {
    clearPhotoOptions();
    lastSaved.current = JSON.stringify(toPersisted(DEFAULT_PHOTO_OPTIONS));
    dispatch({ type: 'reset' });
  }, []);

  return { options, setOption, addExportSize, toggleExportSize, resetOptions };
}
