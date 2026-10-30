# 证卡识别「增强模型」：爱印记卡矫正 FP32 接入（方案 A）

日期：2026-10-30。目标：对齐并超越爱印「证卡拼版助手（增强模型）」的识别质量。

## 背景与取证

用户用 `D:\50\身份证正面` 实拍对比，超誉识别「需检查」比例远高于爱印。
根源：爱印标题里的「增强模型」是一个真实 ONNX 模型——**卡证矫正 FP32**
（主进程注册表 `runtime-models.json` card 组，id `bbf5b9b22c4142c5`），
我们此前复刻时用"梯度亚像素精修"替代了它，纯 CV 精度上限不足。

取证链（全部本机完成）：

1. 推理协议：`aiyin_decrypted_assets/vendor/id2pdf-card-correction-worker.js` 完整还原。
2. 模型本体：本机爱印 userData 明文模型不存在，但 `models/runtime/bbf5b9b22c4142c5.bin`
   是 AYE1 加密包，用已验证的 AES-256-GCM 方案解密成功（`decrypt_card_model.cjs`），
   SHA256 `bbf5b9b2…` 与注册表 id 前缀一致。
3. 张量名在模型二进制中验证：input `image` [1,3,768,768]，output `quads/scores/angle/ftype`。

## 爱印②层协议（照抄勿改）

- 常量：`T=768` 输入、网格 `192`（stride 4）、首遍阈值 `I=.3`、已找到卡阈值 `st=.1`、
  重叠判定 `it=.25`、涂白循环阈值 `L=.03`、面积比 `ct=.5`、贴边停止 `room<0.3`、
  BGR 均值 `[.408,.447,.47]` 标准差 `[.289,.274,.278]`、`maxPages=2`（oF）、
  `minAreaFrac=.04`（aF）、单请求超时 120s（rF）。
- 流程：整图→768² 双线性归一化→解码（包含去重+阈值过滤）→逐张接受→
  单应 warp（输出尺寸=对边中点距）→按 angle 90° 摆正→
  首卡贴边 room<0.3 则停→已找到卡面在**工作副本**上涂白→循环找第二张。
  warp 始终用**原始图**（非工作副本）。

## 实现（本仓库）

| 文件 | 内容 |
|---|---|
| `src/lib/cardCorrectMl.ts` | 纯逻辑 1:1 移植（单应/解码/接受/贴边/warp/旋转/涂白/主循环），推理经 `ModelRunner` 注入，DOM-free 可单测 |
| `src/lib/cardCorrect.worker.ts` | onnxruntime-web Worker：模型按 URL 拉取常驻，请求串行，输出 transfer 回传 |
| `src/lib/cardCorrectClient.ts` | 主线程客户端：Worker 单例、**120s 超时→销毁重建**（ort wasm 偶发挂死的护栏）、warp 结果压到长边 1100、角点归一化 |
| `src/tools/CardLayout.tsx` | 导入主路径改为「增强模型优先（默认开）→ 未检出/失败回退经典 CV」；右栏新增「增强模型」开关与「图片间距 0–60mm」滑杆 |
| `resources/card-model/card-correction-fp32.onnx` | 模型（41.4MB，随包预装，自包含仓库） |

模型路径直接产出 `corrected`（已 warp+摆正），confidence=模型 score；
`quad` 用 uprightCorners 归一化，手动裁切/换类型重 warp 与经典 CV 共用同一条路。

## 真机基准（tools/bench_card_model.py）

D:\50\身份证正面 实拍 30 张，同一页面模型开/关对比（report 在 `.tmp/bench-card-model/`）：

| 指标 | 增强模型 | 经典 CV |
|---|---|---|
| 徽标分布 | **30 已校正 / 0 需检查** | 18 已校正 / **12 需检查** |
| 平均置信度 | **98.8%** | 78.4% |
| 校正图长宽比最差偏差 | **5.2%** | 15.9% |

结论：模型路径消灭了「需检查」（用户原始痛点），角点精度显著优于 CV。

## 已知边界

- 模型只认**真实证件照片**：纯合成卡面实测最高分 ~0.15 且定位到文字块，
  `cardCorrectMl.ort.test.ts` 因此只做协议断言，质量基准必须走真机照片。
- 单张推理 ~4-6s（wasm 单线程）；批量 30 张约 2-3 分钟，进度在 cbar 显示。
- ort wasm 偶发挂死（历史已知坑）：客户端 120s 超时销毁 Worker，该张回退 CV。

## 顺手修复的真 bug（复现→修复→探针留档）

`<input type=file>` 第二次选择**相同文件**不触发 change（value 未清空）。
触发路径：导入 → 清空 → 再导入同一批照片 = 无反应。
修复 6 处（CardLayout / BatchPrint ×2 / IdPhotoLeft ×2 / OfficeToPdf），
修后处理统一为 `onChange` 内 `e.currentTarget.value = ''`。
回归探针：`python tools/probe_reimport.py`（导入→清空→重导，断言 change 计数=2）。

## 门禁

`tsc` 干净 · `npm test` 749 passed/3 skipped · `verify:wiring` OK ·
`verify:card` 12 项（无 electronAPI 时走 CV 回退，行为不变）·
真机基准 `tools/bench_card_model.py --n 30 --mode both`。
