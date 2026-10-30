# IdPhoto.tsx 拆分方案与迁移步骤

> 配套报告：`architecture-review-20261029-idphoto.html`（在系统临时目录，未入库）
> 起点：`src/tools/IdPhoto.tsx` 2,075 行 / 43 处 `useState`（其中 25 个是设置项）/ 7 个 `useEffect` /
> 0 个覆盖编排层的测试。
> 终态（七步全部完成）：**1,092 行** / 18 处 `useState`（全是运行时状态）/ 1 个 `PhotoOptions` +
> reducer / 右栏 prop 63 → 22 / 编排层测试 0 → 74 条 + 13 项接线断言。

## 一、为什么拆

现有分层是「纯函数库很干净，组件里的编排很脏」：

| 层 | 代表文件 | 状态 |
| --- | --- | --- |
| 纯逻辑 | `specFraming` `cardLayout` `faceFrame` `matting` `idphotoRetouch` `exporter` | 584 个用例守着 |
| 编排 | `IdPhoto.tsx` 的 effect / `exportAll` | 无测试，靠手点 |
| UI | `IdPhoto.tsx` 614 行 JSX + `FramingEditor` + `SpecFramingPanel` | 可读性差 |

最硬的证据：**合成管线写了两遍**——预览 effect（612-705）与多尺寸导出（770-845）各自实现
「匀肤 → 失败回退经典美颜 → 构缓存键 → buildPersonLayer → compositeLayer → 错误收集」，
只差分辨率与取消标志。上一轮 `placements` 丢 `zoom` 的隐患就是这种双份实现的典型产物。

## 二、目标结构

新增 3 个 lib 模块，组件只留状态与视图：

```
src/lib/
  idphotoCompose.ts     合成管线：composeOne / composeMany（分辨率、缓存键、回退、错误收集）
  idphotoOptions.ts     PhotoOptions 对象 + reducer（26 处状态收成 1 个可序列化对象）
  idphotoFramingFlow.ts 构图决策：ensureFrameData + placements 计算（分割器作 adapter 注入）
src/tools/idphoto/
  IdPhotoLeft.tsx       左栏：导入 + 缩略图网格（约 300 行 JSX）
  IdPhotoRight.tsx      右栏：规格 / 构图 / 导出（约 260 行 JSX）
  FramingEditor.tsx     从 IdPhoto.tsx 1655-2075 原样搬出
```

依赖方向保持单向：`组件 → lib`，lib 不 import 组件，也不碰 DOM（`deps` 注入）。

## 三、迁移步骤

每步都满足三条硬约束：**行为不变**、**可单独回滚**、**先补测试再搬代码**。

### 步骤 1｜先钉住「导出产物」的行为（已完成，2026-10-29）

原计划是在 `src/lib/idphotoCompose.test.ts` 里用 `vi.mock` 断言调用参数。**执行时发现行不通**：
合成管线写在组件 effect 里，没有可 import 的边界 —— 对着 effect 写单测等于把逻辑抄一遍，
抄出来的测试只能证明抄得对，不能守护真实代码。改成在**真实产物的边界**上做特征测试。

- `tools/export_characterization.py`（`npm run verify:export`）：静态服务 + 真实 Chromium，
  浏览器里跑通「导入演示照片 → 抠图 → 单规格导出 → 多规格导出」，拦截 `<a download>`
  与 `createObjectURL` 取回字节，断言导出文件本身：

  | 断言 | 锁住的回归 |
  | --- | --- |
  | 单规格 2 份 / 多规格 4 份 | 份数丢漏、规格没展开 |
  | 文件名带规格名 | 命名退化 |
  | 每张像素尺寸 = 该规格 @300DPI | 尺寸串档（把 A 规格的图画到 B 规格） |
  | 同一照片在两个规格下产出两种尺寸 | 「多尺寸」退化成缩放/复制 |
  | 全部 300 DPI、全部 JPEG | P0 的 DPI 写入被回退 |
  | 与基线一致 | 任一上述行为的漂移 |

  基线 `.characterization/idphoto-export.json` 入库；行为有意变更时 `--update` 重写。
