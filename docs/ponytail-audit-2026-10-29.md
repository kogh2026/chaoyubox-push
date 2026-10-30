# 全仓过度设计审计报告（ponytail-audit）

- 仓库：`aiyinbox-clone`（超誉工作台，Electron 45 + React 18 + TS）
- 审计时间：2026-10-29
- 审计范围：`src/**` 全部 96 个 `.ts/.tsx/.css` 文件（28,823 行）+ `package.json` 依赖表 + `vite.config.ts` 入口配置
- 规则集：ponytail-audit 六类标签 `delete / stdlib / native / reuse / yagni / shrink`
- 边界：只审「过度设计与复杂度」；正确性、安全、性能不在本次范围

---

## 一、检查方法与覆盖

不靠肉眼通读，先用可复现的机械扫描缩小范围，再对每个候选**回归验证引用**（含测试、fixture、字符串与动态引用），最后逐条修复。

| 检查项 | 方法 | 结果 |
|---|---|---|
| 依赖是否真被使用 | 11 个 runtime 依赖逐个 grep `import/require` | **11/11 均在用**，无多余依赖 |
| 零引用导出 | 脚本遍历所有 `export`，统计跨文件引用（区分生产/测试） | 257 项，人工过滤后有效 14 项 |
| 孤儿模块 | 脚本按文件名反查 import，再人工验证动态引用 | 7 项 → 真死 3 项、动态引用 1 项、ambient 2 项 |
| 非导出函数是否被调用 | 同文件引用计数 | 0 项（`noUnusedLocals/noUnusedParameters` 已开启，编译器兜住） |
| 重复实现 | 同名函数跨文件统计 + 常见工具函数定点 grep | `clamp`、`loadImage`、`combineXxxMask`、`framingSpec` 构造 |
| 遗留标记 | `TODO/FIXME/HACK/console.log` | 0 项 |
| 类型逃逸 | `as unknown as` 计数 | 生产代码 12 处（均为第三方 API 边界，合理） |
| 投机性配置 | 字段是否有生产者（`maskProvider`、`ladderTiers`、`SEARCH_MARGIN` 等） | 2 项无生产者 |

> 说明：`warpWorker.ts`、`matting.worker.ts` 静态扫不出引用，但存在 `new Worker(new URL('./x.ts', import.meta.url))` 动态加载，**不是死代码**，已排除。

---

## 二、发现与修复清单（按删减量排序）

### 1. `delete:` `src/lib/idphotoMattingSession.ts` + 其测试 —— 严重度 高
127 + 131 行。全仓无任何生产引用（仅自身测试 import）。它是「matting 会话工厂」，把线程策略落到 ORT 配置；但真正生效的线程配额已由 `mattingPool.matteThreads()` 实现，worker 也自行调 `ort.InferenceSession.create`。**已删除**。

### 2. `delete:` `src/lib/idphotoSkinRetouch.ts` 的 `retouchSkin` + `surfaceSmoothLayer` —— 严重度 高
118 行（144 → 26）。这两个函数是「掩码驱动保真平滑」的早期参考实现，只有自己的测试在调；生产匀肤实际走 `idphotoRetouch.smoothSkinGuided / reduceShine`（引导滤波 + 特征保护）。文件只保留真正被用的 `ycbcrSkinMask` + `SkinMaskProvider`。**已删除**，测试同步从 105 行裁到 19 行。

### 3. `delete:` `src/lib/selfieMulticlassMask.ts` 的 multiclass 皮肤掩码支线 —— 严重度 高
107 行（423 → 316）。`retouchSkinWithMulticlass`、`createMulticlassSkinMaskProvider`、`combineSkinConfidence`、`CombineSkinOpts`、`ProviderOpts`、`CanvasFactory` 六个符号**只有测试引用**——这条「用 multiclass face-skin 通道做匀肤」的路径从未接入 UI。同文件的「人物掩码 + 下半身定位」才是真在用的部分，保留。**已删除**（测试 343 → 172 行）。

### 4. `delete:` `src/lib/store.ts` —— 严重度 高
50 行。预设（Preset）读写模块，零引用；预设的真实存储在 `appSettings`（含 v0→v1 迁移），此文件是早期遗留。**已删除**。

### 5. `delete:` `src/tools/PdfToolbox.tsx` —— 严重度 中
58 行。零引用，功能已被 `src/tools/pdf/PdfTools.tsx`（40 项功能）取代，只剩一个 58 行的空壳组件。**已删除**。

### 6. `yagni:` `maskProvider` 注入缝（跨 3 文件）—— 严重度 中
`MaskSource`/retouch 选项里留了 `maskProvider?: SkinMaskProvider`，默认 `ycbcrSkinMask`，注释写着「可传 selfie-multiclass」——但**全仓没有任何生产者**（第 3 条删除后更确定），属于典型「配置没人设」的投机扩展点，还会误导后来者以为 multiclass 匀肤可用。`idphotoRetouch.ts`、`idphotoRetouchDom.ts`、`idphotoSkinRetouch.ts` 三处共 6 行**已删除**。

