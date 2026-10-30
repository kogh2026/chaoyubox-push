// 异常照片检测（P2）：补齐"爱印"式的自动不合格识别与文字原因。
// 全部为纯函数，便于单测；在 IdPhoto 抠图完成后对每张原图跑一遍，给出可解释的原因。
// 检测项：①分辨率不足 ②过亮/过暗 ③背景不纯 ④构图偏移/角度偏转（基于抠图蒙版的轻量代理）。

export type IssueLevel = 'warn' | 'error';

export interface PhotoIssue {
  level: IssueLevel;
  code: string;
  reason: string;
}

/** 短标签：用于缩略图角标；完整原因放 title 提示 */
export const ISSUE_LABEL: Record<string, string> = {
  resolution: '分辨率不足',
  overexposed: '过亮',
  underexposed: '过暗',
  background: '背景不纯',
  framing: '构图偏移',
  angle: '角度偏移',
};

/** ① 分辨率：原图短边相对目标规格的充足度（@300DPI 的目标像素） */
export function inspectResolution(
  natW: number,
  natH: number,
  pxW: number,
  pxH: number,
): PhotoIssue | null {
  const minSrc = Math.min(natW, natH);
  const minDst = Math.min(pxW, pxH);
  if (minSrc <= 0 || minDst <= 0) return null;
  if (minSrc < minDst * 0.8) {
    return {
      level: 'warn',
      code: 'resolution',
      reason: `原图分辨率偏低（${natW}×${natH}），低于证件照所需的 ${pxW}×${pxH}px，放大后易模糊`,
    };
  }
  return null;
}

/** ② 曝光：灰度均值越界 */
export function inspectExposure(meanL: number): PhotoIssue | null {
  if (meanL > 225) {
    return {
      level: 'warn',
      code: 'overexposed',
      reason: '照片过亮（疑似白底反光/曝光过度），换底后人物边缘可能发灰',
    };
  }
  if (meanL < 35) {
    return {
      level: 'warn',
      code: 'underexposed',
      reason: '照片过暗（疑似逆光/欠曝），人像细节易丢失',
    };
  }
  return null;
}

/** ③ 背景纯净度：四边采样区灰度标准差过大 → 非纯色背景 */
export function inspectBackground(edgeStd: number): PhotoIssue | null {
  if (edgeStd > 28) {
    return {
      level: 'warn',
      code: 'background',
      reason: '原图背景不纯（非纯色），自动换底可能残留杂色或毛边，建议手动抠图',
    };
  }
  return null;
}

/** ④ 构图/角度：水平重心偏移 + 上下重心横向错位（代理"角度偏转"，无需人脸模型） */
export function inspectFraming(xOff: number, tiltOff: number): PhotoIssue | null {
  if (Math.abs(xOff) > 0.12) {
    return {
      level: 'warn',
      code: 'framing',
      reason: `人物偏离中心（水平偏移 ${(xOff * 100).toFixed(0)}%），可用取景框左右微调构图`,
    };
  }
  if (Math.abs(tiltOff) > 0.08) {
    return {
      level: 'warn',
      code: 'angle',
      reason: '上下半身重心横向错位偏大，可能存在人脸角度偏转，建议检查或更换照片',
    };
  }
  return null;
}

/** 汇总：把各项检测结果拼成数组（过滤空项，保持顺序稳定） */
export function inspectAll(m: {
  natW: number;
  natH: number;
  pxW: number;
  pxH: number;
  meanL: number;
  edgeStd: number;
  xOff: number;
  tiltOff: number;
}): PhotoIssue[] {
  return [
    inspectResolution(m.natW, m.natH, m.pxW, m.pxH),
    inspectExposure(m.meanL),
    inspectBackground(m.edgeStd),
    inspectFraming(m.xOff, m.tiltOff),
  ].filter((x): x is PhotoIssue => x !== null);
}

// ---------- 指标提取（纯函数，输入为降采样后的像素数据） ----------

/** 灰度均值（0~255），用于曝光判定 */
export function meanLuminance(data: Uint8ClampedArray): number {
  let sum = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    // 经典亮度公式
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return n > 0 ? sum / n : 0;
}

/** 四边采样区灰度标准差，用于背景纯净度 */
export function edgeColorStd(data: Uint8ClampedArray, w: number, h: number): number {
  const xs: number[] = [];
  const band = Math.max(1, Math.floor(Math.min(w, h) * 0.12));
  const lum = (i: number) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < band; y++) {
      xs.push(lum((y * w + x) * 4)); // 上边
      xs.push(lum(((h - 1 - y) * w + x) * 4)); // 下边
    }
  }
  for (let y = band; y < h - band; y++) {
    for (let x = 0; x < band; x++) {
      xs.push(lum((y * w + x) * 4)); // 左边
      xs.push(lum((y * w + (w - 1 - x)) * 4)); // 右边
    }
  }
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
  return Math.sqrt(variance);
}

/**
 * 从抠图 alpha 蒙版（0~255）求构图指标：
 * - xOff：前景重心相对画布中心的水平偏移（-0.5~0.5）
 * - tiltOff：上 30% 与下 30% 前景重心横向错位 / 宽（代理角度偏转）
 */
export function framingMetrics(
  alpha: Uint8ClampedArray,
  w: number,
  h: number,
  th = 40,
): { xOff: number; tiltOff: number } {
  let sx = 0;
  let sy = 0;
  let count = 0;
  let topSx = 0;
  let topCount = 0;
  let botSx = 0;
  let botCount = 0;
  const topBand = Math.max(1, Math.floor(h * 0.3));
  const botStart = h - topBand;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = alpha[y * w + x];
      if (a <= th) continue;
      sx += x;
      sy += y;
      count += 1;
      if (y < topBand) {
        topSx += x;
        topCount += 1;
      } else if (y >= botStart) {
        botSx += x;
        botCount += 1;
      }
    }
  }
  if (count === 0) return { xOff: 0, tiltOff: 0 };
  const cx = sx / count / w - 0.5;
  const topCx = topCount > 0 ? topSx / topCount / w - 0.5 : 0;
  const botCx = botCount > 0 ? botSx / botCount / w - 0.5 : 0;
  return { xOff: cx, tiltOff: topCx - botCx };
}