- 单测侧补一条针对性护栏（`matting.compose.test.ts`）：`personLayerKey` 必须随
  `zoom` / `rotation` 变化 —— 对应历史缺陷「placements 漏 zoom → 命中上一档人物层」。

- 验收：9/9 通过 + `EXPORT_CHAR_OK`；负向对照（把多规格路径的 DPI 写入去掉）→
  `[FAIL] 全部写入 300 DPI`、`7/9`、exit 1，还原后回到 9/9。
- 回滚：纯新增文件 + 一条单测，无产品代码改动。

> 为什么不做组件级单测：`IdPhoto.tsx` 依赖 canvas、ONNX Worker、MediaPipe 与 Electron 桥，
> 进 jsdom 要造四套桩，桩一旦失真就变成「自证清白」。步骤 2/3 抽出 `lib/idphotoCompose.ts`
> 之后，才在该模块上补「调用参数」级单测，与本脚本形成上下两层。


### 步骤 2｜抽出 `composeOne` / `composeMany`，预览 effect 先接（✅ 已落地 2026-10-29）

- 新增 `src/lib/idphotoCompose.ts`：`composeOne(item, input, deps)` 负责单张
  （匀肤 → 失败回退 → 构键 → 取/建人物层 → FIFO 淘汰 → 合层），
  `composeMany(input, deps)` 负责编排（逐张、每 8 张让帧、单张失败只报错不中断、取消）。
  模块只 `import type`，不碰 DOM/canvas，node 下可直接用桩测。
- 组件侧：预览 effect 由 ~90 行压到 ~45 行，`setResults` / `setErrors` / `setAdvMsg`
  与旧 URL 的 `revokeObjectURL` 仍留在组件。
- **两个刻意的决定**：
  1. **缓存键由调用方注入**（`keyOf`）。预览键 `${id}|${sig}|${personLayerKey}`、导出键
     `${id}|${p.id}|${advActive?advKey:''}|${personLayerKey}`——现在就不一样，本轮逐字保留，
     不顺手统一，否则会改变跨路径的缓存命中行为（正是历史 bug 的温床）。
  2. **取消时回收已产出的 URL**。旧实现取消后 `setResults` 不执行，这些 blob URL 无人 revoke
     （泄漏）。新实现 `composeMany` 在 abort 时回收；这些结果从未交给渲染，对用户不可见，
     属行为中性修复。
- 验收：`idphotoCompose.test.ts` 13 条（调用参数级：建层用输出分辨率、匀肤失败回退档位与
  键不含签名、同键命中不重建、超上限 FIFO、取消不产出、让帧次数、失败那张也让帧）；
  `npm test` 605 passed / 3 skipped；`tsc` 干净；`verify:export` 9/9；`PREVIEW_OK`。
- 行数：`IdPhoto.tsx` 2080 → 2069（管线本体搬走的 ~100 行由 lib 承接，净减的是调用处）。
- 回滚：revert 三个文件（lib + 测试 + 组件），effect 即恢复原样。


### 步骤 3｜`exportAll` 改调同一函数（✅ 已落地 2026-10-29）

**实际做法**：`exportAll` 里那份重复实现（匀肤→回退→建层→FIFO→合层→逐张 try/catch，约 40 行）
删掉，改成一个尺寸一次 `composeMany` 调用。合成的两条路径现在只有 **1 份**实现。

四处差异都是**显式传参**，没有藏在 if 里：

| 差异 | 预览 | 导出 |
|---|---|---|
| 输出分辨率 | `pxW/pxH`（预览档） | 每个规格自己的 `mmToPx(p.w/p.h)` |
| 缓存键 | `previewLayerKey` | `exportLayerKey(id, p.id, …)`（多一段规格 id） |
| 失败文案 | `合成失败` | `${规格名} 导出失败` |
| 进度 / URL | 无进度、要预览 URL | `onProgress` 刷「正在导出 n/N」、不建 URL |

`fastPath` 仍是组件里的分支：单规格且等于当前预览规格时，直接复用已合成的 `results`，
只补 DPI 元数据——它不涉及合成，没必要塞进编排层。

