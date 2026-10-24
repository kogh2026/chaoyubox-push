import { useEffect, useState } from 'react';

/* ===== 可自定义全局快捷键（纯逻辑 + 持久化） =====
   组合串格式：修饰符固定顺序 ctrl+meta+shift+alt + 主键（小写），如 ctrl+shift+k。
   空串表示该动作已解绑。存储键与事件名沿用 chaoyu 前缀。 */

export type HotkeyAction = 'search' | 'import' | 'print' | 'export' | 'zoomIn' | 'zoomOut' | 'zoomReset';

export interface HotkeyActionDef {
  id: HotkeyAction;
  name: string;
  scope: 'app' | 'tool'; // app=应用级直接执行；tool=派发给当前工具
}

/** 七个动作的默认键位（与设置中心历史展示一致，另补放大/缩小）。
    主键用 e.key 字符风格（'=' 而非 code 风格 'Equal'），与 normalizeCombo 一致。 */
export const DEFAULT_BINDINGS: Record<HotkeyAction, string> = {
  search: 'ctrl+k',
  import: 'ctrl+o',
  print: 'ctrl+p',
  export: 'ctrl+s',
  zoomIn: 'ctrl+=',
  zoomOut: 'ctrl+-',
  zoomReset: 'ctrl+0',
};

export const HOTKEY_ACTIONS: HotkeyActionDef[] = [
  { id: 'search', name: '搜索工具', scope: 'app' },
  { id: 'import', name: '导入文件（当前工具）', scope: 'tool' },
  { id: 'print', name: '打印（当前工具）', scope: 'tool' },
  { id: 'export', name: '导出 / 保存 PDF（当前工具）', scope: 'tool' },
  { id: 'zoomIn', name: '界面放大', scope: 'app' },
  { id: 'zoomOut', name: '界面缩小', scope: 'app' },
  { id: 'zoomReset', name: '界面缩放恢复 100%', scope: 'app' },
];

export const ZOOM_MIN = 80;
export const ZOOM_MAX = 150;
export const ZOOM_STEP = 10;

const KEY = 'chaoyu.hotkeys.v1';
const CHANGED = 'chaoyu-hotkeys-changed';

export interface ComboEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** KeyboardEvent-like → 规范组合串；纯修饰键返回 ''（不能作为绑定） */
export function normalizeCombo(e: ComboEvent): string {
  const key = e.key.toLowerCase();
  if (key === 'control' || key === 'meta' || key === 'shift' || key === 'alt') return '';
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.metaKey) mods.push('meta');
  if (e.shiftKey) mods.push('shift');
  if (e.altKey) mods.push('alt');
  return [...mods, key].join('+');
}

/** 事件是否命中某组合（精确匹配：多按一个修饰符都不算） */
export function matchCombo(e: ComboEvent, combo: string): boolean {
  if (!combo) return false;
  return normalizeCombo(e) === combo;
}

/** 存储的部分覆盖与默认合并；空串=解绑；未知键/脏数据忽略 */
export function resolveBindings(
  stored: Partial<Record<HotkeyAction, string>> | null | undefined,
): Record<HotkeyAction, string> {
  const out: Record<HotkeyAction, string> = { ...DEFAULT_BINDINGS };
  if (!stored) return out;
  (Object.keys(DEFAULT_BINDINGS) as HotkeyAction[]).forEach((a) => {
    const v = stored[a];
    if (typeof v === 'string') out[a] = v.trim();
  });
  return out;
}

/** 找占用同一组合的别的动作；没有返回 null。空组合不查。 */
export function findConflict(
  bindings: Record<HotkeyAction, string>,
  action: HotkeyAction,
  combo: string,
): HotkeyAction | null {
  if (!combo) return null;
  for (const a of Object.keys(bindings) as HotkeyAction[]) {
    if (a !== action && bindings[a] === combo) return a;
  }
  return null;
}

const MOD_LABEL: Record<string, string> = { ctrl: 'Ctrl', meta: 'Meta', shift: 'Shift', alt: 'Alt' };
const KEY_LABEL: Record<string, string> = { '=': '+', '-': '-' };

/** 组合串 → 友好显示（ctrl+shift+k → Ctrl Shift K） */
export function comboLabel(combo: string): string {
  if (!combo) return '未绑定';
  return combo
    .split('+')
    .map((p) => MOD_LABEL[p] ?? KEY_LABEL[p] ?? p.toUpperCase())
    .join(' ');
}

/** 缩放夹到设置页既有区间；非法值回退 100 */
export function clampZoom(v: number): number {
  if (!Number.isFinite(v)) return 100;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v)));
}

/** 快捷键步进缩放，到界即止 */
export function stepZoom(cur: number, dir: 1 | -1): number {
  return clampZoom(cur + dir * ZOOM_STEP);
}

/* ===== 持久化 + 跨组件同步（localStorage + CustomEvent，模式同 appSettings） ===== */

export function loadBindings(): Record<HotkeyAction, string> {
  try {
    const raw = localStorage.getItem(KEY);
    return resolveBindings(raw ? (JSON.parse(raw) as Partial<Record<HotkeyAction, string>>) : null);
  } catch {
    return resolveBindings(null);
  }
}

export function saveBindings(b: Record<HotkeyAction, string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(b));
  } catch {
    /* 隐私模式等写入失败时静默，内存态仍可用 */
  }
  window.dispatchEvent(new CustomEvent(CHANGED));
}

/** 跨组件同步的绑定 hook：任意页面 saveBindings 后其他使用方自动更新 */
export function useHotkeys(): [Record<HotkeyAction, string>, (b: Record<HotkeyAction, string>) => void] {
  const [b, setB] = useState<Record<HotkeyAction, string>>(() => loadBindings());
  useEffect(() => {
    const onChange = () => setB(loadBindings());
    window.addEventListener(CHANGED, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(CHANGED, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);
  const update = (next: Record<HotkeyAction, string>) => {
    setB(next);
    saveBindings(next);
  };
  return [b, update];
}

/** 事件目标是否是输入类元素（打字时不触发快捷键） */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}
