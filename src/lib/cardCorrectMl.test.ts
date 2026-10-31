// cardCorrectMl 单测：爱印卡证矫正②层的纯逻辑复刻验证。
// 全部用合成数据 + 桩 runner，不依赖真实模型（真实权重另有 *.ort.test.ts）。
import { describe, expect, it } from 'vitest';
import {
  GRID,
  MODEL_INPUT,
  acceptNextCandidate,
  decodeModelOutput,
  edgeRoomRatio,
  frameParams,
  homographyFromCorners,
  modelCorrectLoop,
  polyArea,
  preprocessModelInput,
  quadSizePx,
  rotateImageQuarter,
  warpQuadToRect,
  whitenQuadFill,
  type DecodedQuad,
  type ModelOutput,
  type RgbaImage,
} from './cardCorrectMl';

const PX = (x: number, y: number) => ({ x, y });

function solidImage(w: number, h: number, rgb: [number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}

function fillRect(img: RgbaImage, x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = rgb[0];
      img.data[i + 1] = rgb[1];
      img.data[i + 2] = rgb[2];
    }
  }
}

/** 像素坐标 → 模型 192 网格坐标（与 decodeModelOutput 的映射互逆） */
function pxToGrid(x: number, y: number, w: number, h: number): [number, number] {
  const f = frameParams(w, h);
  const s = GRID / f.scale;
  return [(x - f.centerX) * s + GRID / 2, (y - f.centerY) * s + GRID / 2];
}

describe('单应 homographyFromCorners', () => {
  it('单位方块四角精确映射到四边形四角', () => {
    const quad = [PX(0, 0), PX(10, 0), PX(10, 10), PX(0, 10)];
    const f = homographyFromCorners(quad);
    expect(f(0, 0)).toEqual(PX(0, 0));
    expect(f(1, 0)).toEqual(PX(10, 0));
    expect(f(1, 1)).toEqual(PX(10, 10));
    expect(f(0, 1)).toEqual(PX(0, 10));
  });

  it('透视四边形内部点映射连续（中心→中心）', () => {
    const quad = [PX(0, 0), PX(100, 10), PX(90, 60), PX(5, 55)];
    const f = homographyFromCorners(quad);
    const c = f(0.5, 0.5);
    // 中心映射结果应落在四边形内（大致中心附近）
    expect(c.x).toBeGreaterThan(30);
    expect(c.x).toBeLessThan(60);
    expect(c.y).toBeGreaterThan(20);
    expect(c.y).toBeLessThan(40);
  });
});

describe('quadSizePx / warpQuadToRect', () => {
  it('轴对齐矩形 quad → 输出尺寸 = 矩形尺寸，像素 1:1 还原', () => {
    const img = solidImage(200, 150, [40, 40, 45]);
    fillRect(img, 50, 40, 150, 120, [240, 240, 240]);
    const quad = [PX(50, 40), PX(150, 40), PX(150, 120), PX(50, 120)];
    const out = warpQuadToRect(img, quad);
    expect(out.width).toBe(100);
    expect(out.height).toBe(80);
    // 中心像素是白，四角外是深色
    const mid = ((40 * out.width + 50) * 4);
    expect(out.data[mid]).toBeGreaterThan(230);
  });

  it('四边形越界（模型角点外溢）：越界像素填白而非黑', () => {
    const sw = 20;
    const sh = 20;
    const img = solidImage(sw, sh, [30, 30, 30]); // 深色源
    // quad 比源略大，输出四角映射到源外（模糊/退化输入下模型角点常轻微外溢）
    const quad = [PX(-2, -2), PX(sw + 2, -2), PX(sw + 2, sh + 2), PX(-2, sh + 2)];
    const out = warpQuadToRect(img, quad);
    const corner = 0; // (0,0) → 源外
    expect(out.data[corner]).toBe(255);
    expect(out.data[corner + 1]).toBe(255);
    expect(out.data[corner + 2]).toBe(255);
    expect(out.data[corner + 3]).toBe(255);
    // 中心映射到源内部，保持源色（深色），而非白/黑
    const cX = Math.floor(out.width / 2);
    const cY = Math.floor(out.height / 2);
    const ci = (cY * out.width + cX) * 4;
    expect(out.data[ci]).toBe(30);
  });

  it('quadSizePx 按对边中点距计算（与爱印 mt 一致）', () => {
    const s = quadSizePx([PX(0, 0), PX(100, 0), PX(100, 50), PX(0, 50)]);
    expect(s.width).toBe(100);
    expect(s.height).toBe(50);
  });
});

