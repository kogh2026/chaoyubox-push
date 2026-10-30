import { describe, expect, it } from 'vitest';
import { mmToPx } from '../lib/matting';
import {
  drawDemoCanvas,
  canvasToBlob,
  createDemoItem,
} from './IdPhoto';

/* ===== 纯逻辑：mmToPx 规格换算 =====
   界面文案「一寸 25×35mm · 295×413px」正是该函数 @300DPI 的产物，回归它。 */
describe('mmToPx 规格换算', () => {
  it('一寸宽 25mm @300DPI → 295px（四舍五入）', () => {
    expect(mmToPx(25, 300)).toBe(295);
  });
  it('一寸高 35mm @300DPI → 413px', () => {
    expect(mmToPx(35, 300)).toBe(413);
  });
  it('默认 DPI 为 300', () => {
    expect(mmToPx(25)).toBe(295);
  });
  it('二寸 35×49mm → 413×579px', () => {
    expect(mmToPx(35, 300)).toBe(413);
    expect(mmToPx(49, 300)).toBe(579);
  });
});

/* ===== canvas 依赖测试：仅在真实 canvas 环境运行（node 下 skip） =====
   node 无 DOM/canvas，drawDemoCanvas/canvasToBlob/createDemoItem 无法在此执行；
   这两个函数的真正端到端覆盖在 tests/e2e/test_idphoto.py（Chromium 内）完成。 */
const hasCanvas =
  typeof document !== 'undefined' &&
  typeof document.createElement === 'function' &&
  typeof document.createElement('canvas').getContext === 'function';

const describeCanvas = hasCanvas ? describe : describe.skip;

describeCanvas('演示照片生成（canvas 环境）', () => {
  it('drawDemoCanvas 返回固定尺寸画布', () => {
    const c = drawDemoCanvas(0);
    expect(c.width).toBe(420);
    expect(c.height).toBe(560);
  });

  it('canvasToBlob 导出非空 JPEG', async () => {
    const blob = await canvasToBlob(drawDemoCanvas(1));
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toBe('image/jpeg');
  });

  it('createDemoItem 产出真实可处理照片（file + 预览 url）', async () => {
    const item = await createDemoItem(0, () => 'p1');
    expect(item.id).toBe('p1');
    expect(item.file.type).toBe('image/jpeg');
    expect(item.url.startsWith('blob:')).toBe(true);
  });
});
