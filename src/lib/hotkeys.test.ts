import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BINDINGS,
  HOTKEY_ACTIONS,
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  comboLabel,
  findConflict,
  matchCombo,
  normalizeCombo,
  resolveBindings,
  stepZoom,
  type HotkeyAction,
} from './hotkeys';

/* ===== 缝点：hotkeys 纯逻辑 =====
   组合串格式：修饰符固定顺序 ctrl+meta+shift+alt + 主键（小写），如 ctrl+shift+k。
   预期值按该格式手工演算。 */

function ev(key: string, mods: Partial<{ ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }> = {}) {
  return {
    key,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
  };
}

describe('DEFAULT_BINDINGS', () => {
  it('七个动作各有一个默认组合', () => {
    expect(Object.keys(DEFAULT_BINDINGS).sort()).toEqual([
      'export',
      'import',
      'print',
      'search',
      'zoomIn',
      'zoomOut',
      'zoomReset',
    ]);
  });

  it('默认键位与设置页历史展示一致', () => {
    expect(DEFAULT_BINDINGS.search).toBe('ctrl+k');
    expect(DEFAULT_BINDINGS.import).toBe('ctrl+o');
    expect(DEFAULT_BINDINGS.print).toBe('ctrl+p');
    expect(DEFAULT_BINDINGS.export).toBe('ctrl+s');
    expect(DEFAULT_BINDINGS.zoomReset).toBe('ctrl+0');
  });
});

describe('HOTKEY_ACTIONS', () => {
  it('每个动作有中文名与作用域', () => {
    for (const a of HOTKEY_ACTIONS) {
      expect(a.name.length).toBeGreaterThan(0);
      expect(['app', 'tool']).toContain(a.scope);
    }
  });
});

describe('normalizeCombo', () => {
  it('单修饰符 + 字母', () => {
    expect(normalizeCombo(ev('k', { ctrl: true }))).toBe('ctrl+k');
  });

  it('主键大小写无关（Shift+K 按出来是大写 K）', () => {
    expect(normalizeCombo(ev('K', { ctrl: true, shift: true }))).toBe('ctrl+shift+k');
  });

  it('修饰符固定顺序 ctrl+meta+shift+alt', () => {
    expect(normalizeCombo(ev('a', { alt: true, shift: true, meta: true, ctrl: true }))).toBe('ctrl+meta+shift+alt+a');
  });

  it('无修饰剂的单键', () => {
    expect(normalizeCombo(ev('f'))).toBe('f');
  });

  it('数字与特殊键（e.key 字符风格）', () => {
    expect(normalizeCombo(ev('0', { ctrl: true }))).toBe('ctrl+0');
    expect(normalizeCombo(ev('=', { ctrl: true }))).toBe('ctrl+=');
    expect(normalizeCombo(ev('-', { ctrl: true }))).toBe('ctrl+-');
  });

  it('纯修饰键返回空串（不能当绑定）', () => {
    expect(normalizeCombo(ev('Control', { ctrl: true }))).toBe('');
    expect(normalizeCombo(ev('Shift', { shift: true }))).toBe('');
    expect(normalizeCombo(ev('Alt', { alt: true }))).toBe('');
    expect(normalizeCombo(ev('Meta', { meta: true }))).toBe('');
  });
});

describe('matchCombo', () => {
  it('完全一致才命中', () => {
    expect(matchCombo(ev('k', { ctrl: true }), 'ctrl+k')).toBe(true);
  });

  it('多按修饰符不命中', () => {
    expect(matchCombo(ev('k', { ctrl: true, shift: true }), 'ctrl+k')).toBe(false);
    expect(matchCombo(ev('k', { ctrl: true, alt: true }), 'ctrl+k')).toBe(false);
  });

  it('少按修饰符不命中', () => {
    expect(matchCombo(ev('k'), 'ctrl+k')).toBe(false);
  });

  it('空组合（未绑定）永不命中', () => {
    expect(matchCombo(ev('k', { ctrl: true }), '')).toBe(false);
  });
});

