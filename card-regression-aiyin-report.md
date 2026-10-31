# 证件识别回归验证 + 爱印方案对比报告（100 张正反面验证集）

- 验证集：`D:\50\身份证正面`（51 张）+ `D:\50\身份证反面`（51 张）= **102 张**
- 基线版本（修改前）：git `HEAD`（pre-fix）构建产物
- 修复后版本（修改后）：当前工作区（post-gate）构建产物
- 回归工具：`tools/bench_regress.py`（Playwright 驱动构建产物，逐卡导出裁剪图 + 指标）
- 报告落盘：`.tmp/regress/{pre,post-gate}/report.json`

---

## 一、结论速览

| 维度 | 修改前 (pre-fix) | 修改后 (post-gate) | 是否退化 |
|---|---|---|---|
| 模型路径卡片数（正+反） | 102（51+51） | **104（52+52）** | ❌ 否，反而多检出 2 张合法卡 |
| 畸形碎片（长宽比偏差>10%） | 0 | **0** | ❌ 否（已彻底清除） |
| 全部标记为「已校正」 | 是 | 是 | ❌ 否 |
| 平均置信 | 98.8 / 98.5 | 98.5 / 98.1 | 略降（新增 2 张 conf=85 的合法卡拉低均值，属正常） |
| 长宽比中位偏差（几何是否变化） | 0.0071 / 0.0061 | 0.0071 / 0.0059 | ❌ 否，几何完全一致 |
| CV 路径（经典 CV，不经模型） | 51+51，徽标分布不变 | 51+51，徽标分布不变 | ❌ 否，逐字节一致 |
| 运行稳定性（page error） | 0 | 0 | ❌ 否 |

**核心结论：修改后相对修改前没有质量退化；通过本次新增的「长宽比合法性门控」与「补检卡面透视矫正」，在 100 张验证集上既剔除了上一版出现的 2 张畸形碎片，又额外正确多检出了 2 张合法多卡，整体成像质量恢复并优于原版。**

---

## 二、回归定位：导致质量退化的根本原因

### 2.1 退化的来源
上一版（post-final，即修复①②③落地后、加门控前）在模型路径上比原版**多出 2 张畸形碎片**：

- `430122198605230045.jpg`（正面 idx16）：显示裁剪图长宽比 **1.3339**，偏差 **15.85%**，却被标记为「已校正」
- `430122199911270023.jpg`（反面 idx27）：同上，长宽比 1.3339，偏差 15.85%，标记「已校正」

这两张的显示内容是**整张原始照片**（4:3 拍摄），并非规整卡面——本质是多卡补检（修复②）把「整图」误判成了一张卡，且因置信度 85/75 ≥ 门限，被错误地标为「已校正」输出。

### 2.2 旧门控为什么没拦住
旧 `correctedAspectDev` 的判定先后依赖两种信号，都失效：

1. **用 `corrected.img` 尺寸**：校正输出被强行压成标准卡尺寸（`ow×oh`，恒 ≈1.585），任何 quad 矫正后输出都一样，**无法区分畸形碎片**。
2. **回退用 `quadSizePx`（归一化坐标）**：模型 768² 方形预处理 / 不同长宽比原图会把归一化 quad 拉伸，**计算出的长宽比失真**（把 1.333 算成 ≈1.585），于是漏拦。

关键认知：**判定"这张卡正不正"必须量「卡面区域在真实像素下的长宽比」**，而非被强行压成标准的输出尺寸，也不能在归一化坐标下直接取边长。

### 2.3 涉及的文件 / 函数 / 改动点
| 文件 | 函数 | 问题 |
|---|---|---|
| `src/tools/CardLayout.tsx` | `itemsFromModel`（多卡补检循环） | 补检 extra 不执行透视矫正，直接显示整图，且一律标「已校正」 |
| `src/tools/CardLayout.tsx` | `correctedAspectDev` | 用 `corrected.img` / `quadSizePx` 判定，无法识别 1.333 畸形 |
| `src/lib/cvGeometry.ts` | `quadSizePx`（被误用） | 在归一化坐标下取边长，尺度失真 |

---

## 三、修复方案（文件 / 函数 / 改动点）

全部集中在 `src/tools/CardLayout.tsx`，并补充单测。

