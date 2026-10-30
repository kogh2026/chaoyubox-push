/**
 * 抠图引擎的**类型与默认值** —— 单独一个模块，只为一件事：让「默认是哪个引擎」只有一处真相。
 *
 * 为什么不能放在 `mattingPool.ts`：那个模块顶部 import 了 `@imgly` 与 `matting.worker`，
 * 任何想读默认值的地方（设置默认表、面板、存档迁移）都会被拖进整条推理链。
 * 这里只有一个联合类型和一个字符串常量，谁都能安全引。
 */

/** 抠图引擎：isnet=@imgly ISNet（发丝精细、慢）；modnet=本地 MODNet（证件照专用、快） */
export type MatteEngine = 'isnet' | 'modnet';

/**
 * 出厂默认引擎 = **快速（MODNet）**。
 *
 * 理由：图文店一次导几十张，MODNet 比 ISNet 快约 6 倍（实测 50 张 45s vs 288s）；
 * 证件照是「纯色底 + 半身」场景，两者发丝精度差异肉眼几乎不可辨，
 * 而卡住两分钟是用户当场就能感觉到的。要更精细就在面板切「精细」。
 */
export const DEFAULT_MATTE_ENGINE: MatteEngine = 'modnet';

/** 合法取值域（存档校验 / 测试用，避免各处再写一遍字面量数组） */
export const MATTE_ENGINES: readonly MatteEngine[] = ['isnet', 'modnet'] as const;
