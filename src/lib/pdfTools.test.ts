// PDF 工具箱核心库单测：结构类操作 + 加密往返验证 + 批注 + 大纲。
// 栅格类操作（canvas）由浏览器 E2E 覆盖，这里只测纯函数与 pdf-lib 路径。
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import {
  mergePdfFiles,
  interleaveMerge,
  splitPdfMulti,
  splitByBookmarks,
  explodeBookmarks,
  reorderPages,
  reversePages,
  padEvenPages,
  deletePages,
  removeBlankPages,
  rotatePerPage,
  nupLayout,
  bookletImpose,
  splitSpreadPages,
  createBlankPdf,
  imagesToPdf,
  addPageNumbers,
  batesNumbers,
  textWatermark,
  seamStamp,
  readMetadata,
  writeMetadata,
  removeBookmarks,
  inspectSignatures,
  compressPdf,
  decryptPdf,
  encryptPdf,
  packZip,
  formatBytes,
  hexToRgb,
  pngHasAlpha,
} from './pdfTools';
import { buildOutline, readOutline, outlineSections } from './pdfOutline';
import { addAnnotations, pxToPdf } from './pdfAnnot';
import {
  nonWhiteRatio,
  blankFlagsFromRatios,
  contentBBox,
  estimateSkewAngle,
} from './pdfRaster';

/* ===== 测试材料 ===== */

async function makePdf(pages: number, w = 595, h = 842, withText = true): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  if (withText) {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pages; i++) {
      const p = doc.addPage([w, h]);
      p.drawText(`page ${i + 1}`, { x: 50, y: h - 50, size: 24, font });
    }
  } else {
    for (let i = 0; i < pages; i++) doc.addPage([w, h]);
  }
  return doc.save();
}

// 1x1 红色 PNG
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49,
  0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

// 仅含合法 IHDR 头（colorType=6 RGBA）的占位，用于验证透明检测（不要求整段合法）
const RGBA_PNG_HEAD = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
  0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

async function pageCount(data: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(data);
  return doc.getPageCount();
}

/* ===== 页面管理 ===== */

describe('合并与交叉合并', () => {
  it('合并多个 PDF 页数相加', async () => {
    const a = await makePdf(2);
    const b = await makePdf(3);
    const out = await mergePdfFiles(
      [
        { name: 'a.pdf', data: a },
        { name: 'b.pdf', data: b },
      ],
      { compatMode: false, dpi: 2, pageSize: 'A4' },
    );
    expect(await pageCount(out)).toBe(5);
  });

  it('合并支持 PDF + 图片混合', async () => {
    const a = await makePdf(2);
    const out = await mergePdfFiles(
      [
        { name: 'a.pdf', data: a },
        { name: 'x.png', data: TINY_PNG },
      ],
      { compatMode: false, dpi: 2, pageSize: 'A4' },
    );
    expect(await pageCount(out)).toBe(3);
  });

  it('交叉合并按轮流取页', async () => {
    const a = await makePdf(2);
    const b = await makePdf(3);
    const out = await interleaveMerge([
      { name: 'a.pdf', data: a },
      { name: 'b.pdf', data: b },
    ]);
    // 2 + 3，页数不够的跳过 -> 5 页（a1 b1 a2 b2 b3）
    expect(await pageCount(out)).toBe(5);
  });
});

