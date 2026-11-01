// 证件类型自动识别（P1-B）：本地 Tesseract OCR（chi_sim 语言包预装在安装包内，离线可用）。
// 只做「这是哪类证件」的粗分类 —— 不做字段抽取，识别结果作为拼版类型的默认值，用户可随时改。
import type { Worker } from 'tesseract.js';

export type CardTypeId = 'idcard' | 'hukou' | 'passport' | 'drive' | 'other';

export interface OcrResult {
  text: string;
  /** 命中的类型；拿不准时返回 other */
  type: CardTypeId;
  /** 命中的关键词（调试与提示用） */
  hits: string[];
}

/** 预装资源根（桌面端 appres://；浏览器环境 undefined → 走 tesseract 官方 CDN） */
function resBase(): string | undefined {
  const base =
    typeof window !== 'undefined'
      ? (window as unknown as { electronAPI?: { appResBase?: string } }).electronAPI?.appResBase
      : undefined;
  return typeof base === 'string' && base ? base : undefined;
}

let workerPromise: Promise<Worker> | null = null;

/** 取一个常驻 OCR Worker：模型只加载一次，批量识别复用同一会话。 */
export function getOcrWorker(): Promise<Worker> {
  if (!workerPromise) {
    // tesseract.js 体积大（wasm + chi_sim 语言包），改成「首次用到 OCR 时才动态加载」，
    // 不进主包、不随 App 启动加载 —— 符合「按需加载」。函数签名保持同步返回 Promise，
    // 现有调用方（内部 cardOcr 逻辑）无需改动。
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      const base = resBase();
      const opts = base
        ? {
            workerPath: `${base}tesseract/worker.min.js`,
            corePath: `${base}tesseract`,
            langPath: `${base}tesseract`,
            gzip: false,
          }
        : undefined;
      return createWorker('chi_sim', 1, opts);
    })().catch((e) => {
      workerPromise = null; // 失败允许重试
      throw e;
    });
  }
  return workerPromise;
}

/** 释放 OCR Worker（切页/退出时调用；下次识别会自动重建） */
export async function disposeOcrWorker(): Promise<void> {
  const p = workerPromise;
  workerPromise = null;
  if (!p) return;
  try {
    const w = await p;
    await w.terminate();
  } catch {
    /* 已经挂了就算了 */
  }
}

/**
 * 关键词表：按「命中权重」排序，先匹配更具体的证件。
 * 只要命中任意关键词即判定，置信度用命中数量粗判（≥2 视为可信）。
 */
const RULES: { type: CardTypeId; kws: string[] }[] = [
  {
    type: 'idcard',
    kws: ['居民身份证', '公民身份号码', '签发机关', '有效期限', '中华人民共和国居民身份证'],
  },
  {
    type: 'passport',
    kws: ['PASSPORT', '护照', '中华人民共和国护照', 'Type/P', '签发地点'],
  },
  {
    type: 'drive',
    kws: ['机动车驾驶证', '准驾车型', '驾驶证', '初次领证日期', '累积记分'],
  },
  {
    // 注意：'住址' 是身份证/驾驶证共有的字段，不能作为户口本判据（会误判）
    type: 'hukou',
    kws: ['常住人口登记卡', '户口簿', '与户主关系', '户别', '户主或与户主关系'],
  },
  { type: 'other', kws: ['社会保障卡', '营业执照', '结婚证', '银行卡', '统一社会信用代码'] },
];

/** 纯函数（可单测）：OCR 文本 → 证件类型。 */
export function classifyCardType(text: string): { type: CardTypeId; hits: string[] } {
  const norm = (text || '').replace(/\s+/g, '').toUpperCase();
  for (const r of RULES) {
    const hits = r.kws.filter((k) => norm.includes(k.replace(/\s+/g, '').toUpperCase()));
    if (hits.length > 0) return { type: r.type, hits };
  }
  return { type: 'other', hits: [] };
}

/**
 * 识别一张证件照的文本并给出类型。
 * 输入用 dataURL/对象 URL 字符串最稳（图像已加载过的卡片可直接传它）。
 */
export async function recognizeCardType(image: string): Promise<OcrResult> {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(image);
  const text = data?.text ?? '';
  const { type, hits } = classifyCardType(text);
  return { text, type, hits };
}