**两处必须注意的等价性**（都是「不做就悄悄变了行为」的点）：

1. **匀肤跨尺寸复用**：原实现用 `baseCache` 按 id 缓存，多个尺寸只匀肤一次。现在由
   `memoRetouch()` 按抠图 blob 记忆（失败的 promise 也记忆，第二次尺寸直接走同一条回退分支）。
   不做这一步，2 个尺寸就会把同一张图匀肤 2 遍——慢一倍还可能两次结果不一致。
2. **`exportLayerKey` 的匀肤段是 `advActive ? advKey : ''`**（开关是否打开），预览用的是
   `retouchSig`（实际是否成功）。**这是既有行为，本轮不改**：一改就动跨路径的缓存命中关系。
   两种键格式已由 4 条单测钉住（含「两种格式永不相等」）。

**验收**：`npm run verify:export` 9/9（6 份产物：份数/命名/格式/DPI/像素尺寸/同图两规格两尺寸/
控制台/基线一致）；`npm test` 615 passed；`tsc` 0 错；`preview_multisize.py` → `PREVIEW_OK`；
`ui:check:fast` 新增 0；pre-commit 门禁通过。

**顺手补的门禁健壮性**：`verify:export` 加了「超时重试一次」。本轮实测碰到过一次宿主环境的
onnxruntime 偶发挂起（两个 Worker 都只回进度消息、永不出结果，重开浏览器即恢复），
不重试会把这种抖动误判成产品回归，门禁一红就没人信了。只对**超时**重试，断言失败立刻红。

**回滚**：revert `IdPhoto.tsx` 一个文件即可（`composeOne` 留着不影响）。

### 步骤 4｜构图决策抽成 `idphotoFramingFlow` ✅ 已完成（接口与方案不同）

方案原写的是 `planPlacements(items, frameData, spec, mode, segmenter) -> { placements, segmented, fillApplied, warnings }`。
落地时拆成三个入口，因为三个调用点要的东西本来就不一样：

| 出口 | 覆盖阶段 | 谁在用 |
| --- | --- | --- |
| `ensureFrames(targets, cache, deps, opts)` | ①取人脸 ②判下半身 + 缓存 + 让帧 | 自动构图 / 实时核查 effect / 多尺寸导出（= 原 `ensureFrameData`） |
| `placementForFrame(frame, spec, mode?, fillScale?)` | ③按规格算 placement（纯同步、无 I/O） | 自动构图、多尺寸导出按尺寸重算 |
| `planPlacements(targets, cache, input, deps)` | ①②③ 一体 → `FramingPlan` | `applyAutoFraming`，拿到结果去写 state |

- **为什么没照抄返回值**：`segmented / fillApplied / warnings` 是**右栏实时核查面板**的读数，
  自动构图根本不消费。塞进 `FramingPlan` 会让两个用途不同的调用点被迫共享同一份返回结构，
  以后任一边加字段都要动另一边。核查面板继续用 `specAutoPlacement + computeMetrics +
  verifyFraming` 三步（本身都是纯函数），本步不动它 —— 顺手改 UI 行为是这轮最不该做的事。
- **为什么 `deps` 是三个原子函数而不是一个 `segmenter`**：原实现的顺序是
  「加载一次原图 → 人脸 → 用**同一张**图预缩后分割」，`HTMLImageElement` 在两步之间复用。
  只注入 `segmenter` 就得让 lib 自己 `loadImage`，lib 立刻碰 DOM。改成
  `loadSource → { src: S, w, h }`、`detectHead(src)`、`segmentLower(src)` 三段，
  DOM 全留在组件（`frameDeps`，`useMemo` 引用恒定），lib 只 import type。
- **行为逐条对齐**（源码注释 + 用例双份钉住）：缓存命中直接跳过（**连让帧也跳过**，原 `continue`
  在让帧之前）；未检出人脸只记 `{ w, h }` 且不跑分割；分割抛错或返回 `undefined` → 保留 head、
  lower 留空；加载失败记 `{}` 并计入「未检出人脸」；每 8 张让一帧，让帧位置不变。
