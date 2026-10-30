import { describe, it, expect } from 'vitest';
import { classifyCardType } from './cardOcr';

describe('证件类型识别（OCR 文本 → 类型）', () => {
  it('身份证：命中公民身份号码', () => {
    const r = classifyCardType('中华人民共和国\n居民身份证\n公民身份号码 110101199001010011');
    expect(r.type).toBe('idcard');
    expect(r.hits.length).toBeGreaterThan(0);
  });

  it('户口本：命中常住人口登记卡', () => {
    expect(classifyCardType('常住人口登记卡  户主  与户主关系 之女').type).toBe('hukou');
  });

  it('护照：英文 PASSPORT 也能命中（大小写/空格无关）', () => {
    expect(classifyCardType('P A S S P O R T\nType/P').type).toBe('passport');
  });

  it('驾驶证：命中准驾车型', () => {
    expect(classifyCardType('机动车驾驶证\n准驾车型 C1').type).toBe('drive');
  });

  it('社保卡等其他证件归入 other', () => {
    expect(classifyCardType('社会保障卡 社会保障号码 123').type).toBe('other');
  });

  it('无有效文本时不误判（仍返回 other 且无命中）', () => {
    const r = classifyCardType('');
    expect(r.type).toBe('other');
    expect(r.hits).toEqual([]);
  });

  it('身份证优先于其他规则（避免"签发机关"误落 other）', () => {
    expect(classifyCardType('签发机关 某某市公安局 有效期限 2020-2040').type).toBe('idcard');
  });
});
