/** 矢量导出圆角验证：桩 document=@napi-rs/canvas，跑真实 exportVectorSheetPdf，
 *  捕获嵌入的单元格 JPEG 并解码，确认角点为白（圆角裁剪生效）、中心为红。
 *  @napi-rs/canvas 缺失时自动跳过。 */
import { describe, expect, it, beforeAll } from 'vitest';
import { exportVectorSheetPdf, type VectorCell, type VectorDocLike, type VectorPageLike } from './vectorSheetPdf';

let mod: typeof import('@napi-rs/canvas') | null = null;
try {
  mod = require('@napi-rs/canvas');
} catch {
  mod = null;
}

const createCanvas = mod?.createCanvas;
const loadImage = mod?.loadImage;

beforeAll(() => {
  if (createCanvas) {
    // 让真实 defaultEncodeCell 在 node 下可用：用 @napi-rs 充当 document.createElement('canvas')
    (globalThis as any).document = {
      createElement: (t: string) => (t === 'canvas' ? createCanvas!(1, 1) : null),
    };
  }
});

describe.skipIf(!createCanvas || !loadImage)('exportVectorSheetPdf 圆角（真实单元格编码）', () => {
  it('导出 PDF 中嵌入的卡片 JPEG 角点为白、中心为红', async () => {
    const cv = createCanvas!(100, 100);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#e11d48';
    ctx.fillRect(0, 0, 100, 100);
    const img: any = cv;
    img.naturalWidth = 100;
    img.naturalHeight = 100;
    const cell: VectorCell = { img, rotation: 0 };

    const embedded: Uint8Array[] = [];
    const page: VectorPageLike = {
      drawImage: () => {},
      drawLine: () => {},
      drawText: () => {},
    };
    const doc: VectorDocLike = {
      addPage: () => page,
      embedJpg: async (bytes) => {
        embedded.push(bytes);
        return { id: embedded.length };
      },
      embedCjkFont: async () => null,
      save: async () => new Uint8Array([1]),
    };

    await exportVectorSheetPdf({
      paper: { w: 210, h: 297 },
      placements: [{ x: 60, y: 120, w: 85.6, h: 54 }],
      pages: [[cell]],
      style: { colorMode: 'color', sat: 100, sharpen: 0, cornerRadiusMm: 4 },
      dpi: 300,
      createDoc: (async () => doc) as never,
    });

    expect(embedded.length).toBe(1);
    const decoded = (await loadImage!(embedded[0])) as any;
    const dc = createCanvas!(decoded.width, decoded.height);
    const dctx = dc.getContext('2d');
    dctx.drawImage(decoded, 0, 0, decoded.width, decoded.height);
    // 300dpi 下 4mm ≈ 47px 半径；角点内侧采样
    const corner = dctx.getImageData(2, 2, 1, 1).data;
    const center = dctx.getImageData(Math.round(decoded.width / 2), Math.round(decoded.height / 2), 1, 1).data;
    // 角点应接近白（圆角裁剪排除区）；JPEG 轻微漂移，给容差
    expect(corner[0]).toBeGreaterThan(230);
    expect(corner[1]).toBeGreaterThan(230);
    expect(corner[2]).toBeGreaterThan(230);
    // 中心应仍为主红（卡片）；JPEG 压缩后容忍色偏
    expect(center[0]).toBeGreaterThan(170);
    expect(center[1]).toBeLessThan(90);
    expect(center[2]).toBeLessThan(130);
  });
});