- **组件侧只剩阶段 ④**：`applyAutoFraming` 只做「筛目标 → busy/progress → 把
  `plan.placements` 合进 state → 切构图模式 → 拼提示文案」。提示文案逐字未变
  （`framed`/`noFace` 就是原来的 `ok`/`noface`）。`IdPhoto.tsx` 里**不再出现**
  `lower?.found ? bottomFrac : undefined` 这类判断 —— 「分割结果怎么转成 placement」
  现在只有 `placementForFrame` 一处实现。
- 验收：新增 `idphotoFramingFlow.test.ts` **22 条**（阶段③与 `specAutoPlacement` 参数级对齐 /
  阶段①②的缓存跳过·无脸·分割失败·加载失败·让帧时机 / 阶段①②③的下方充足不放大·不足封顶 1.2·
  无脸计入·空目标·custom 透传，另加**行为级复核**：下方充足时头高 0.64、留白 0.08、零告警；
  下方不足时头顶仍锚 0.08 但头高被放大到超出容差）；`npm test` 636 passed / 3 skipped；
  `tsc` 0 错；`verify:export` 9/9；`PREVIEW_OK`；`verify:framing` 17/17；`verify:wiring` OK；
  `ui:check:fast` 0/0。
- **负向对照**：把 `placementForFrame` 的 `bottomFrac` 改成恒 `undefined`（等价「分割结果丢失」），
  3 条用例立刻红（含行为级那条），还原后 22/22 绿。
- **已知覆盖边界**：阶段 ④（写 state）没有自动化断言。`verify:export` 只比对份数/命名/尺寸/DPI，
  不断言像素内容，所以「placements 写错」它抓不到 —— 这段靠阶段③单测（同参同果）+ 人工预览兜。
- 回滚：revert `src/lib/idphotoFramingFlow.ts`、其测试与 `IdPhoto.tsx` 三个调用点。

#### 补记（打包前合并时清掉的最后一处重复）

上面那句「`IdPhoto.tsx` 里不再出现 `lower?.found ? bottomFrac : undefined`」当时**只对了一半**：
自动构图与导出路径确实已经走 lib，但右栏「实时核查」effect 里还留着一份手写的参数装配
（`specAutoPlacement(head, w, h, spec, specMode, fillScale, bottomFrac)` + 自己提取 `bottomFrac`）。
后果不是立即出错，而是**漂移风险**：以后 `placementForFrame` 加了参数（比如新的构图模式），
核查面板不会跟着改，于是面板读数和实际构图说的不是一回事，而门禁一条都抓不到（它不改产物、不改 DPI）。

处理：
- `idphotoFramingFlow.ts` 新增导出 `personBottomFrac(frame)`，「底部位置怎么取」只此一处；
  `placementForFrame` 内部也改用它。
- 核查 effect 改成 `const r = placementForFrame(fd, framingSpec, specMode, fillScale)`，
  面板只负责把 `r.placement` 喂给 `computeMetrics` / `verifyFraming`，不再自己拼参数。
- 补 3 条用例：`personBottomFrac` 的三种返回（成功 / 分割失败 / frame 缺失）+ **同 frame 下
  「面板侧 `placementForFrame`」与「自动构图侧 `specAutoPlacement`」placement 与 bottomAnchorScale 全等**。

结果：`grep 'specAutoPlacement('` 只剩定义与 `placementForFrame` 一处调用；`IdPhoto.tsx` 里再无
`lower?.found ?` 分支。测试 22 → **25 条**，总计 671 passed。

### 步骤 5｜搬 JSX：`FramingEditor` 先单独成文件 ✅ 已完成

- 1640-2070 共 431 行原样搬到 `src/tools/FramingEditor.tsx`（与方案里写的
  `idphoto/FramingEditor.tsx` 差一层目录：现有工具组件都在 `src/tools/` 且
  `SpecFramingPanel` 在 `src/components/`，放 `src/tools/` 与调用方同级更顺，
  不再多开一层）。
- **机械搬运，零逻辑变更**：用脚本按行切片，只做两处文本改动 —— 加 `export default`、
  把 13 个 `framingGuides` 符号与 `detectFaces` 的 import 从 `IdPhoto.tsx` 搬过去。
  切片行数 431 + 表头 19 = 450，文件 450 行，逐行对得上。