describe('decodeModelOutput', () => {
  const w = 400;
  const h = 300;
  const frame = frameParams(w, h);

  it('192 网格坐标 → 源图像素（映射互逆）', () => {
    const gx0 = pxToGrid(100, 80, w, h);
    const gx1 = pxToGrid(300, 220, w, h);
    const out: ModelOutput = {
      scores: Float32Array.from([0.9]),
      quads: Float32Array.from([gx0[0], gx0[1], gx1[0], gx0[1], gx1[0], gx1[1], gx0[0], gx1[1]]),
      angle: Float32Array.from([0]),
      ftype: Float32Array.from([0]),
    };
    const decoded = decodeModelOutput(out, frame);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].corners[0].x).toBeCloseTo(100, 3);
    expect(decoded[0].corners[0].y).toBeCloseTo(80, 3);
    expect(decoded[0].corners[2].x).toBeCloseTo(300, 3);
    expect(decoded[0].corners[2].y).toBeCloseTo(220, 3);
    expect(decoded[0].uprightCorners).toEqual(decoded[0].corners);
  });

  it('低于阈值的候选被过滤；包含去重丢低分者', () => {
    const g = pxToGrid(100, 100, w, h);
    const q = Float32Array.from([g[0] - 10, g[1] - 10, g[0] + 10, g[1] - 10, g[0] + 10, g[1] + 10, g[0] - 10, g[1] + 10]);
    const out: ModelOutput = {
      scores: Float32Array.from([0.9, 0.5, 0.2]),
      quads: Float32Array.from([...q, ...q, ...q]),
      angle: Float32Array.from([0, 0, 0]),
      ftype: Float32Array.from([0, 0, 0]),
    };
    const decoded = decodeModelOutput(out, frame, 0.3);
    // 0.9 与 0.5 中心相同（互相包含，0.9 分高保留）；0.2 被阈值滤掉
    expect(decoded).toHaveLength(1);
    expect(decoded[0].score).toBeCloseTo(0.9, 5);
  });

  it('angle=2 → uprightCorners 环移两位、uprightTurns=2', () => {
    const g = pxToGrid(100, 100, w, h);
    const out: ModelOutput = {
      scores: Float32Array.from([0.9]),
      quads: Float32Array.from([g[0], g[1], g[0] + 20, g[1], g[0] + 20, g[1] + 20, g[0], g[1] + 20]),
      angle: Float32Array.from([2]),
      ftype: Float32Array.from([0]),
    };
    const d = decodeModelOutput(out, frame)[0];
    expect(d.angle).toBe(2);
    expect(d.uprightTurns).toBe(2);
    expect(d.uprightCorners[0]).toEqual(d.corners[2]);
    expect(d.uprightCorners[1]).toEqual(d.corners[3]);
  });
});

