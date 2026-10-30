import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PHOTO_OPTIONS,
  photoOptionsReducer,
  type PhotoOptions,
  type PhotoOptionsAction,
} from './idphotoOptions';

const clone = (): PhotoOptions => ({
  ...DEFAULT_PHOTO_OPTIONS,
  exportSizeIds: [...DEFAULT_PHOTO_OPTIONS.exportSizeIds],
});

const run = (state: PhotoOptions, action: PhotoOptionsAction) => photoOptionsReducer(state, action);

describe('DEFAULT_PHOTO_OPTIONS：默认档的唯一真相', () => {
  it('快照式断言产品口径：自然美颜 / 6 寸相纸 / 2mm 间隔', () => {
    expect(DEFAULT_PHOTO_OPTIONS).toMatchInlineSnapshot(`
      {
        "advEye": 25,
        "advOn": false,
        "advShine": 35,
        "advSmooth": 60,
        "batchAutoFrame": true,
        "beautyLevel": "natural",
        "bgId": "white",
        "brightness": 0,
        "customHex": "#ffffff",
        "defringeOn": true,
        "edgeThreshold": 30,
        "engine": "modnet",
        "exportSizeIds": [
          "1cun",
        ],
        "fillScale": 1,
        "gapMm": 2,
        "guideOn": false,
        "monoOn": false,
        "paperId": "r6",
        "postureOn": false,
        "presetId": "1cun",
        "sheetMode": "multi",
        "sizeMark": true,
        "specMode": "default",
        "whitenLevel": "natural",
        "whitenOn": false,
      }
    `);
  });

  it('默认值的几个「为什么这么定」逐条钉住', () => {
    expect(DEFAULT_PHOTO_OPTIONS.beautyLevel).toBe('natural'); // 与爱印一致的可选默认档
    expect(DEFAULT_PHOTO_OPTIONS.paperId).toBe('r6'); // 6 寸相纸
    expect(DEFAULT_PHOTO_OPTIONS.gapMm).toBe(2); // 2mm 间隔
    expect(DEFAULT_PHOTO_OPTIONS.engine).toBe('modnet'); // 默认快速：50 张 45s vs 288s，量大时体感差异
    expect(DEFAULT_PHOTO_OPTIONS.defringeOn).toBe(true); // 去边缘默认开
    expect(DEFAULT_PHOTO_OPTIONS.batchAutoFrame).toBe(true); // 批量默认自动构图
    // 导出集合默认只含当前规格，两者必须一致，否则「勾了 A 导出 B」
    expect(DEFAULT_PHOTO_OPTIONS.exportSizeIds).toEqual([DEFAULT_PHOTO_OPTIONS.presetId]);
  });
});

describe('photoOptionsReducer：set / patch / reset', () => {
  it('set 只改指定键，其余键值原样保留', () => {
    const s0 = clone();
    const s1 = run(s0, { type: 'set', key: 'gapMm', value: 5 });
    expect(s1.gapMm).toBe(5);
    expect(s1.presetId).toBe(s0.presetId);
    expect(s1.beautyLevel).toBe(s0.beautyLevel);
    // 不可变：旧 state 不被改写
    expect(s0.gapMm).toBe(2);
    expect(s1).not.toBe(s0);
  });

  it('set 不修改入参（冻结对象也能跑）', () => {
    const s0 = Object.freeze({ ...clone() });
    expect(() => run(s0 as PhotoOptions, { type: 'set', key: 'bgId', value: 'blue' })).not.toThrow();
    expect(s0.bgId).toBe('white');
  });

  it('patch 一次改多个键（预设套用 / 迁移用）', () => {
    const s1 = run(clone(), {
      type: 'patch',
      patch: { presetId: '2cun', paperId: 'a4', gapMm: 4, beautyLevel: 'off' },
    });
    expect(s1.presetId).toBe('2cun');
    expect(s1.paperId).toBe('a4');
    expect(s1.gapMm).toBe(4);
    expect(s1.beautyLevel).toBe('off');
    expect(s1.engine).toBe(DEFAULT_PHOTO_OPTIONS.engine); // 未提及的键不动
  });

  it('reset 回到出厂默认，且 exportSizeIds 不与默认常量共享引用', () => {
    const dirty = run(clone(), { type: 'patch', patch: { gapMm: 9, beautyLevel: 'refined' } });
    const back = run(dirty, { type: 'reset' });
    expect(back).toEqual(DEFAULT_PHOTO_OPTIONS);
    expect(back.exportSizeIds).not.toBe(DEFAULT_PHOTO_OPTIONS.exportSizeIds);
  });
});

describe('photoOptionsReducer：导出规格集合的两条不变量', () => {
  it('add-size 幂等：已在集合里返回同一引用（不触发多余渲染）', () => {
    const s0 = clone();
    expect(run(s0, { type: 'add-size', id: '1cun' })).toBe(s0);
    const s1 = run(s0, { type: 'add-size', id: '2cun' });
    expect(s1.exportSizeIds).toEqual(['1cun', '2cun']);
    expect(s0.exportSizeIds).toEqual(['1cun']); // 入参不变
  });

  it('toggle-size 勾上未选中的规格', () => {
    const s1 = run(clone(), { type: 'toggle-size', id: '2cun' });
    expect(s1.exportSizeIds).toEqual(['1cun', '2cun']);
  });

  it('toggle-size 取消已选中的规格', () => {
    const two = run(clone(), { type: 'toggle-size', id: '2cun' });
    const one = run(two, { type: 'toggle-size', id: '2cun' });
    expect(one.exportSizeIds).toEqual(['1cun']);
  });

  it('toggle-size 恒保留至少一个：取消最后一个无效且返回同一引用', () => {
    const s0 = clone(); // 只有 1cun
    expect(run(s0, { type: 'toggle-size', id: '1cun' })).toBe(s0);
    expect(s0.exportSizeIds).toEqual(['1cun']);
  });

  it('toggle 顺序不影响结果（集合语义，不是数组语义）', () => {
    const a = run(run(clone(), { type: 'toggle-size', id: '2cun' }), { type: 'toggle-size', id: '2cun' });
    const b = run(run(clone(), { type: 'add-size', id: '2cun' }), { type: 'toggle-size', id: '2cun' });
    expect(a.exportSizeIds).toEqual(b.exportSizeIds);
  });
});