- `IdPhoto.tsx` 2,070 → 1,623 行（净减 447 = 搬走 431 行 + 移走 16 行 import − 新增 1 行 import）。
  `framingGuides` 的 import 整块移走（13 个符号在文件里再无其它使用点）；`detectFaces` 保留（918 行仍在用）。
- 验收：`tsc` 干净 + `ui:check:fast` 0 新增 + `preview_multisize.py` → `PREVIEW_OK`
  + `verify:export` 9/9。**另补一条新的常驻冒烟** `npm run verify:framing`
  （`tools/framing_editor_smoke.py`），17 项断言覆盖「挂载 / 人物图解码 /
  拖动出参考线与徽标 / 画面跟随指针 / A·T 快捷键 / 拖圆钮旋转 / 重开后偏移与旋转
  被还原 / 重置居中归位 / 0 console 错误」——这段路径原先在 tsc、单测、导出特征
  测试里全是盲区（组件挂在 `framingId` 后面，不点开就不渲染）。
- 回滚：git revert 两个文件即可。

### 步骤 6｜左右栏拆分 ✅ 已完成（有一处刻意偏离）

- 按 `idp-left` / `idp-center` / `idp-right` 三个 class 边界，切成
  `IdPhotoLeft.tsx`（170 行 / 15 prop）、`IdPhotoCenter.tsx`（137 行 / 15 prop）、
  `IdPhotoRight.tsx`（552 行 / 63 prop）；共享的 `PhotoItem` / `ComposeResult`
  挪到 `idphotoTypes.ts`，避免子组件反向 import 父组件。
  底部栏（导出/打印/排版，51 行）**留在 `IdPhoto`**：它是跨栏动作条，不属于任何一栏。
- **偏离**：方案原本写「props 用已收敛的对象传（`options` / `onXxx`）」。实际改成
  **扁平具名 prop**，理由有两条：
  1. `options` 对象 + `setOption(key, v)` 分发器本质上就是步骤 7 的 reducer。
     提前做等于把 reducer 藏进面板组件里，既扩大了本轮改动面，又让步骤 7 失去
     独立可回滚的意义。
  2. 扁平具名 prop 能让 JSX 正文**逐字不动**（只有签名和解构是新增的）。用对象分组
     就必须把每一处 `bgId` 改写成 `options.bgId`，342 行正文全动，评审时无法区分
     「搬家」与「改逻辑」。
  代价是右栏 63 个 prop 看着宽——这恰恰是步骤 7 要解决的症状，先让它显形。
- **正文一致性用脚本验证**：`.tmp/verify-move.cjs` 把三个新文件的正文与拆分前逐行比对
  （仅整体缩进 -2），三栏全部「逐字相同」。
- **新增护栏 `npm run verify:wiring`**（`tools/panel-wiring.mjs`，已挂进 pre-commit）：
  断言三件事 —— 父组件传的 prop 与子组件 interface 完全一致、每个 prop 都是
  `name={name}` 自接线、interface 字段全部被解构。**这条护栏补的是 tsc 的盲区**：
  `setBgId={setCustomHex}`、`setAdvShine={setAdvEye}` 这类同类型错接完全合法，
  编译通过、页面不报错，只是点了「背景色」改到了别的 state。负向对照已实测：
  把 `setBgId` 改成 `setCustomHex` 后本应 0 命中的检查报 `WIRING_FAIL`，tsc 仍然 0 错。
- 验收：`tsc` 干净 + `npm test` 615 全过 + `ui:check:fast` 0 新增 +
  **`--mobile` 窄屏扫描 0 新增**（方案要求）+ `PREVIEW_OK` + `verify:export` 9/9 +
  `verify:framing` 17/17 + `verify:wiring` 通过 + pre-commit 门禁通过。
- 回滚：revert 这 4 个新文件 + `IdPhoto.tsx`，import 还原即可。

### 步骤 7｜状态收敛成 `usePhotoOptions` ✅ 已完成（25 / 26，边界见下）