describe('拆分', () => {
  it('页码范围模式一范围一文件', async () => {
    const src = await makePdf(5);
    const out = await splitPdfMulti(src, 'doc.pdf', { mode: 'ranges', ranges: '1-2,4', fixed: 1 });
    expect(out.length).toBe(2);
    expect(out[0].name).toBe('doc_p1-2.pdf');
    expect(out[1].name).toBe('doc_p4.pdf');
    expect(await pageCount(out[0].data)).toBe(2);
  });

  it('固定页数模式', async () => {
    const src = await makePdf(5);
    const out = await splitPdfMulti(src, 'doc.pdf', { mode: 'fixed', ranges: '', fixed: 2 });
    expect(out.length).toBe(3);
    expect(await pageCount(out[2].data)).toBe(1);
  });

  it('全部单页模式', async () => {
    const src = await makePdf(3);
    const out = await splitPdfMulti(src, 'doc.pdf', { mode: 'single', ranges: '', fixed: 1 });
    expect(out.length).toBe(3);
  });

  it('奇偶拆分', async () => {
    const src = await makePdf(4);
    const out = await splitPdfMulti(src, 'doc.pdf', { mode: 'oddeven', ranges: '', fixed: 1 });
    expect(out.length).toBe(2);
    expect(await pageCount(out[0].data)).toBe(2);
    expect(await pageCount(out[1].data)).toBe(2);
  });

  it('越界页码抛错', async () => {
    const src = await makePdf(2);
    await expect(splitPdfMulti(src, 'd.pdf', { mode: 'ranges', ranges: '5', fixed: 1 })).rejects.toThrow();
  });
});

describe('书签拆分与炸开', () => {
  async function bookmarked(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 4; i++) doc.addPage([595, 842]);
    buildOutline(doc, [
      { title: '第一章', page: 1, children: [{ title: '1.1 节', page: 2, children: [] }] },
      { title: '第二章', page: 3, children: [] },
    ], (p) => p);
    return doc.save();
  }

  it('读取大纲树与章节区间', async () => {
    const data = await bookmarked();
    const nodes = await readOutline(data);
    expect(nodes.length).toBe(2);
    expect(nodes[0].title).toBe('第一章');
    expect(nodes[0].children[0].title).toBe('1.1 节');
    const secs = outlineSections(nodes, 4);
    expect(secs.length).toBe(3);
    expect(secs[0]).toMatchObject({ title: '第一章', from: 1, to: 2 });
    expect(secs[2]).toMatchObject({ title: '第二章', from: 3, to: 4 });
  });

  it('按书签勾选拆分', async () => {
    const data = await bookmarked();
    const out = await splitByBookmarks(data, [0, 2]); // 第一章(1-2) + 第二章(3-4)
    expect(await pageCount(out)).toBe(4);
  });

  it('按书签炸开为多文件', async () => {
    const data = await bookmarked();
    const out = await explodeBookmarks(data, 'doc.pdf', {
      addIndex: true,
      useFileNamePrefix: false,
      useBookmarkName: true,
      keepHierarchy: false,
      maxDepth: 1,
    });
    expect(out.length).toBe(2);
    expect(out[0].name).toContain('第一章');
    expect(await pageCount(out[0].data)).toBe(2);
  });
});

describe('页面操作', () => {
  it('倒序', async () => {
    const src = await makePdf(3);
    const out = await reversePages(src);
    expect(await pageCount(out)).toBe(3);
  });

  it('补齐空白页（奇数 -> 偶数）', async () => {
    const odd = await makePdf(3);
    expect(await pageCount(await padEvenPages(odd, 'last'))).toBe(4);
    const even = await makePdf(4);
    expect(await pageCount(await padEvenPages(even, 'last'))).toBe(4);
  });

  it('删除指定页', async () => {
    const src = await makePdf(4);
    const out = await deletePages(src, '2,4');
    expect(await pageCount(out)).toBe(2);
  });

  it('重排（含插入空白页）', async () => {
    const src = await makePdf(3);
    const out = await reorderPages(src, { order: [2, -1, 0, 1], blankSize: { w: 595, h: 842 } });
    expect(await pageCount(out)).toBe(4);
  });

  it('删除空白页（flags 驱动）', async () => {
    const src = await makePdf(3);
    const out = await removeBlankPages(src, [false, true, false]);
    expect(await pageCount(out)).toBe(2);
  });

  it('逐页旋转', async () => {
    const src = await makePdf(2);
    const out = await rotatePerPage(src, [90, 0]);
    const doc = await PDFDocument.load(out);
    expect(doc.getPage(0).getRotation().angle).toBe(90);
    expect(doc.getPage(1).getRotation().angle).toBe(0);
  });
});

