# 证件照：真实下半身分割 + 多尺寸独立构图

本轮补齐两项能力。核心原则：**判定要有实测依据，导出要按各尺寸自己的规格来**。

---

## 一、接入 MediaPipe selfie-multiclass 判断「下方不足」

### 1.1 原方案的缺陷

旧版判断「人物下方是否不足」用的是**整图底部近似**：

```
personBelowFrac = 1 − head.top      // 假设人物一直延伸到图片最底边
```

只要照片下半部分还有任何一个像素，就认为「下方有人」，于是永不放大。人物其实在画面中部就结束、
下方是一大片背景时，这个判断就漏了——而这恰恰是最需要「放大填满」的场景。

### 1.2 复刻爱印的真实公式

爱印明文（`aiyin_decrypted_assets/assets/export-DCg5OXfg.js`）里：

```
E = (height + M − f) / w        // 放大填满所需缩放
w = personBottom.y − headTop.y  // ← 人物真实底部（分割输入），不是图底
_ = clamp(N, m, m × 1.2)        // 默认构图最多放大 20%
bottomAnchorScale = clamp(E/_, 1, 1.35)
```

关键是 `w` 来自**真实人物底部**。这也是本轮要补的第一件事。

### 1.3 实现

| 位置 | 内容 |
|---|---|
| `src/lib/selfieMulticlassMask.ts` | `combinePersonMask()`：把 6 类置信掩码合成「人物」= bodySkin + clothes + faceSkin（排除背景/头发/others）；`personLowerBody()`：逐行判人，自顶向下刷新得到 `bottomFrac/topFrac/reachedBottom/found`；`getLowerBodySegmenter()` 单例 + `segmentPersonLowerBody()` 端到端（预缩 ≤512） |
| `src/lib/specFraming.ts` | `specAutoPlacement(..., personBottomFrac?)`：有分割时 `w = personBottomFrac − head.top`，无则回退 `1 − head.top`；新增返回 `bottomInsufficient`（是否真因下方不足才放大）与 `personBelowFrac` |
| `src/tools/IdPhoto.tsx` | `frameData` 缓存人脸 + 下半身（每张只跑一次）；`ensureFrameData()` 供自动构图 / 批量默认构图 / 多尺寸导出 / 实时预览共用 |
| `src/components/SpecFramingPanel.tsx` | 新增「下方判定 / 放大填满」两行：显示本次是按**下半身实测**还是**整图近似**，以及是否真的触发放大 |

保留回退：模型缺失、离线、分割抛错时 `lower` 为空，自动落回旧近似，不阻断出片。

### 1.4 真机实测（`tools/seg_realcheck.py`）

真实 MediaPipe + 8 张 `D:\50\寸照`（本机 model.tflite + wasm，Chromium 内跑）：

| 样本 | 人物底部 | 下方空隙 | 触底 |
|---|---|---|---|
| 8 张原图 | 0.999 | 0.001 | 8/8 |
| 8 张「下方补白 40%」 | 3 张 0.71 / 5 张 0.999 | 0.28 / 0.001 | 3/8 检出空隙 |

结论：

- **原图（已裁到人物底部）→ 判定「下方充足，不放大」，不会误触发**。这正是需求里「仅在确有必要时触发」。
  此时 `1 − head.top` 与真实下半身长度几乎相等，新旧判定一致。
- **下方真有空白时**，新方法能测出 0.28 的空隙（整图近似恒为 0，会漏判），`scaleForBottom` 随之变大，放大填满按需触发。
- **已知边界**：5 张未检出空隙的都是**白大褂 + 白背景**（模型把衣物延伸到背景里，见 §1.5）。
  这种情况判为「触底 → 不放大」，是有意的保守策略：宁可不放大，也不在无依据时裁掉人物。

### 1.5 模型边界（已写入源码注释）

`personLowerBody` 的判定依赖类别可分性。**浅色衣物 + 同色浅背景**时模型无法确定衣物在哪结束，
会把衣物置信一路延伸到画面底部。阈值扫描（像素阈值 0.4~0.7 × 行覆盖率 0~20%）都改变不了这 5 张的结论，
说明不是噪声而是模型的确定性误判。产品策略上按「已达图底」处理，不做放大。

---

## 二、多尺寸同时导出，每个尺寸独立重新构图

### 2.1 原状

`exportAll` 只导出当前 `preset` 一种尺寸；`exportSizeIds` 状态已存在但没接任何逻辑。
要做「一图多规格」，不能把当前预览图缩放裁剪——每个尺寸的 `topRatio/headRatio` 不同，头高与留白目标也不同。

### 2.2 实现

`src/tools/IdPhoto.tsx`

- 右栏「照片规格」下新增**同时导出尺寸**多选（7 个预设芯片，默认只勾当前规格，至少保留 1 个；换主规格会自动并入）。
- `exportAll` 分两条路：
  - **快路径**：只勾了当前规格 → 直接复用已合成的 `results`（零额外计算）。
  - **多尺寸**：外层遍历尺寸、内层遍历照片，每个尺寸都用自己的 `framingSpecOf(preset)` 重新调
    `specAutoPlacement`，再按该尺寸 `mmToPx(w/h)` 重建人物层、合成。
- 复用与隔离：
  - 人脸 + 下半身来自 `frameData`，**每张只跑一次**；
  - 专业匀肤与尺寸无关，按 id 缓存 `{blob, opt}`，多尺寸只做一次；
  - 人物层缓存键加入 `p.id`，同图不同尺寸不会互相命中；
  - 无脸照片的手动微调按 `outW/pxW` 比例换算到目标尺寸。
- 文件名带尺寸名：`证件照_<原名>_<规格名>.jpg`，同批一次落盘。
- 底栏与规格区实时提示 `N 规格 × M 张 = K 份`。

### 2.3 验证

- 纯逻辑单测：同一 head 对 1 寸 / 2 寸产出**不同的 zoom 与 dy**，且各自通过自己的 `verifyFraming`（头高、留白均 match）。
- 界面冒烟（`tools/preview_multisize.py`，真实 Chromium 加载构建产物）：
  7 个规格渲染、默认勾 1 个、勾第二个后底部文案变「2 规格」、面板出现「下方判定/放大填满」、至少保留 1 个、**控制台 0 错误**。

---

## 三、回归

- `npm test`：**608 passed / 3 skipped**（新增 15 项：人物掩码 3、下半身定位 5、真实底部驱动放大填满 5、多尺寸独立构图 3 减重叠计 13~15 项）
- `tsc --noEmit`：干净
- `vite build`：成功（25.6s）
- 界面冒烟：`PREVIEW_OK`
- 真实分割：`SEG_CHECK_DONE`

## 四、相关文件

- `src/lib/selfieMulticlassMask.ts` / `.test.ts`
- `src/lib/specFraming.ts` / `.test.ts`
- `src/lib/cardLayout.ts`（`framingSpecOf`）
- `src/components/SpecFramingPanel.tsx`
- `src/tools/IdPhoto.tsx`、`src/index.css`（`.idp-sizes`）
- `tools/preview_multisize.py`、`tools/seg_realcheck.py`