- 落地结构：
  - `src/lib/idphotoOptions.ts`（176 行，**无 React、无 DOM**）：`PhotoOptions`（25 个设置项）
    + `DEFAULT_PHOTO_OPTIONS`（默认档的唯一真相）+ `photoOptionsReducer` + 泛型 `SetPhotoOption`；
  - `src/tools/usePhotoOptions.ts`（36 行）：`useReducer` 薄封装，返回
    `{ options, setOption, addExportSize, toggleExportSize, resetOptions }`，四个动作全
    `useCallback` 固定引用（否则「收敛 prop」省下的重渲染又还回去了）；
  - `IdPhoto.tsx`：25 个 `useState` → 一次 `usePhotoOptions()`；顶部解构出
    `presetId / bgId / …` 别名，**正文引用逐字不动**，diff 只落在 setter 调用点（3 处）；
  - `IdPhotoRight.tsx`：**63 prop → 22 prop**（`options` + `setOption` + `addExportSize` /
    `toggleExportSize` + 18 个运行时/派生），面板正文只在 23 处 setter 调用点改成
    `setOption('key', v)`，`options` 在函数顶部解构成同名局部变量。
- **边界（26 处里为什么只收 25）**：`manualOpen`（折叠区展开态）与 `tab` 是 UI 展开态，
  不是配置；`items / checked / results / busy / progress / saveMsg / errors / placements /
  framingId / frameMode / activeFraming / issues / dragOver / sheets / mattesVer` 是运行时状态。
  塞进 options 会让「可序列化 / 可快照 / 可持久化」名存实亡 ——
  **方案原文的「26 处」按实际应为 25 个设置项 + 1 个展开态 + 13 个运行时状态。**
- **两条不变量从 JSX 搬进 reducer**（原先散在两个 `onChange` 闭包里、零测试）：
  `add-size` 幂等（已在集合 → **返回同一引用**，不触发多余渲染）、
  `toggle-size` 恒保留至少一个。现在它们是两条可测事实，不再靠人读 JSX。
- **新增护栏**：`npm run verify:wiring` 加第 4 条规则「**设置项读写同键**」——
  `setOption('k', …)` 所在控件若带 `checked={x}` / `value={x}`，则 x 必须等于 k。
  覆盖 17 处可比对站点（纯 `onClick` 的色块/档位按钮无从比对，按跳过计）。补的是
  **tsc 的盲区**：`<input checked={sizeMark} onChange={… setOption('guideOn', …)}>`
  类型完全合法。负向对照实测：改成 `'guideOn'` → **tsc 仍 0 错**、`WIRING_FAIL`；还原后 OK。
- 验收：`idphotoOptions.test.ts` **11 条** —— 默认值 `toMatchInlineSnapshot` 钉住
  「自然美颜 / r6 相纸 / 2mm 间隔 / isnet / 去晕边开 / 批量自动构图开 / 导出集合默认 == 当前规格」；
  `set`/`patch`/`reset` 的不可变性与「reset 的 exportSizeIds 不与默认常量共享引用」；
  两条集合不变量。另：`npm test` **648 passed / 3 skipped**；`tsc` 0 错；`verify:export` 9/9；
  `PREVIEW_OK`（含真点「至少保留一个规格」）；`verify:framing` 17/17；`verify:wiring` 通过；
  `ui:check:fast` 0/0。
- 度量：`IdPhoto.tsx` 1,133 → **1,092**；右栏 552 → 484（63 行 interface + 65 行参数塌成
  22 prop + 25 行解构）。收益不只是行数：`PhotoOptions` 让「恢复默认 / 记住上次设置」
  变成一次 `resetOptions()` / 一次 JSON 存取，而不必再逐字段搬 25 个 setter。
- 回滚：revert `idphotoOptions.ts`、`usePhotoOptions.ts`、两个组件与 `panel-wiring.mjs` 新增段。

## 四、度量与门禁

