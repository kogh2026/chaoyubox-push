// -*- coding: utf-8 -*-
/** 验证证件长宽比合法性门控 correctedAspectDev 的判别力：
 *  - 真实卡面(≈1.585) 通过门控；
 *  - 畸形碎片（CV 把整图当卡检出，区域 1.3339，偏差 15.85%）被剔除。
 *
 * 修复要点（见 src/tools/CardLayout.tsx）：门控改用【真实像素 quad】的长宽比
 * （quadToPx 反乘原图尺寸 + quadSize），而非 corrected.img（被强行压成标准卡尺寸，
 * 任何 quad 输出都≈1.585 无法区分）或归一化 quad 边长（方形预处理/不同长宽比会失真）。
 * 本测试直接调用真实函数，构造与运行时一致的「归一化 quad + 原图像素尺寸」输入。 */
import { describe, it, expect } from 'vitest';
import { pxToQuad, type Pt, type Quad } from './cvGeometry';
import { correctedAspectDev } from '../tools/CardLayout';
import type { CardItem } from '../tools/CardLayout';

const ID_CARD_ASPECT = 85.6 / 54; // ≈1.585

/** 给定真实像素下宽高比 = aspect 的矩形，再归一化到 W×H（模拟 CV/模型返回的归一化 quad） */
function normQuadForRealAspect(aspect: number, W: number, H: number): Quad {
  const w = 1100;
  const h = w / aspect;
  const px: Pt[] = [
    { x: 100, y: 200 },
    { x: 100 + w, y: 200 },
    { x: 100 + w, y: 200 + h },
    { x: 100, y: 200 + h },
  ];
  return pxToQuad(px, W, H);
}

/** 构造一个仅含门控所需字段的 CardItem（真实像素长宽比 = aspect，原图 W×H） */
function itemOf(aspect: number, W = 1600, H = 1200): CardItem {
  return {
    img: { naturalWidth: W, naturalHeight: H } as HTMLImageElement,
    quad: normQuadForRealAspect(aspect, W, H),
  } as CardItem;
}

describe('correctedAspectDev 证件长宽比判别（真实像素 quad 路径）', () => {
  it('真实身份证卡面(≈1.585) 偏差≈0，通过门控（阈值 0.1）', () => {
    expect(correctedAspectDev(itemOf(ID_CARD_ASPECT))).toBeLessThan(0.01);
  });

  it('误检畸形碎片(1.3339, dev≈0.1585) 超过 0.1 阈值，被门控剔除', () => {
    // 复现基准中实测的误检卡：CV 把整图当卡检出，区域长宽比 1.3339，偏差 15.85%
    expect(correctedAspectDev(itemOf(1.3339))).toBeGreaterThan(0.1);
  });

  it('阈值 0.1 恰好分离合法与畸形：合法边(≤0.06)通过，畸形(≥0.158)剔除', () => {
    // 合法补检卡实测偏差上限 ≈0.0589（如 430502197602190561 → 长宽比 1.4918）
    expect(correctedAspectDev(itemOf(1.4918))).toBeLessThanOrEqual(0.1);
    expect(correctedAspectDev(itemOf(1.3339))).toBeGreaterThan(0.1);
  });

  it('正方形/极度畸形 quad 也判为非法', () => {
    expect(correctedAspectDev(itemOf(1.0))).toBeGreaterThan(0.1); // 正方形偏差≈37%
  });

  it('尺度无关：4:3 原图与方形原图对同真实长宽比给出一致偏差', () => {
    const a43 = correctedAspectDev(itemOf(1.585, 1600, 1200));
    const a11 = correctedAspectDev(itemOf(1.585, 1500, 1500));
    expect(Math.abs(a43 - a11)).toBeLessThan(0.005);
  });

  it('回归：旧门控依赖 corrected.img（被压成标准卡尺寸≈1.585）无法区分畸形，新门控可区分', () => {
    // 旧逻辑用校正输出 crop（ow×oh，恒≈1.585）判定，任何 quad 矫正后输出都一样，
    // 一个 1.3339 的畸形区域经 warp 后仍是 1.585，旧门控会误判为合规而漏拦。
    // 新门控改用真实像素 quad 区域长宽比，能稳定把 1.3339 畸形（dev 0.1585）剔除，
    // 同时保留真实卡面（dev<0.01）。这里锁定新门控的判别结论。
    expect(correctedAspectDev(itemOf(1.3339))).toBeGreaterThan(0.1);
    expect(correctedAspectDev(itemOf(ID_CARD_ASPECT))).toBeLessThan(0.01);
  });
});