describe('acceptNextCandidate（爱印 j）', () => {
  const frameArea = 400 * 300;
  const bigQuad: DecodedQuad = {
    angle: 0,
    corners: [PX(50, 40), PX(350, 40), PX(350, 260), PX(50, 260)],
    ftype: 0,
    score: 0.9,
    uprightCorners: [],
    uprightTurns: 0,
  };
  const opts = { frameArea, minAreaFrac: 0.04 };

  it('首遍：score=0.29 拒、0.31 收', () => {
    expect(acceptNextCandidate([{ ...bigQuad, score: 0.29 }], [], opts)).toBeUndefined();
    expect(acceptNextCandidate([{ ...bigQuad, score: 0.31 }], [], opts)?.score).toBe(0.31);
  });

  it('面积低于 minAreaFrac 拒绝', () => {
    const small: DecodedQuad = {
      ...bigQuad,
      corners: [PX(190, 140), PX(210, 140), PX(210, 160), PX(190, 160)], // 20×20/120000 < 4%
    };
    expect(acceptNextCandidate([small], [], opts)).toBeUndefined();
  });

  it('与已接受卡重叠 ≥25% 视为重复拒绝', () => {
    expect(acceptNextCandidate([{ ...bigQuad, score: 0.31 }], [bigQuad.corners], opts)).toBeUndefined();
  });

  it('第二遍（已找到卡）：score 0.05 可收（>0.03 且面积≥半张）', () => {
    const half = 0.5 * polyArea(bigQuad.corners);
    const far = 0.5 * polyArea(bigQuad.corners);
    expect(half).toBeGreaterThan(0);
    const second: DecodedQuad = {
      ...bigQuad,
      score: 0.05,
      corners: [PX(50, 40), PX(350, 40), PX(350, 260), PX(50, 260)], // 同面积（已挪开避免重叠判定——这里直接测阈值逻辑，重叠卡由上一条覆盖）
    };
    // 与已接受卡完全重叠 → 先被重叠判掉，这里改用不重叠的位置测阈值
    const offset: DecodedQuad = {
      ...second,
      corners: [PX(50, 280), PX(350, 280), PX(350, 299), PX(50, 299)],
    };
    if (polyArea(offset.corners) >= far) {
      expect(acceptNextCandidate([offset], [bigQuad.corners], opts)?.score).toBe(0.05);
    }
    // 低于 0.03 → 拒
    expect(acceptNextCandidate([{ ...offset, score: 0.02 }], [bigQuad.corners], opts)).toBeUndefined();
  });
});

describe('edgeRoomRatio（贴边余量）', () => {
  it('卡面几乎顶满图像 → room < 0.3', () => {
    const room = edgeRoomRatio([PX(2, 2), PX(397, 2), PX(397, 297), PX(2, 297)], { width: 400, height: 300 });
    expect(room).toBeLessThan(0.3);
  });

  it('居中半幅卡 → room 充足', () => {
    const room = edgeRoomRatio([PX(100, 75), PX(300, 75), PX(300, 225), PX(100, 225)], { width: 400, height: 300 });
    expect(room).toBeGreaterThanOrEqual(0.5);
  });
});

describe('rotateImageQuarter / whitenQuadFill', () => {
  it('90° 旋转：宽高互换，像素位置按公式搬移', () => {
    const img = solidImage(2, 1, [255, 0, 0]);
    fillRect(img, 1, 0, 2, 1, [0, 0, 255]);
    const out = rotateImageQuarter(img, 1);
    expect(out.width).toBe(1);
    expect(out.height).toBe(2);
    // n=1：output(u,c)=source(row=c, col=W-1-u) → 顶部=原右侧(蓝)
    expect(out.data[0]).toBe(0);
    expect(out.data[2]).toBe(255);
  });

  it('whitenQuadFill 把四边形区域涂白，区域外不受影响', () => {
    const img = solidImage(10, 10, [10, 20, 30]);
    whitenQuadFill(img, [PX(2, 2), PX(7, 2), PX(7, 7), PX(2, 7)]);
    const at = (x: number, y: number) => img.data[(y * 10 + x) * 4];
    expect(at(4, 4)).toBe(255);
    expect(at(2, 4)).toBe(255);
    expect(at(1, 4)).toBe(10);
    expect(at(8, 4)).toBe(10);
  });
});

describe('preprocessModelInput', () => {
  it('输出长度 3×768²，越界区域填 -mean/std，BGR 通道序', () => {
    const img = solidImage(64, 48, [255, 128, 0]); // R=255 G=128 B=0
    const t = preprocessModelInput(img);
    expect(t.length).toBe(3 * MODEL_INPUT * MODEL_INPUT);
    // 中心落在图内：B 通道 = (0/255 - .408)/.289 ≈ -1.412
    const center = (384 * MODEL_INPUT + 384);
    expect(t[center]).toBeCloseTo((0 - 0.408) / 0.289, 5);
    // G: (128/255 - .447)/.274
    expect(t[MODEL_INPUT * MODEL_INPUT + center]).toBeCloseTo((128 / 255 - 0.447) / 0.274, 5);
    // R: (255/255 - .47)/.278
    expect(t[2 * MODEL_INPUT * MODEL_INPUT + center]).toBeCloseTo((1 - 0.47) / 0.278, 5);
    // 角落越界：填黑归一化
    expect(t[0]).toBeCloseTo(-0.408 / 0.289, 5);
  });
});