| 指标 | 起点 | 现在（步骤 7 完成，方案收尾） | 目标 |
| --- | --- | --- | --- |
| `IdPhoto.tsx` 行数 | 2,075 | **1,092** | < 500（只剩状态与组合） |
| 覆盖编排层的测试 | 0 | 23（`idphotoCompose`）+ 22（`idphotoFramingFlow`）+ 11（`idphotoOptions`）+ 1（键指纹）+ 17（取景编辑器冒烟）+ **13 项接线/同键断言** | ≥ 15 |
| 合成逻辑份数 | 2 | **1** | 1 |
| 构图决策份数 | 3（自动构图 / 核查面板 / 导出各一份分支） | **1**（`placementForFrame`） | 1 |
| 设置项 state 份数 | 25 个 `useState` | **1 个 `PhotoOptions`**（+ reducer 单测） | 1 |
| 右栏 prop 数 | 63 | **22**（可选项 2 追加 `isDefaultOptions` / `resetOptions` 后 24） | — |
| 渲染拆出 | 0 | 4 个组件（三栏 + 取景编辑器），共 1,309 行 | 全部 |
| 守门 | `tsc` + `vitest` + `ui:check` + `preview_multisize.py` | 同上 + `verify:export` + `verify:framing` + `verify:wiring` + `verify:persist` | 前三项 pre-commit 自动跑 |

七个步骤全部落地。全程「每步单独可发布、单独可回滚」的约束守住了，最硬的证据是
`verify:export` 9/9 在步骤 2、3（改合成管线）、5、6（搬 JSX）、4（抽构图流）、7（改状态模型）
每一步之后都重跑过一遍，一次没红（除步骤 1 记录的宿主 ort 偶发挂起，加了仅超时重试）。

行数没怎么降是预期的：步骤 3 删的是 `exportAll` 里那份**实现**（约 40 行逻辑），
同时又加了一个「按尺寸算 placement」的 map（原来内联在循环里）。真正的收益是
**只有一份合成管线**——上一轮 `placements` 丢 `zoom` 就是两份实现漂移出来的。
步骤 5 是行数上的第一刀（-447，整块 JSX 搬家），步骤 6 再减 491，步骤 4 几乎不动行数
（1,132 → 1,133：DOM 适配层进来、内联循环出去），步骤 7 减 41。
也就是说**行数只掉了「搬运」的那 900 行，逻辑重构一行没靠删代码换分数** ——
剩下 1,092 行里状态声明与组合逻辑仍占大头。**「把 `exportAll` / 预览 effect 移进 lib」这条路已评估并放弃**
（理由见文末「可选项 2」一节）：effect 离不开 React，`lib/` 只装得下纯计算，搬过去只是换文件归属。
真正该做的是切出 `planExport()`（命名 / fastPath / 跨尺寸坐标换算），留待下次改导出行为时顺手做。

行为护栏（步骤 1 已就位）：`npm run verify:export` —— 真实 Chromium 跑完整导出，
比对命名/份数/像素尺寸/DPI 基线。步骤 2、3 每落一步都跑它，绿了才算行为不变。

顺序建议：**1 → 2 → 3 → 5 → 6 → 4 → 7**（已全部完成）。其中 4 可以在 2/3 之后任意时刻插入，
7 放最后。每一步都能单独发布、单独回滚，不需要一次性大重构窗口。

未纳入本方案的后续候选（不做也能用，但价值明确）：
- 把预览 effect 与 `exportAll` 的主体也移进 lib，让 `IdPhoto.tsx` 真正「只剩状态与组合」；
- ~~`PhotoOptions` 落盘（记住上次设置）+ 面板加「恢复默认」，现在只差一次 JSON 存取与 `resetOptions()`。~~ → 已于同日落地，见下节。

---

## 可选项 2（已落地）：设置项落盘 + 恢复默认

七步收尾后评估了两个候选。结论是**做落盘、不做「把 effect 搬进 lib」**：

- 「把 effect 搬进 lib」在 React 里不成立 —— effect 里除了一次 `composeMany` 调用，
  其余全是 `setState` / ref / `revokeObjectURL`，`lib/` 无 React 装不进去，
  最多变成 `src/tools/` 的另一个 hook，收益是文件归属而非可测性，
  而取消语义（旧结果覆盖新结果）恰恰是最难被门禁发现的地方。**只保留「抽 `planExport` 纯函数」的切片，
  留待下次改导出时再做。**
