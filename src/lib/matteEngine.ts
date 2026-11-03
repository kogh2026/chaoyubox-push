/**
 * 抠图引擎的**类型与默认值** —— 单独一个模块，只为一件事：让「默认是哪个引擎」只有一处真相。
 *
 * 为什么不能放在 `mattingPool.ts`：那个模块顶部 import 了 `@imgly` 与 `matting.worker`，
 * 任何想读默认值的地方（设置默认表、面板、存档迁移）都会被拖进整条推理链。
 * 这里只有一个联合类型和一个字符串常量，谁都能安全引。
 */

/**
 * 抠图引擎：
 * - `modnet`         = 本地 MODNet（证件照专用、快）
 * - `modnet-refine`  = MODNet + 边缘精修（发丝去底色晕边，**当前推荐**）
 * - `isnet`          = @imgly ISNet（保留仅为兼容老存档，界面不再展示）
 */
export type MatteEngine = 'isnet' | 'modnet' | 'modnet-refine';

/**
 * 出厂默认引擎 = **MODNet + 边缘精修**。
 *
 * 理由（均为本机实测，见 docs/matting-vs-aiyin.md 与 docs/v4-edge-refine.md）：
 * 1. MODNet 与爱印的 matting-v1 **同款模型**（ONNX 结构逐项一致），51 张真实证件照
 *    上与爱印的 IoU = 0.9984，50/51 张 > 0.99 —— 主体一致性已经超越爱印。
 * 2. ISNet 在证件照上反而更差：IoU 仅 0.9788，12/51 张 < 0.90（最差 0.456，
 *    漏抠 54% 前景），且 0/51 张优于 MODNet。它是通用显著目标分割模型，
 *    对「背景干净、主体占比大」的证件照会误判浅色衣物为背景。
 * 3. 边缘精修（颜色解混）能消除发丝处残留的原底色晕边，代价远小于换模型。
 *
 * 所以「精细」不再是「换一个更重的模型」，而是「同一个快模型 + 边缘精修」。
 */
export const DEFAULT_MATTE_ENGINE: MatteEngine = 'modnet-refine';

/** 合法取值域（存档校验 / 测试用，避免各处再写一遍字面量数组） */
export const MATTE_ENGINES: readonly MatteEngine[] = ['isnet', 'modnet', 'modnet-refine'] as const;

/**
 * 界面展示用的引擎选项。
 *
 * 为什么不直接把 `isnet` 拿掉：老用户存档里存着 `engine: 'isnet'`，
 * 直接删枚举值会让存档读不出来（normalize 会把非法值丢成默认值，
 * 表现是「用户选的东西被悄悄改掉」）。所以值保留、界面隐藏，
 * 由 `idphotoOptionsStorage` 的迁移逻辑把老存档的 isnet 归一到 modnet-refine。
 */
export const MATTE_ENGINE_UI: readonly { id: MatteEngine; label: string; hint: string }[] = [
  { id: 'modnet-refine', label: 'MODNet + 边缘精修', hint: '发丝去底色晕边，推荐' },
  { id: 'modnet', label: '快速', hint: '不精修边缘，最快' },
] as const;

/** 该引擎是否需要边缘精修（modnet-refine 需要） */
export function engineNeedsRefine(e: MatteEngine): boolean {
  return e === 'modnet-refine';
}

/**
 * 引擎对应的 Worker 推理引擎名。
 *
 * `modnet-refine` 在**推理阶段**就是 MODNet —— 边缘精修是推理之后的像素运算，
 * 不需要另跑一个模型。返回 'modnet' 让 Worker 走本地 ONNX（快、无授权依赖）。
 */
export function engineWorkerName(e: MatteEngine): 'isnet' | 'modnet' {
  return e === 'isnet' ? 'isnet' : 'modnet';
}
