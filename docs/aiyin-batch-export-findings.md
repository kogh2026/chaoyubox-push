# 爱印批量导出：逆向结论（2026-10-29）

> 来源：`aiyin_decrypted_assets/assets/export-DCg5OXfg.js`（252KB，AYE1 加密资源的明文模块）。
> 方法：解密后的 ESM 模块未混淆到不可读，靠导出表（`export{...}`）反查函数角色，再逐个读实现。
> 边界：本次只读了导出模块与批量 demo 模块，工作区/UI 编排层（`ai-id-photo-workspace-*.js`）不在这批明文里。

## 一、导出模块的对外契约（导出表直接给了名字）

```
ID_PHOTO_PAPERS        R5(127×88.9) / R6(152.4×101.6) 相纸预设
buildIdPhotoPaperSheets 按相纸拼版，出「一张纸」的排版结果
buildIdPhotoPaperPdf    把拼版结果写成 PDF（jsPDF，unit=mm，每张一个 page）
resolveSheetNoteText    页脚备注文本解析（{纸张}/{文件名} 占位符）
DEFAULT_SHEET_NOTE_TEXT 请使用{纸张}相纸打印-{文件名}
LEGACY_SHEET_NOTE_TEXT  请使用{纸张}打印
SHEET_FOOTER_HEIGHT_MM  12
SHEET_NOTE_FONT_SIZES_MM [1,1.5,2,2.5,3,4,5,6] mm 逐档试
SHEET_NOTE_FONT_SIZE_RANGE_MM {min:0.5,max:10}
SHEET_NOTE_MAX_LENGTH   40 字
formatSheetJobNumber    yymmdd-HHMMSS
sheetCode               名字-01（两位序号）
```

这组名字本身就是设计结论：**相纸排版、PDF 组装、页脚备注、工单号**四件事被拆成四个可单测的纯函数，
UI 只负责串起来。

## 二、三条硬实现细节

### 1. JPEG 按「目标体积」反解质量（Vf）

```js
if (!maxBytes) return encode(quality = 1);          // 没有体积要求 → 直接最高质量
if (size(1) > maxBytes) {                           // 太大 → 二分
  lo = 0.05; hi = 1;
  for (let i = 0; i < 12; i++) { mid = (lo+hi)/2; ... }
}
metRange = size <= maxBytes && size >= minBytes;    // 还记录是否落在 [min,max] 区间
```

要点：
- **默认质量是 1，不是 0.92**。只有给了 `maxBytes` 才降质量，且降到刚好够为止。
- 二分固定 12 次（0.05~1 区间精度约 0.0002），不追求无损，追求「一次编码就定」。
- 同时支持 `minBytes`（有的报名系统要求「不小于 100KB」），并回传 `metRange` 让 UI 提示。
- 编码走 **Worker + OffscreenCanvas**（`createImageBitmap` 转移 bitmap），主线程只等 Promise，失败才回退主线程 `toBlob`。

### 2. DPI 写进文件本身（wu / C0 / jf）

- JPEG：编码完调 `wu(blob, dpi)` 重写 JFIF APP0 的 density 字段；
- PNG：`C0(bytes, dpi)` 改 pHYs chunk，没变就返回原 blob（避免多余拷贝）。

这条最容易被忽略：canvas 出来的 JPEG 不带有效的打印密度，放进 Word/排版软件会按 96dpi 显示成巨图。
**写进 300dpi 之后，客户拿到文件直接拖进文档就是正确尺寸。**

### 3. 客户要求文本 → 规格（U3 / o0 / r0 / n0 / e0）

`U3(text)` 一次解析出四类信息：

| 函数 | 解析内容 | 例子 |
| --- | --- | --- |
| `n0` | 尺寸，支持「宽 35mm 高 45mm」按宽高对 | 35×45mm / 413×531px |
| `o0` | DPI，72~1200 区间守门 | 300dpi / 300 像素每英寸 |
| `r0` | 体积上下限，kb/mb 归一成 KB | 不超过 500KB / 100KB 以上 |
| `e0` | 规则条款切片（用于把「要求」逐条展示给用户确认） | — |

