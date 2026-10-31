/** 圆角集成验证：用真实生产代码 renderCardPage + @napi-rs/canvas 实际渲染，
 *  采样角点像素确认圆角裁剪生效，并对照 cornerRadiusMm=0 的直角行为。
 *  依赖 @napi-rs/canvas（本项目 node_modules 已带）；缺失时自动跳过，不影响 CI。 */
import { describe, expect, it } from 'vitest';
import { renderCardPage } from './idCardLayout';

let createCanvas: ((w: number, h: number) => any) | null = null;
try {
  // 动态导入：CI 未装该原生库时跳过，不阻断。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  createCanvas = (require('@napi-rs/canvas').createCanvas as (w: number, h: number) => any) ?? null;
} catch {
  createCanvas = null;
}

// 构造一张纯红源图（带 naturalWidth/Height，可被 drawImage 直接使用）
function redImage(): any {
  const c = createCanvas!(100, 100);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e11d48';
  ctx.fillRect(0, 0, 100, 100);
  const img: any = c;
  img.naturalWidth = 100;
  img.naturalHeight = 100;
  return img;
}

function renderPage(cornerRadiusMm: number) {
  const pxPerMm = 3;
  const paperW = 210;
  const paperH = 297;
  const cv: any = createCanvas!(Math.round(paperW * pxPerMm), Math.round(paperH * pxPerMm));
  // 单张卡：85.6×54mm，放在页面中部
  const p = { x: 60, y: 120, w: 85.6, h: 54 };
  renderCardPage(
    cv,
    paperW,
    paperH,
    [p],
    [{ img: redImage(), rotation: 0 }],
    pxPerMm,
    { colorMode: 'color', sat: 100, sharpen: 0, wm: { on: false, text: '' }, cornerRadiusMm },
  );
  return { cv, p, pxPerMm };
}

describe.skipIf(!createCanvas)('renderCardPage 圆角裁剪（真实画布集成）', () => {
  it('圆角生效：卡片角点像素为白（页面底色），中心为红（卡片）', () => {
    const { cv, p, pxPerMm } = renderPage(4);
    const ctx = cv.getContext('2d');
    const px = (xx: number, yy: number) => {
      const d = ctx.getImageData(xx, yy, 1, 1).data;
      return `${d[0]},${d[1]},${d[2]}`;
    };
    // 卡片左上角内侧 1px（落在圆角裁剪排除区）
    const corner = px(Math.round(p.x * pxPerMm) + 1, Math.round(p.y * pxPerMm) + 1);
    // 卡片中心
    const center = px(
      Math.round((p.x + p.w / 2) * pxPerMm),
      Math.round((p.y + p.h / 2) * pxPerMm),
    );
    expect(corner).toBe('255,255,255'); // 角点 = 白 → 圆角已裁剪
    expect(center).toBe('225,29,72'); // 中心 = 红 → 卡片已绘制
  });

  it('角点像素在直角模式(cornerRadiusMm=0)下为红（无圆角）', () => {
    const { cv, p, pxPerMm } = renderPage(0);
    const ctx = cv.getContext('2d');
    const corner = ctx.getImageData(Math.round(p.x * pxPerMm) + 1, Math.round(p.y * pxPerMm) + 1, 1, 1).data;
    expect(`${corner[0]},${corner[1]},${corner[2]}`).toBe('225,29,72'); // 直角：角点即卡片
  });

  it('导出圆角效果 PNG 供人工核对', () => {
    const { cv } = renderPage(4);
    const fs = require('fs');
    const path = require('path');
    const out = path.resolve(__dirname, '../../.tmp/rounded-proof.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, cv.toBuffer('image/png'));
    expect(fs.existsSync(out)).toBe(true);
  });
});