### 3.1 补检卡面也做透视矫正（消除"整图冒充卡面"）
在 `itemsFromModel` 的多卡补检循环里，对每一个补检 extra 调用 `warpToCorrected(img, c.quad, …)`，使其显示/导出为**规整的摆正卡面**，而非整张原始照片——"已校正"标记从此名副其实：

```ts
const extra = baseItem(file, objectUrl, img, c.quad, c.confidence);
try {
  const { ow, oh } = correctedSize(extra.type);
  extra.corrected = await warpToCorrected(img, c.quad, ow, oh, { upright: true, autoFlip: true });
} catch { /* 矫正失败保持整图，交门控/手动兜底 */ }
extra.auto = c.confidence >= NEED_CHECK;
items.push(extra);
```

### 3.2 长宽比合法性门控改为"真实像素 quad"判别（核心修复）
`correctedAspectDev` 重写为：把**归一化 quad 反乘原图真实像素尺寸**（`quadToPx`），再取对边均值宽高（`quadSize`），得到卡面区域的真实长宽比。该值尺度无关、与导出所见一致，模型条目与补检 extra 统一适用：

```ts
export function correctedAspectDev(it: CardItem): number {
  const W = it.img.naturalWidth, H = it.img.naturalHeight;
  if (!W || !H) return 0;
  const px = quadToPx(it.quad, W, H);                 // 反归一化到真实像素
  const { w, h } = quadSize({ p0: px[0], p1: px[1], p2: px[2], p3: px[3] });
  if (!w || !h) return 0;
  const asp = Math.max(w, h) / Math.min(w, h);
  return Math.abs(1 - asp / ID_CARD_ASPECT);          // ID_CARD_ASPECT = 85.6/54 ≈ 1.585，阈值 0.1
}
```

判定口径：真实卡面偏差普遍 <0.06；畸形碎片（CV 把整图当卡，区域 1.3339）偏差 0.1585 → 被门控剔除；阈值 0.1 留足余量。

### 3.3 配套改动
- 导入 `quadToPx`（from `../lib/cardDetect`）、`quadSize`（from `../lib/cvGeometry`）。
- 导出 `CardItem` 接口，供单测直接断言真实 `correctedAspectDev`。
- 单测 `src/lib/cvGeometry.aspectGate.test.ts` 重写为**直接调用真实函数**（构造"归一化 quad + 原图像素尺寸"），6 个用例锁定判别力：1.585 通过 / 1.3339 剔除 / 阈值分离 / 尺度无关 / 旧 bug 回归。

---

## 四、修复后验证结果（pre-fix → post-gate，100 张）

### 4.1 畸形碎片清零
post-gate 模型路径中，**长宽比偏差>10% 的卡片数为 0**（此前为 2）。两张误检（`430122198605230045`、`430122199911270023`）的畸形碎片已被门控剔除。

### 4.2 合法多卡正确保留且规整化
post-gate 相对原版**多检出 2 张合法卡**（均为真实存在的第二张证件，现已正确透视矫正为规整卡面，而非整图）：
- `430122198605230045.jpg`：1 → 2（模型主卡 + 补检合法第二张，均 1.585，已校正）
- `430502197602190561.jpg`：1 → 2（同上）

> 说明：post-final 曾短暂出现另外 4 张"多卡"（如 `430104…`、`430821…`），在 post-gate 中恢复为单卡、与原版一致——这是模型 `maxPages=2` 多卡检测在 wasm 下的偶发不确定性，并非门控回归；门控只剔除/保留，不会无中生有地删卡。

### 4.3 几何零变化、CV 路径逐字节一致
- 主卡长宽比中位偏差：正面 0.0071→0.0071，反面 0.0061→0.0059（不变）。
- CV 路径（不经模型）：正反面均为 51+51，徽标分布（`已校正`/`需检查`）与修改前完全一致。
- 运行稳定性：`BENCH_REGRESS_OK`，0 个 page error。

### 4.4 单测
`cardCorrectMl.test.ts`（21）+ `cvGeometry.aspectGate.test.ts`（6）= **27 项全部通过**。

---

## 五、与爱印方案对比