describe('拼版与小册子', () => {
  it('2x2 拼版：4 页 -> 1 页', async () => {
    const src = await makePdf(4);
    const out = await nupLayout(src, { cols: 2, rows: 2, order: 'row', marginMm: 5, gapMm: 2, border: true, skipEmpty: false });
    expect(await pageCount(out)).toBe(1);
  });

  it('小册子排版：4 页 -> 2 个展开页', async () => {
    const src = await makePdf(4);
    const out = await bookletImpose(src, 'A5');
    expect(await pageCount(out)).toBe(2);
  });

  it('小册子排版页数补齐到 4 的倍数', async () => {
    const src = await makePdf(5);
    const out = await bookletImpose(src, 'A4');
    // 5 -> 补到 8 -> 4 个展开页
    expect(await pageCount(out)).toBe(4);
  });

  it('拆分对开页', async () => {
    const src = await makePdf(1, 1190, 842); // 横向对开
    const out = await splitSpreadPages(src, false);
    expect(await pageCount(out)).toBe(2);
  });

  it('非对开页不拆', async () => {
    const src = await makePdf(1, 595, 842);
    await expect(splitSpreadPages(src, false)).rejects.toThrow();
  });
});

describe('生成与转换', () => {
  it('生成空白页（带格线）', async () => {
    const out = await createBlankPdf({
      preset: 'A4',
      customW: 210,
      customH: 297,
      landscape: false,
      count: 3,
      grid: 'quad',
      lineColor: '#c8ced8',
      lineSpacingMm: 8,
      header: '',
      footer: '',
    });
    expect(await pageCount(out)).toBe(3);
  });

  it('图片转 PDF', async () => {
    const out = await imagesToPdf(
      [
        { name: 'a.png', data: TINY_PNG },
        { name: 'b.png', data: TINY_PNG },
      ],
      { pageSize: 'A4', landscape: false, marginMm: 10, fit: 'contain', background: '#ffffff' },
    );
    expect(await pageCount(out)).toBe(2);
  });
});

describe('编号与水印', () => {
  it('添加页码', async () => {
    const src = await makePdf(3);
    const out = await addPageNumbers(src, {
      template: 'n',
      position: 'bc',
      sizePt: 12,
      color: '#333333',
      marginMm: 15,
      startAt: 1,
      range: '',
      font: 'regular',
    });
    expect(await pageCount(out)).toBe(3);
  });

  it('批量编号跨文件连续', async () => {
    const a = await makePdf(2);
    const b = await makePdf(1);
    const out = await batesNumbers(
      [
        { name: 'a.pdf', data: a },
        { name: 'b.pdf', data: b },
      ],
      {
        prefix: 'NO-',
        suffix: '',
        start: 7,
        digits: 3,
        position: 'br',
        sizePt: 10,
        color: '#000000',
        marginMm: 10,
        range: '',
        merge: false,
      },
    );
    expect(out.length).toBe(2);
  });

  it('文字水印', async () => {
    const src = await makePdf(2);
    const out = await textWatermark(src, {
      text: 'SAMPLE',
      sizePt: 40,
      color: '#ff0000',
      opacity: 0.2,
      angle: 45,
      pos: { x: 0.5, y: 0.5 },
      tile: false,
      tileStepMm: 60,
      range: '',
      bold: false,
    });
    expect(await pageCount(out)).toBe(2);
  });

  it('骑缝章', async () => {
    const src = await makePdf(4);
    const out = await seamStamp(src, {
      text: 'ABC',
      sizePt: 16,
      color: '#cc0000',
      charsPerPage: 1,
      range: '',
      fan: true,
    });
    expect(await pageCount(out)).toBe(4);
  });
});