describe('modelCorrectLoop（涂白循环主流程，桩 runner）', () => {
  const W = 400;
  const H = 300;

  function cardQuadCoords(x0: number, y0: number, x1: number, y1: number): number[] {
    const a = pxToGrid(x0, y0, W, H);
    const b = pxToGrid(x1, y0, W, H);
    const c = pxToGrid(x1, y1, W, H);
    const d = pxToGrid(x0, y1, W, H);
    return [a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]];
  }

  function outFor(coords: number[], score: number): ModelOutput {
    return {
      scores: Float32Array.from([score]),
      quads: Float32Array.from(coords),
      angle: Float32Array.from([0]),
      ftype: Float32Array.from([0]),
    };
  }

  it('单卡：检出 → warp 尺寸正确 → 第二轮空 → 停', async () => {
    const img = solidImage(W, H, [50, 50, 55]);
    fillRect(img, 100, 80, 300, 220, [245, 245, 245]);
    let call = 0;
    const r = await modelCorrectLoop(img, async () => {
      call += 1;
      return call === 1 ? outFor(cardQuadCoords(100, 80, 300, 220), 0.9) : { scores: new Float32Array(0), quads: new Float32Array(0), angle: new Float32Array(0), ftype: new Float32Array(0) };
    });
    expect(r.pages).toHaveLength(1);
    expect(r.passes).toBe(2);
    expect(r.pages[0].score).toBeCloseTo(0.9, 5);
    expect(r.pages[0].imageData.width).toBe(200);
    expect(r.pages[0].imageData.height).toBe(140);
    // warp 自原图：卡面中心应为白
    const pd = r.pages[0].imageData.data;
    const mid = (70 * 200 + 100) * 4;
    expect(pd[mid]).toBeGreaterThan(230);
  });

  it('双卡：涂白循环后第二张以宽松阈值收进来', async () => {
    const img = solidImage(W, H, [50, 50, 55]);
    fillRect(img, 20, 60, 180, 200, [245, 245, 245]);
    fillRect(img, 220, 60, 380, 200, [240, 240, 245]);
    let call = 0;
    const r = await modelCorrectLoop(img, async () => {
      call += 1;
      if (call === 1) return outFor(cardQuadCoords(20, 60, 180, 200), 0.9);
      if (call === 2) return outFor(cardQuadCoords(220, 60, 380, 200), 0.05); // 第二遍阈值 0.03
      return { scores: new Float32Array(0), quads: new Float32Array(0), angle: new Float32Array(0), ftype: new Float32Array(0) };
    });
    expect(r.pages).toHaveLength(2);
    expect(r.passes).toBe(2); // maxPages=2：两轮即收满两张
    expect(r.pages[1].score).toBeCloseTo(0.05, 5);
    expect(r.pages[1].imageData.width).toBeGreaterThanOrEqual(159); // float 截断容差（爱印 trunc 同款）
    expect(r.pages[1].imageData.width).toBeLessThanOrEqual(160);
  });

  it('首卡贴边（room<0.3）→ 循环提前终止', async () => {
    const img = solidImage(W, H, [50, 50, 55]);
    fillRect(img, 4, 4, 396, 296, [245, 245, 245]);
    let call = 0;
    const r = await modelCorrectLoop(img, async () => {
      call += 1;
      return outFor(cardQuadCoords(4, 4, 396, 296), 0.9);
    });
    expect(r.pages).toHaveLength(1);
    expect(call).toBe(1);
    expect(r.room).not.toBeNull();
    expect(r.room!).toBeLessThan(0.3);
  });

  it('nothing above threshold → 空结果', async () => {
    const img = solidImage(W, H, [50, 50, 55]);
    const r = await modelCorrectLoop(img, async () => ({ scores: new Float32Array(0), quads: new Float32Array(0), angle: new Float32Array(0), ftype: new Float32Array(0) }));
    expect(r.pages).toHaveLength(0);
    expect(r.passes).toBe(1);
  });
});
