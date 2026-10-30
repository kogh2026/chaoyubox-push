# 爱印「自动构图 + 放大填满 + 规格逐项核查」复刻与超誉对比

> 日期：2026-10-29 · 触发：用户对比爱印/超誉一寸导出效果，爱印因「每张照片都按规格自动定位」明显更好
> 方法：对爱印解密渲染层做只读静态分析（原安装目录为 AYE1 加密，明文在 `aiyin_decrypted_assets/`）

---

## 一、爱印原代码中相关实现的位置与参数含义

### 1. 尺寸规格模板（含构图比例）—— `aiyin_decrypted_assets/assets/export-DCg5OXfg.js`

每个尺寸不只是「像素/毫米」，还带 **构图比例三件套**：

```js
"one-inch":     { id:"one-inch",     width:295, height:413, physicalWidthMm:25, physicalHeightMm:35, topRatio:.08, headRatio:.64, safeRatio:.035 },
"small-two-inch":{id:"small-two-inch",width:413, height:531, physicalWidthMm:35, physicalHeightMm:45, topRatio:.08, headRatio:.62, safeRatio:.035 },
"passport":     { id:"passport",     width:390, height:567, physicalWidthMm:33, physicalHeightMm:48, topRatio:.08, headRatio:30.5/48, safeRatio:.03 },
```

| 字段 | 含义 | 爱印取值 |
| --- | --- | --- |
| `topRatio` | 发顶距上边占画幅高比例（头顶留白） | 一寸 `0.08`（2.8 mm @35mm） |
| `headRatio` | 头部（发顶→下巴）占画幅高比例（头部占比） | 一寸 `0.64`（22.4 mm @35mm） |
| `safeRatio` | 安全边距占画幅高比例（衣物/发梢不贴边） | `0.035` |
| `physicalHeightMm` / `width` | mm↔px 换算基准（@DPI） | 一寸 35mm / 295px |

> 这就是截图里「头部占比 64.0%（22.4 mm）、头顶留白 8.0%（2.8 mm）」的来源。

### 2. 构图引擎数学（6 度量 + 自动构图）—— 同一文件

```js
c = e.eyeMid                                   // 眼睛中点
h = rotate(headTop - eyeMid, a)                 // 发顶绕眼中点旋转校正
l = rotate(chin   - eyeMid, a)                  // 下巴
d = Math.max(1, l.y - h.y)                      // 头部高（发顶→下巴，旋转后）
m = i.height * i.headRatio / d                 // 缩放：使头高 = headRatio × 画幅高
f = i.height * i.topRatio                       // 发顶目标位置 = topRatio × 画幅高
```

### 3. 「放大填满」—— 同一文件 `bottomAnchorScale`

```js
bottomAnchorScale: i.strictFraming || S ? 1 : Lt(E/_, 1, 1.35)   // Lt = clamp
// 搜索带：for (let T = R - W*1.2; T <= U + W*1.6; T += se)  ← 低边 ±20%（1.2），高边 +60%
```

- **默认构图**：人物下方不足时自动放大，**最多 20%**（搜索带低边乘子 `1.2`）。
- **硬上限**：`1.35`（35%）—— 自定义构图由「放大填满」滑杆控制，仍受此上限约束。
- 几何：放大时**发顶仍锚定在 `topRatio`**，只把图底往下推到画布底，因此头高会随之超过规格目标（这正是后面「逐项核查」要报警的点）。

### 4. 「逐项核查」偏差判定 —— `aiyin_decrypted_assets/assets/id-photo-batch-demo-B9uSy2qK.js`

```js
function Ti(t, s, o) { return t > s + o ? "high" : t < s - o ? "low" : "match" }
// yh = .02（头高容差）  vh = .015（留白容差）
headRatioDeviation  = Ti(实测头高占比,  spec.headRatio, 0.02)
topRatioDeviation   = Ti(实测留白占比,  spec.topRatio,  0.015)
// 告警文案：头高偏大/头高偏小、留白偏多/留白偏少、头顶为估算、头顶出框
```

右侧面板文案（同文件）明确：
> 默认构图会在人物下方不足时自动放大最多 20% 填满；切到自定义构图后，这一步由下面的「放大填满」控制。按规格要求：照网站写的像素或毫米范围填写，**每张照片自动调到范围内并逐项核对**。

### 5. 四种构图模式（目标描述优先级）—— `ai-id-photo-workspace-CFIuhUxG.js`

`保持原图(f) > 按规格要求(m) > 自定义构图(t) > 默认构图`，对应右侧「人像构图」下拉。

---

## 二、超誉功能对比结论（是否缺失）