describe('元数据与书签移除', () => {
  it('元数据读写往返', async () => {
    const src = await makePdf(1);
    const written = await writeMetadata(src, {
      title: '测试标题',
      author: '测试作者',
      subject: '主题',
      keywords: 'a,b,c',
      creator: 'creator',
      producer: 'producer',
    });
    const meta = await readMetadata(written);
    expect(meta.title).toBe('测试标题');
    expect(meta.author).toBe('测试作者');
    expect(meta.keywords.replace(/\s/g, '')).toBe('a,b,c');
  });

  it('移除书签', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 2; i++) doc.addPage([595, 842]);
    buildOutline(doc, [{ title: '书签', page: 1, children: [] }], (p) => p);
    const withBm = await doc.save();
    const nodes = await readOutline(withBm);
    expect(nodes.length).toBe(1);
    const out = await removeBookmarks(withBm);
    expect((await readOutline(out)).length).toBe(0);
  });
});

describe('压缩与解密', () => {
  it('轻度压缩返回体积信息', async () => {
    const src = await makePdf(3);
    const r = await compressPdf(src, 'light');
    expect(r.mode).toBe('light');
    expect(r.after).toBeGreaterThan(0);
    expect(await pageCount(r.data)).toBe(3);
  });

  it('解密重新保存', async () => {
    const src = await makePdf(2);
    const out = await decryptPdf(src);
    expect(await pageCount(out)).toBe(2);
  });
});

describe('加密（标准安全处理器）', () => {
  it('加密后需密码打开，pdfjs 可验证', async () => {
    const src = await makePdf(3);
    const enc = await encryptPdf(src, {
      userPassword: '123456',
      ownerPassword: '',
      printing: true,
      copying: false,
      modifying: false,
      annotating: true,
    });
    expect(enc.length).toBeGreaterThan(1000);
    const text = new TextDecoder('latin1').decode(enc);
    expect(text).toContain('/Filter /Standard');
    expect(text).toContain('/Encrypt');

    // pdfjs 不带密码 -> 需要密码
    let needPw = false;
    try {
      await pdfjsLib.getDocument({ data: new Uint8Array(enc) }).promise;
    } catch (e) {
      needPw = (e as { name?: string }).name === 'PasswordException';
    }
    expect(needPw).toBe(true);

    // 带密码 -> 正常打开
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(enc), password: '123456' }).promise;
    expect(doc.numPages).toBe(3);
    doc.destroy();
  });

  it('错误密码被拒绝', async () => {
    const src = await makePdf(2);
    const enc = await encryptPdf(src, {
      userPassword: 'right',
      ownerPassword: '',
      printing: true,
      copying: true,
      modifying: true,
      annotating: true,
    });
    let rejected = false;
    try {
      await pdfjsLib.getDocument({ data: new Uint8Array(enc), password: 'wrong' }).promise;
    } catch (e) {
      rejected = (e as { name?: string }).name === 'PasswordException';
    }
    expect(rejected).toBe(true);
  });
});

describe('签名信息', () => {
  it('无签名文档返回空列表', async () => {
    const src = await makePdf(1);
    const r = await inspectSignatures(src);
    expect(r.items.length).toBe(0);
    expect(r.hasForm).toBe(false);
  });
});

describe('批注', () => {
  it('添加高亮批注后可通过底层结构读回', async () => {
    const src = await makePdf(1);
    const doc = await PDFDocument.load(src);
    addAnnotations(doc, [
      {
        page: 1,
        kind: 'highlight',
        rect: { x: 50, y: 700, w: 200, h: 20 },
        color: [1, 0.9, 0.2],
        opacity: 0.5,
        note: '重点',
      },
      { page: 1, kind: 'note', rect: { x: 100, y: 600, w: 16, h: 16 }, color: [1, 1, 0], note: '便签' },
    ]);
    const out = await doc.save();
    const reload = await PDFDocument.load(out);
    const page = reload.getPage(0);
    const annots = page.node.get(PDFName.of('Annots'));
    expect(annots).toBeTruthy();
    const arr = annots as unknown as { size(): number; get(i: number): unknown };
    expect(arr.size()).toBe(2);
    // 保存后数组元素是间接引用
    const firstRef = arr.get(0) as Parameters<PDFDocument['context']['lookup']>[0];
    const first = reload.context.lookup(firstRef) as unknown as { get(k: unknown): unknown };
    expect(String(first.get(PDFName.of('Subtype')))).toContain('Highlight');
  });

  it('预览坐标转 PDF 坐标', () => {
    const p = pxToPdf(100, 50, 1, 842);
    expect(p.x).toBe(100);
    expect(p.y).toBe(792);
  });
});