### 7. `delete:` 恒不可达的 `estimated` 链条 —— 严重度 中
`IdPhoto` 的 `activeFraming.estimated` 只在赋值处写死 `false`，经 `headTopEstimated` prop 传给 `SpecFramingPanel`，面板再单独渲染一个「头顶为估算」`<li>`——与 `verifyFraming` 内部 `warnings` 的同一告警**两条路径并存且永远不触发**。已收敛为单一路径：删掉 state 字段、prop 与面板分支，告警统一由 `verifyFraming(metrics, spec, headTopEstimated)` 产出。`specFraming` 侧第三个参数保留（有测试覆盖）。

### 8. `reuse:` `IdPhoto` 内联构造 `FramingSpec` —— 严重度 中
`IdPhoto.tsx` 用 11 行 useMemo 手拼 `{mmW,mmH,pxW,pxH,topRatio: preset.topRatio ?? 0.08, ...}`，而 `cardLayout.framingSpecOf(preset, dpi)` 做的是**完全相同**的事，且自动构图与多尺寸导出已经在用它。三份默认比例（0.08/0.64/0.035）各写一遍，改规格必然漂移。**已改为 `useMemo(() => framingSpecOf(preset, 300), [preset])`**，并移除失效的 `DEFAULT_RATIOS` 导入。

### 9. `reuse:` `uiScale.ts` 私有 `clamp` —— 严重度 低
`math.min(hi, max(lo,n))` 第 4 份拷贝。`imageFilters.ts` 的 `clamp` 已被 `idphotoSkinRetouch`/`retouch` 共用，且该模块**零 import、纯函数**，引它不会把图像代码拖进几何模块。**已改为 `import { clamp } from './imageFilters'`**。

### 10. `delete:` `specFraming.ts` 的 `SEARCH_MARGIN` —— 严重度 低
`export const SEARCH_MARGIN = 0.125; // 记录用，直接解算不需要`——注释自己承认没人用。**已删除**。

### 11. `shrink:` `specFraming.ts` 的多余导出与回显字段 —— 严重度 低
- `FramingRatios`、`SpecPlacementResult` 只在本文件内被派生/返回，对外零引用 → **取消 export**（保留类型本身）。
- `specAutoPlacement` 返回值里的 `headCx`/`headTop` 是把入参 `head.cx`/`head.top` 原样回传，调用方本来就有 `head` → **已删除这两个字段**。`personBelowFrac`/`bottomInsufficient`/`bottomAnchorScale` 是测试断言的行为契约，保留。

---

## 三、明确「不修」的项（附理由）

| # | 项 | 为何不修 |
|---|---|---|
| A | `idphotoMatting.ts`（222 行）在删除第 1 条后成为孤儿：`matting.worker.ts` 内联重写了它的 MODNet 预处理（32 的倍数、短边 512、`executionProviders/graphOptimizationLevel`）与线程策略 | 正确的修法是让 worker **复用**该模块，但抠图是这对项目里被基准测过的最敏感路径（50 张 294s/47.7s 的结论全建立在此），盲改预处理属于「没量就改」。本次只记录，建议单独一轮带 `tools/bench_batch50.py` 回归再做。**该模块同时是逆向规格的唯一样本 + 20 余项测试载体，不宜直接删。** |
| B | 双 PDF 引擎并存（`jspdf` 4 处 vs `pdf-lib` 15 处） | 收敛需替换打印/设置页的栅格与文档生成，属跨模块重构；且两者能力不完全重叠（jspdf 的打印路径更轻）。留待专项。 |
| C | `loadImage` 在 4 个文件各有一份 | 签名与返回值**都不同**（`HTMLImageElement` / `CardItem` / `LoadedImg`），是三个不同的适配器，不是重复。 |
| D | `ManualCropModal.clamp01(v, lo=0.01, hi=0.99)` 与 `imageFilters.clamp01` | 默认值不同、语义不同（裁剪安全区），合并会引入隐式耦合。 |

---

## 四、验证

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | 通过（0 错误） |
| `npm test` | **584 passed / 3 skipped**（40 文件全绿；较审计前 611 减少 27 项，均为被删功能的测试） |
| `vite build` | 成功（24.5s） |
| 界面冒烟（真实 Chromium 加载构建产物） | `PREVIEW_OK`：标题正确、7 规格渲染、默认勾 1、面板含「下方判定/放大填满」、0 console 错误 |

## 五、净变化

| 项 | 数量 |
|---|---|
| 删除文件 | 4 个（`store.ts`、`idphotoMattingSession.ts` + 测试、`PdfToolbox.tsx`） |
| 生产代码净减 | **−874 行**（4,016 → 3,142，含测试） |
| 其中生产行 | −505 行；测试行 −369 行 |
| 可减少的依赖 | 0（11 个依赖全部在用） |

回滚：改动前的原始文件已备份到 `.tmp/audit-backup/`（`lib/` 11 个、`tools/` 2 个）。