| 能力 | 爱印 | 超誉（改造前） | 结论 |
| --- | --- | --- | --- |
| 分尺寸构图比例 `topRatio/headRatio` | ✅ 每尺寸独立 | ❌ 仅固定 60%/9% | **缺失**：`PHOTO_PRESETS` 只有 `{w,h}`，无比例 |
| 放大填满 20% 上限 | ✅ `bottomAnchorScale`≤1.35，默认 20% | ❌ `autoPlacement` 仅 `max(1, wantScale/cover)` | **缺失** |
| 自定义构图（放大填满滑杆） | ✅ | ❌ | **缺失** |
| 逐项核查（头高/留白偏差告警） | ✅ `Ti` ±0.02/±0.015 | ❌ 无 | **缺失** |
| mm↔px 规格单位体系 | ✅ `physicalHeightMm` | ⚠️ `mmToPx` 有，但未驱动构图 | 部分具备 |
| 批量默认自动构图 | ✅ | ❌ 需手动点「自动构图」 | **缺失（默认项建议补）** |
| 美颜默认档 | ✅ 默认开启 | ❌ 默认「关」（默认项建议补为可选默认档） | **缺失（默认项建议补）** |

> 既有 `faceFrame.autoPlacement` / `headFromFace` 是自动构图的**底座**（人脸→取景），但写死 60%/9%、无放大填满、无规格表、无核查，故导出效果不如爱印——**根因就是缺「按规格定位 + 放大填满 + 逐项核对」这一层**。

---

## 三、React 复刻实现方案与关键参数

### 新增纯逻辑层 `src/lib/specFraming.ts`（无 DOM，已 12 项单测覆盖）

- `FramingSpec`：尺寸规格（`mmW/mmH/pxW/pxH + topRatio/headRatio/safeRatio`）。
- `specAutoPlacement(head, imgW, imgH, spec, mode, fillScale)`：按规格构图。
  - `mode='default'`：人物下方不足时放大，**封顶 `BOTTOM_FILL_NOMINAL=1.20`（最多 20%）**；
  - `mode='custom'`：由 `fillScale` 控制，封顶 `BOTTOM_FILL_HARD_MAX=1.35`；
  - `mode='spec'`/`'keep'`：不做放大填满。
  - 几何：cover 铺满 → 头高摆到 `headRatio×H`、发顶锚定 `topRatio×H`、头部中心水平居中；放大时发顶不动，图底推向画布底。
- `computeMetrics()`：由取景参数反推实测头高/留白占比（与 `composeGeometry` 同一套 cover/zoom 语义）。
- `verifyFraming()`：复刻 `Ti` 偏差判定，输出 `头高偏大/偏小、留白偏多/偏少、头顶出框、头顶为估算`。
- 常量对齐爱印：`HEAD_RATIO_TOL=0.02`、`TOP_RATIO_TOL=0.015`、`SEARCH_MARGIN=0.125`。

### 规格表扩展 `src/lib/cardLayout.ts`

`PHOTO_PRESETS` 每项补 `topRatio/headRatio/safeRatio`（一寸 0.08/0.64、小二寸 0.08/0.62、护照 0.08/30.5/48…，其余回退 `DEFAULT_RATIOS`），新增 `mmToPx()` 与 `DEFAULT_DPI=300`。

### React 面板 `src/components/SpecFramingPanel.tsx`

复刻爱印右侧「人像构图」区：模式下拉（默认/自定义/按规格/保持原图）、放大填满滑杆（1.0–1.35，限自定义可用）、头部占比/头顶留白读数（含 mm，目标 vs 实测）、逐项核查告警列表。内联样式，浅色主题独立可渲染。

### 接入 `src/tools/IdPhoto.tsx`

- `applyAutoFraming` 改用 `specAutoPlacement`（按当前尺寸规格构图，并修复了 `placements` 长期丢失 `zoom` 的隐患，使头高真实生效）。
- 新增「规格构图核查」面板 + 实时预览（随模式/放大填满重算当前照片的实测与告警）。
- 手动微调（`FramingEditor`）保留已有 `zoom`，不再清零自动构图缩放。

> 测试：`npm test` 全绿（593 passed / 3 skipped），`tsc --noEmit` 干净。

---

## 四、落地建议（两个默认项）

1. **批量处理默认启用「自动构图」**（功能已有，仅改默认开关）
   - 已实现：新增 `batchAutoFrame` 默认 `true`，每次抠图完成（`mattesVer` 递增）自动按规格构图；UI 勾选框可关闭。
   - 价值：对齐爱印「每张照片自动调到范围内」，省去逐张手动点「自动构图」。

2. **美颜设为可选默认档**（不再默认「关」）
   - 已实现：`beautyLevel` 默认 `'natural'`（自然档），用户可切回「关」或更高档；与爱印默认开美颜一致。
   - 价值：导出体积/观感更接近爱印（此前对比爱印 78.9KB vs 超誉 24.1KB，主因即默认美颜）。

### 仍可继续补齐（非本次范围）

- 真·人物下半身分割（MediaPipe selfie-multiclass）以更精准判断「下方不足」，放大填满才会真正只在必要时触发（当前用整图底近似）。
- 多尺寸同时导出时「每个尺寸按自身规格重新构图」（爱印支持，超誉当前单规格）。