/* ===== 栅格纯函数 ===== */

describe('栅格分析纯函数', () => {
  function img(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const [r, g, b, a] = fill(x, y);
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = a;
      }
    }
    return { data, width: w, height: h };
  }

  it('空白率：全白为 0，半黑为 0.5', () => {
    const white = img(10, 10, () => [255, 255, 255, 255]);
    expect(nonWhiteRatio(white)).toBe(0);
    const half = img(10, 10, (x) => (x < 5 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    expect(nonWhiteRatio(half)).toBeCloseTo(0.5, 5);
  });

  it('空白标记按阈值', () => {
    expect(blankFlagsFromRatios([0.001, 0.5, 0.002], 0.3)).toEqual([true, false, true]);
  });

  it('内容包围盒', () => {
    const i = img(20, 20, (x, y) => (x >= 5 && x < 15 && y >= 5 && y < 10 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const box = contentBBox(i);
    expect(box).toEqual({ x0: 5, y0: 5, x1: 14, y1: 9 });
    expect(contentBBox(img(5, 5, () => [255, 255, 255, 255]))).toBeNull();
  });

  it('倾斜角估计：人为倾斜 3 度的文本行可估回', () => {
    // 构造"文本行"：每 10 行一条；行内是 5px 黑 + 5px 白的字符状条纹，
    // 这样列投影才有横向结构可对齐（整行纯黑无论怎么剪切都完全一样，测不出角度）。
    // 整体按 3 度剪切：越往下越向右偏，呈 "\" 倾斜 → 需顺时针转 3 度摆正（与返回的符号约定一致）。
    const w = 200;
    const h = 200;
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    const tan3 = Math.tan((3 * Math.PI) / 180);
    for (let y = 0; y < h; y++) {
      const shift = Math.round(y * tan3);
      if (y % 10 === 0) {
        for (let x = 0; x < w; x++) {
          if (x % 10 >= 5) continue; // 字符间隙
          const sx = x + shift;
          if (sx >= 0 && sx < w) {
            const i = (y * w + sx) * 4;
            data[i] = data[i + 1] = data[i + 2] = 0;
          }
        }
      }
    }
    const gray = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) gray[j] = data[i];
    const est = estimateSkewAngle(gray, w, h);
    expect(Math.abs(est - 3)).toBeLessThan(0.75);
  });
});

describe('PNG 透明通道检测', () => {
  it('RGB PNG（无透明）返回 false', () => {
    expect(pngHasAlpha(TINY_PNG)).toBe(false);
  });
  it('RGBA PNG（含透明）返回 true', () => {
    expect(pngHasAlpha(RGBA_PNG_HEAD)).toBe(true);
  });
  it('过短或非 PNG 返回 false', () => {
    expect(pngHasAlpha(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(pngHasAlpha(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe(false);
  });
});

describe('工具函数', () => {
  it('hexToRgb', () => {
    expect(hexToRgb('#ff0000')).toEqual([1, 0, 0]);
    expect(hexToRgb('000000')).toEqual([0, 0, 0]);
  });

  it('formatBytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1024 * 1024 * 3)).toBe('3.00 MB');
  });

  it('packZip 产出 zip', async () => {
    const zip = await packZip([{ name: 'a.txt', data: new Uint8Array([1, 2, 3]) }]);
    expect(zip.size).toBeGreaterThan(0);
    expect(zip.type).toBe('application/zip');
  });
});