- 落盘直击真实场景（图文店每天开机重设同一套参数），且基础设施已就位
  （`atomicStorage` 原子写 + `.bak` 回退、`appSettings` 的 `schemaVersion` 范式、`resetOptions` 早就写好了）。

### 落地内容

| 文件 | 改动 |
| --- | --- |
| `src/lib/idphotoOptionsStorage.ts`（新增 ~230 行） | `KEY = 'chaoyu.idphoto.options.v1'`；`normalizePhotoOptions()` 逐字段校验；`load/save/clear/toPersisted/isDefaultPhotoOptions` |
| `src/lib/idphotoOptionsStorage.test.ts`（新增） | **20 条**：非对象/null、未知 id、越界钳制、非有限数、非法枚举、非布尔、非法 hex、未知字段丢弃、不落盘字段、往返、`schemaVersion`、主 key 损坏回退 `.bak`、双坏、`clear` 清两把 key、`isDefault` 判据 |
| `src/tools/usePhotoOptions.ts` | 惰性读盘 + 指纹式写盘 + `resetOptions` 清盘 |
| `src/tools/IdPhoto.tsx` | **挂载时把落盘引擎同步进 `mattingPool`**；`isDefaultOptions` 计算；传 2 个新 prop |
| `src/tools/IdPhotoRight.tsx` | 顶部「设置会自动保留 + 恢复默认」；两段式确认（4 秒自动收回）；24 prop |
| `src/index.css` | `.idp-right-h` |
| `tools/options_persist_smoke.py`（新增） | `npm run verify:persist`：27 项真机断言 |

### 三条不可省的约束（写进代码注释）

1. **`exportSizeIds` 不落盘**。它是「这次的批量意图」不是偏好；上次勾了 7 个规格，
   下次开机默认 7×N 份导出，用户会以为软件疯了。读回恒重建为 `[presetId]`。
2. **逐字段 normalize**。`PHOTO_PRESETS` / `PAPER_SIZES` / `BG_OPTIONS` 增删过的话，
   存档里的旧 id 会被 `IdPhoto.tsx` 的 `?? preset` 静默解释成「当前规格」，
   导出的文件名和用户以为的不一致 —— 这类错误只能靠每个字段独立校验挡掉。
3. **引擎必须挂载同步**。`mattingPool.ts` 的 `currentEngine` 是模块级变量（恒 `isnet`），
   只由 `onEngineChange` 纠正；落盘 `modnet` 而不同步，会造成「面板显示快速、实际跑精细」，
   批量 50 张从 45s 变 288s 且无处可查。

### 写盘策略：指纹比对而非「跳过首次」

`usePhotoOptions` 用 `lastSaved`（只含落盘字段的 JSON）做值比对，而不是「跳过第 1 次 effect」。
原因是 `main.tsx` 开了 `StrictMode`，dev 下 effect 会跑两遍，「跳过首次」挡不住第二遍；
值比对同时顺带解决「重复点同一选项」「恢复默认后回到默认值」两类无意义写盘。
恢复默认的顺序也因此固定：**先 `clearPhotoOptions()` 并把指纹对齐到默认值，再 dispatch reset** ——
反了会让 effect 把默认值写成新存档。

### 覆盖边界（如实记录）

- `verify:export` / `preview_multisize.py` 都用 `chromium.launch()`（全新临时 profile），
  所以它们**只**覆盖「无存档 → 默认」这一条分支；「有存档 → 读回」「恢复默认 → 清盘」
  只能靠 `verify:persist` 与 20 条单测。
- hook 里「什么时候读、什么时候写」这点 React 语义无法在 node 下单测，靠 `verify:persist` 兜。

### 验收

`tsc` 0 · `vitest` **668 passed / 3 skipped**（+20）· `verify:export` 9/9 · `verify:framing` 17/17 ·
`verify:persist` **27/27** · `PREVIEW_OK` · `verify:wiring` OK（右栏 24 prop）· `ui:check:fast` 0/0。
负向对照：把 `exportSizeIds` 改成继承存档 → 1 条用例立刻红，还原后 20/20。