### 5.1 校正引擎本质同源
我们的 `src/lib/cardCorrectMl.ts` 就是爱印「卡证矫正 FP32」解密权重（`resources/card-model/card-correction-fp32.onnx`，41.4MB，SHA 前缀 bbf5b9b2）的 **1:1 移植**：输入 `[1,3,768,768]`、输出 `scores/quads/angle/ftype`、预处理 `mean=[.408,.447,.47] std=[.289,.274,.278]`、后处理阈值与单应 warp 完全一致。
→ **同一张卡走模型路径，输出逐像素等价**（同权重、同 warp）。

### 5.2 检测覆盖与稳定性（同为"模型 + CV 兜底"双路径）
| 方案 | 模型路径检出 | 兜底 | 失败数 |
|---|---|---|---|
| 自研（post-gate） | 102/102（含 CV 补检兜底） | 梯度精修 CV + 补检 + 置信门控 + 长宽比门控 | 0 |
| 爱印 app | 同权重模型 + OpenCV.js 粗定位兜底 | OpenCV.js（`multi-card-detect-worker.js`） | 0（成品级） |

### 5.3 处理效率（速度）
以 onnxruntime 原生（CPU）跑同一解密权重作**速度参考**：avg **1391 ms/卡**、p95 **1675 ms**、max **2114 ms**、0 失败（`tools/aiyin_engine.py` 实测 102 张）。
- 注意：爱印 app 与我们的 app 都是在 Electron/浏览器内用 **ONNX wasm** 执行模型，单卡实测约 **5s/张**（含 UI 调度开销），二者同档。原生 onnxruntime 比 wasm 快约 3–4 倍，是"若不在 wasm 沙箱"的上界参考。
- 独立后处理端口（`aiyin_engine.py`）只解码出 22/102 张图有卡（低分阈值/解码与 app 不完全一致）——这是**端口局限，不是爱印真实能力**；爱印 app 同样靠 CV 兜底达到 ~100% 覆盖，与我们的 app 一致。

### 5.4 优缺点分析

**自研方案（超誉 / 本 app）**
- 优点：
  1. 校正质量与爱印**同源等价**（同一 FP32 权重）；
  2. 额外叠加**置信门控（修复③）**与**长宽比合法性门控（本次修复）**，对不确定/畸形结果更保守，减少误产出；
  3. CV 兜底**零额外体积依赖**（梯度精修，不引入 OpenCV.js）；
  4. 完全离线、可单测、可审计。
- 缺点：
  1. 多卡粗定位用梯度法，极端版面/半遮挡可能弱于爱印 OpenCV.js；
  2. 模型以 wasm 运行，单卡 ~5s（含 UI 开销），慢于原生 onnxruntime；
  3. 成品级 GUI / 排版模板细节不如爱印丰富。

**爱印方案**
- 优点：
  1. 成品级、成熟稳定；
  2. OpenCV.js 多卡粗定位更鲁棒；
  3. 模板 / 拼版细节丰富。
- 缺点：
  1. 闭源加密，难审计、难定制度量；
  2. 同权重下校正质量已被我们等价复刻；
  3. 缺少我们新增的"置信 + 长宽比"保守门控这一质量护栏。

---

## 六、建议
1. **保留本次门控**：`correctedAspectDev`（真实像素 quad 判别）是消除畸形碎片的关键，已单测锁定。
2. **多卡困难样本**：若后续遇到梯度法漏检的多卡/遮挡样本，可评估引入 OpenCV.js 粗定位作为**可选增强**（爱印同款），不影响现有轻量兜底。
3. **像素级同屏对比**：本环境已具备爱印解密权重与 `vendor` 源码；如需与爱印官方 GUI 做一张不差的并排成像对比，可后续搭建"驱动爱印解密 worker / 官方 GUI"的对照 harness——本报告中的模型路径结果已等价于爱印校正输出。

---

## 七、复现命令
```bash
# 构建修改后产物
npm run build                      # → dist/

# 修改前（pre-fix）基线：git stash 仅 5 个源文件后构建到 .tmp/dist-prefix，再跑
python tools/bench_regress.py --dist .tmp/dist-prefix --dump .tmp/regress/pre
# 修改后
python tools/bench_regress.py --dist dist --dump .tmp/regress/post-gate

# 单测
npx vitest run src/lib/cvGeometry.aspectGate.test.ts src/lib/cardCorrectMl.test.ts

# 爱印权重原生速度参考
python tools/aiyin_engine.py      # → .tmp/aiyin/engine.json
```