也就是说，爱印支持**把客户发来的一段文字直接变成导出参数**，而不是让店员在十几个输入框里手填。
这正是「按规格定位」之外，另一个把人工转成自动的点。

## 三、我们现在的差距（超誉工作台）

| 项 | 爱印 | 我们 | 影响 |
| --- | --- | --- | --- |
| 导出 JPEG 质量 | 无体积要求时 1.0，有上限才二分 | 固定 `0.95`（`matting.ts:454`） | 画质略低；报名系统「≤500KB」无法自动满足 |
| DPI 元数据 | 写入 JFIF/pHYs | **完全不写**，但界面写「300DPI」（`IdPhoto.tsx:1261`） | 客户拿到文件拖进 Word 是巨图，属对外口径不一致 |
| 相纸 PDF | 页脚可配备注 + 工单号 + 序号 | `sheetPdf.ts` 有拼版，无备注/工单号 | 打印店交付多单时容易混 |
| 规格来源 | 可从文字解析 | 只能选预设 | 少一个「粘贴要求自动建规格」的卖点 |

## 四、可落地结论（按性价比排序）

### P0 · 导出写 DPI（✅ 已落地 2026-10-29）

在 `compositeLayer` 拿到 blob 之后、`saveBatch` 之前插一步：读 JPEG 的 APP0，把 density 改成
`[单位=英寸, x=300, y=300]`；PNG 改 pHYs。验收：导出后 `exiftool`/自写解析读到的 dpi = 300，
Word 里插入图片默认显示 2.54cm 宽（一寸照 25×35mm 正确）。

> 顺带修掉口径：界面写 300DPI，文件里就必须真有 300DPI。

**实现与实测**：`src/lib/dpiTag.ts` 的 `withJpegDpi()`（只改 JFIF APP0 的 units + 两个 density
共 4 字节，不增删任何字节；结构不符原样返回）。三个落盘口全部接上（单张保存、单规格批量、
多规格批量），DPI 取 `cardLayout.DEFAULT_DPI = 300`，与像素换算同源。PNG（pHYs 需重算 CRC）
当前无调用方，未做。

- 真机验证 `npm run verify:dpi`：Chromium 画布出的真 JPEG，PIL 读回
  `raw: unit=0 dpi=[] → tagged: unit=1 dpi=(300,300)`，长度 2817 → 2817 不变、像素逐字节相同。
- 端到端验证 `npm run verify:export`：真实导出 6 份（单规格 2 + 多规格 4）全部 300 DPI。


### P1 · 「目标体积」下拉（≤200KB / ≤500KB / ≤1MB / 不限）

复刻 `Vf` 的二分：只对有上限的档位启用，12 次迭代，返回实际质量与是否达标，UI 显示「已压到 480KB（质量 0.62）」。
默认仍是最高质量，避免悄悄降质。

### P2 · 相纸 PDF 加页脚备注 + 工单号

`sheetPdf.ts` 已经在生成 PDF，增加三件事即可：页脚 12mm 区、备注模板（`{纸张}`/`{文件名}` 占位）、
工单号 `yymmdd-HHMMSS` 与 `名字-01` 序号。字号按 `[1..6]mm` 逐档试，放不下再缩——这比固定字号省事且不溢出。

### P3 · 客户要求文本 → 规格（先做解析，不急着上 UI）

把 `o0/r0/n0` 的逻辑实现成 `parseRequirement(text)` 纯函数（正则 + 单位归一），先用于
「导入照片时如果文件名带『二寸 300dpi』就自动选规格」，验证准确率后再做粘贴框。

## 五、没抄的部分（及原因）

- **Worker + OffscreenCanvas 编码**：我们已在 Worker 池里跑抠图，编码再进 Worker 收益有限，
  且 Electron 主线程本就不阻塞 UI；先做 P0/P1 观察再说。
- **jsPDF 组装 PDF**：我们用 pdf-lib（`sheetPdf.ts`），不为此换引擎——`FAST` 压缩换来的是体积小，
  而印刷场景更在意图像质量。
- **相纸预设 R5/R6**：我们的纸张表已覆盖 A4/A3/A5/R6，缺 R5；若真有人用 5 寸相纸再加一行数据即可。