describe('resolveBindings', () => {
  it('无存储时返回默认', () => {
    expect(resolveBindings(null)).toEqual(DEFAULT_BINDINGS);
  });

  it('空对象存储返回默认', () => {
    expect(resolveBindings({})).toEqual(DEFAULT_BINDINGS);
  });

  it('部分覆盖：只改 search，其余保持默认', () => {
    const b = resolveBindings({ search: 'ctrl+j' });
    expect(b.search).toBe('ctrl+j');
    expect(b.print).toBe('ctrl+p');
  });

  it('空串 = 解绑该动作', () => {
    expect(resolveBindings({ print: '' }).print).toBe('');
  });

  it('未知动作键被忽略', () => {
    const b = resolveBindings({ bogus: 'ctrl+x' } as Record<string, string>);
    expect(Object.keys(b).sort()).toEqual(Object.keys(DEFAULT_BINDINGS).sort());
  });

  it('非字符串值被忽略（防脏数据）', () => {
    const b = resolveBindings({ search: 42 } as unknown as Record<string, string>);
    expect(b.search).toBe('ctrl+k');
  });
});

describe('findConflict', () => {
  const b = resolveBindings(null);

  it('占回自己的组合不冲突', () => {
    expect(findConflict(b, 'search', 'ctrl+k')).toBeNull();
  });

  it('组合已被别的动作占用 → 指出冲突方', () => {
    expect(findConflict(b, 'search', 'ctrl+p')).toBe('print');
  });

  it('未占用组合无冲突', () => {
    expect(findConflict(b, 'search', 'ctrl+j')).toBeNull();
  });

  it('空组合不查冲突', () => {
    expect(findConflict(b, 'search', '')).toBeNull();
  });

  it('多个动作被解绑后组合可被安全占用', () => {
    const b2 = resolveBindings({ print: '', export: '' });
    expect(findConflict(b2, 'search', 'ctrl+p')).toBeNull();
  });
});

describe('comboLabel', () => {
  it('修饰符首字母大写、主键大写', () => {
    expect(comboLabel('ctrl+k')).toBe('Ctrl K');
    expect(comboLabel('ctrl+shift+p')).toBe('Ctrl Shift P');
  });

  it('数字与等号减号可读', () => {
    expect(comboLabel('ctrl+0')).toBe('Ctrl 0');
    expect(comboLabel('ctrl+=')).toBe('Ctrl +');
    expect(comboLabel('ctrl+-')).toBe('Ctrl -');
  });

  it('未绑定显示中文', () => {
    expect(comboLabel('')).toBe('未绑定');
  });
});

describe('clampZoom / stepZoom', () => {
  it('区间内原样返回', () => {
    expect(clampZoom(100)).toBe(100);
    expect(clampZoom(80)).toBe(ZOOM_MIN);
    expect(clampZoom(150)).toBe(ZOOM_MAX);
  });

  it('超出区间被夹回', () => {
    expect(clampZoom(75)).toBe(80);
    expect(clampZoom(200)).toBe(150);
    expect(clampZoom(0)).toBe(80);
  });

  it('NaN 回退 100', () => {
    expect(clampZoom(Number.NaN)).toBe(100);
  });

  it('步进 10 且到界即止', () => {
    expect(stepZoom(100, 1)).toBe(110);
    expect(stepZoom(100, -1)).toBe(90);
    expect(stepZoom(145, 1)).toBe(150);
    expect(stepZoom(85, -1)).toBe(80);
  });
});

describe('类型导出', () => {
  it('HotkeyAction 覆盖七个动作', () => {
    const all: HotkeyAction[] = ['search', 'import', 'print', 'export', 'zoomIn', 'zoomOut', 'zoomReset'];
    expect(all.length).toBe(7);
  });
});
