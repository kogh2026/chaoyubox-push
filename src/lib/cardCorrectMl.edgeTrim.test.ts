import { describe, it, expect } from 'vitest';
import { warpQuadToRect, type RgbaImage } from './cardCorrectMl';
import type { Pt } from './cvGeometry';

function solid(w: number, h: number, rgb: [number, number, number]): RgbaImage {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = rgb[0];
    d[i * 4 + 1] = rgb[1];
    d[i * 4 + 2] = rgb[2];
    d[i * 4 + 3] = 255;
  }
  return { data: d, width: w, height: h };
}

function fillRect(img: RgbaImage, x: number, y: number, w: number, h: number, rgb: [number, number, number]) {
  for (let j = y; j < y + h; j++)
    for (let i = x; i < x + w; i++) {
      const k = (j * img.width + i) * 4;
      img.data[k] = rgb[0];
      img.data[k + 1] = rgb[1];
      img.data[k + 2] = rgb[2];
    }
}

describe('warpQuadToRect 裁边内缩（消除小黑边）', () => {
  // 模拟检测角点向外偏：白色卡面在 (40,30)~(160,120)，但 quad 取到更大一圈 (35,25)~(165,125)
  const src = () => {
    const img = solid(200, 150, [20, 20, 20]); // 深色背景
    fillRect(img, 40, 30, 120, 90, [240, 240, 240]); // 白色卡面
    return img;
  };
  const quad: Pt[] = [
    { x: 35, y: 25 },
    { x: 165, y: 25 },
    { x: 165, y: 125 },
    { x: 35, y: 125 },
  ];

  it('edgeTrim=0：输出边角带入卡面外的深色暗边', () => {
    const out = warpQuadToRect(src(), quad, 0);
    expect(out.data[0]).toBeLessThan(60); // (0,0) 映射到 quad 角点 = 深色背景
  });

  it('edgeTrim>0：卡面外暗边被裁掉，输出边角落在卡面内部', () => {
    const out = warpQuadToRect(src(), quad, 0.1);
    expect(out.data[0]).toBeGreaterThan(200); // 内缩后 (0,0) 落在白色卡面内
  });
});

/**
 * 真实比例下的「小黑边」模型：
 * 检测角点其实是准的，但卡边那一圈因为 JPEG 振铃 / 阴影 / 抗锯齿而发暗，
 * 于是裁出来的卡面四周永远挂着一圈暗边。这类暗边只有内缩才能清掉。
 *
 * 这里用 1200×800 的源图（接近真实翻拍尺寸），卡面 800×500，
 * 卡边内外各 2px 被压暗模拟过渡带；输出约 800px，0.8% 内缩 ≈ 6px。
 */
describe('warpQuadToRect 默认内缩 0.8% 能清掉真实卡边暗带', () => {
  const W = 1200;
  const H = 800;
  const CARD = { x: 200, y: 150, w: 800, h: 500 };

  /** 造一张带卡边暗带的翻拍图 */
  const photo = () => {
    const img = solid(W, H, [25, 25, 25]); // 深色桌面
    fillRect(img, CARD.x, CARD.y, CARD.w, CARD.h, [242, 242, 242]); // 白色卡面
    fillRect(img, CARD.x - 2, CARD.y - 2, CARD.w + 4, CARD.h + 4, [18, 18, 18]); // 暗带压在卡边内外
    fillRect(img, CARD.x + 2, CARD.y + 2, CARD.w - 4, CARD.h - 4, [242, 242, 242]); // 保留内侧 2px 暗带
    return img;
  };

  /** 检测角点正好落在卡边（真实且常见的情况） */
  const cardQuad: Pt[] = [
    { x: CARD.x, y: CARD.y },
    { x: CARD.x + CARD.w, y: CARD.y },
    { x: CARD.x + CARD.w, y: CARD.y + CARD.h },
    { x: CARD.x, y: CARD.y + CARD.h },
  ];

  /** 输出图最外圈 ring 像素的平均亮度 */
  const outerRingMean = (img: RgbaImage, ring = 2): number => {
    let sum = 0;
    let n = 0;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const edge = x < ring || y < ring || x >= img.width - ring || y >= img.height - ring;
        if (!edge) continue;
        sum += img.data[(y * img.width + x) * 4];
        n++;
      }
    }
    return sum / n;
  };

  it('内缩 0 时最外圈被暗带污染（复现"小黑边"）', () => {
    const out = warpQuadToRect(photo(), cardQuad, 0);
    expect(outerRingMean(out)).toBeLessThan(120);
  });

  it('默认 0.8% 内缩后最外圈回到卡面白，暗带消失', () => {
    const out = warpQuadToRect(photo(), cardQuad, 0.008);
    expect(outerRingMean(out)).toBeGreaterThan(200);
  });

  it('内缩只裁掉约 0.8%，卡面内容基本不缩水', () => {
    const out0 = warpQuadToRect(photo(), cardQuad, 0);
    const out8 = warpQuadToRect(photo(), cardQuad, 0.008);
    expect(out8.width / out0.width).toBeGreaterThan(0.985);
    expect(out8.width / out0.width).toBeLessThan(1);
    // 卡面中心仍是白的（没把内容裁掉）
    const mid = ((out8.height >> 1) * out8.width + (out8.width >> 1)) * 4;
    expect(out8.data[mid]).toBeGreaterThan(200);
  });
});
