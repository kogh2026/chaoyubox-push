import type { Preset } from './quote';

const KEY = 'chaoyu.presets.v1';

function defaultPresets(): Preset[] {
  return [
    {
      id: 1,
      name: '默认 A4',
      paper: 'A4',
      bwCents: 50,
      dotCents: 100,
      colorCents: 200,
      duplexFactor: 0.6,
      ladderThreshold: 100,
      ladderCents: 40,
    },
    {
      id: 2,
      name: '相纸 6 寸',
      paper: '6寸',
      bwCents: 200,
      dotCents: 200,
      colorCents: 300,
      duplexFactor: 1,
      ladderThreshold: 0,
      ladderCents: 0,
    },
  ];
}

export function loadPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultPresets();
    const arr = JSON.parse(raw) as Preset[];
    return arr.length ? arr : defaultPresets();
  } catch {
    return defaultPresets();
  }
}

export function savePresets(p: Preset[]): void {
  localStorage.setItem(KEY, JSON.stringify(p));
}

export function nextId(p: Preset[]): number {
  return p.reduce((m, x) => Math.max(m, x.id), 0) + 1;
}
