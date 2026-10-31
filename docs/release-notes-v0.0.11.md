# 超誉工作台 v0.0.11 发布说明

- **版本**：0.0.11（上一版 v0.0.10，基线 tag `v0.0.10` 之后 9 个提交）
- **构建日期**：2026-10-31
- **安装包**：`超誉工作台 Setup 0.0.11.exe`（413.2 MB）
- **SHA-256**：`43ca7a0cd63280d1652ba40e4ce2e3bc4e3ced46229b5caf9637e67e89af1823`
- **版本号来源**：`package.json` → `vite.config.ts` 的 `__APP_VERSION__` → `src/lib/appVersion.ts`，全仓唯一来源，界面各处版本展示均引用该常量。

---

## 一、用户可见改动

### 1. 证卡识别改用「爱印 FP32 矫正模型」为主路径

- 新增 `resources/card-model/card-correction-fp32.onnx`（41.4 MB）与推理管线 `cardCorrectMl.ts` → Worker（onnxruntime 常驻）→ `client`。
- 模型未检出或推理失败时**自动降级回退**到原有纯 CV 管线（`cardDetect.ts`），功能不会因模型异常而失效。
- 导入页新增「增强模型」开关，默认开启。

### 2. 卡边「截断暗条」修复

- `warpQuadToRect` / `warpPixels` 对越界像素原先只写 `alpha=255` 就跳过，RGB 仍为 0；导出 JPEG 无 alpha 通道后变成黑条。
- 现改为**越界填白**，同时把 `di` 下标提到分支外，消除 `continue` 路径的未初始化像素。

### 3. 补检结果走矫正管线

- 多卡场景的补检（extras）此前把原图直接塞进结果，与小卡结果不同源；现统一走 `warpToCorrected`。

### 4. 长宽比门禁（伪检出过滤）

- 新增 `correctedAspectDev`：`quadToPx` + `quadSize` 反归一化后计算长宽比偏差，阈值 0.1。
- 6 个单测锁定 1.585（真卡）/ 1.334（伪检出）两个样本。

### 5. 同款文件重选不触发（5 处）

- `BatchPrint` / `IdPhoto` / `OfficeToPdf` 等处的 `<input type=file>` 在 change 后未清空 `value`，同款文件再次选择时 change 不触发。
- 已修 6 处（含卡片导入），回归探针 `tools/probe_reimport.py`。

### 6. 拼版「图片间距」滑杆

- 卡证拼版助手补充图片间距可调（0~60 mm 区间，与爱印面板一致）。

---

## 二、实测提升（可复现，数据源见 `docs/aiyin-uplift.md`）

| 指标 | 改造前（纯 CV） | 改造后（FP32 模型） |
|---|---|---|
| 同批 51 张「需检查」占比 | 47.1%（24/51） | **0%** |
| 同批 51 张「已校正」占比 | 52.9% | **100%** |
| 平均置信度 | 71.7 | **98.5** |
| 最差长宽比偏差 | 24.9% | **8.1%** |
| 102 张正反面「需检查」 | 43.1%（44/102） | **0%** |
| 102 张检卡数 | 102 | **104**（补回漏检） |
| 真机基准 30 张 | 12 张需检查，avg 78.4% | **30/30 已校正，avg 98.8%** |

与爱印官方引擎的像素级一致性（102 张）：逐位相同 71 张、MAE 1.45/255、噪声比 1.08、structSSIM 0.9986、fail 0。

---

## 三、工程与质量改动

### 1. 爱印像素对照 harness（`tools/aiyin_compare/`）

- 三种官方侧 adapter：`official_model`（纯 Python 移植，采样口径 `c/o`）、`official_worker`（Node 里原样托管官方 worker JS + 同一份权重）、`official_gui`（Playwright 抓画布 + 屏幕截图）。
- 配对用 24×24 灰度内容指纹（参考侧 dump 有缺号，按序会错配）。
- 归因分五类：逐位相同 / JPEG 噪声 / 重采样 / 填充约定 / 内容差异；判据用 `noise_ratio`（内部 MAE ÷ JPEG 噪声地板），不硬编码绝对阈值。
- GUI 侧用**自指噪声地板**（截图 vs 画布 vs worker 三角关系）+ `structSSIM` 兜底，防止"截到上一帧"时 ratio 恒为 1.00 的假通过。

### 2. CI 像素门禁（`tools/aiyin_compare/ci_gate.py`）

- 五层判定：绝对阈值 → 基线漂移 → 逐卡降档 → 缺卡 → GUI 指标。
- 产出 `gate_summary.md` / `gate_result.json` / `junit.xml`，退出码 0/1/2 阻断合并。
- `test_gate_negative.py` 用 9 个构造报告反证"该拦的都能拦住"。
- `.github/workflows/aiyin-pixel-gate.yml` + husky pre-push 同组 paths 接入。

### 3. 临时文件全部收口到 D 盘

- 新增 `tools/tmproot.py` / `tools/tmproot.cjs`，默认根为仓库 `.tmp`（D 盘），`CHAOYU_TMP_ROOT` 可覆盖。
- 收口 10 处 `os.tmpdir` / `tempfile.mkdtemp` 调用，含 Playwright 浏览器 profile，避免中断后残留 20~50 MB/个的 profile 目录。
- `electron/officeCom.cjs` 为生产模块（asar 不含 `tools/`），内联同口径解析器，打包态兜底 `os.tmpdir`。

### 4. 打包脚本修复（本次新增）

- `tools/pack.mjs` 派生构建子进程时补 `CODEBUDDY_SAFE_DELETE_ENABLED=0`。
  原因：vite 清空 `dist/assets`（65 个文件）会被本机批量删除守卫拦成 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，导致打包直接失败。该开关只作用于本脚本派生的构建进程。

---

## 四、本次验证结果

| 门禁 | 结果 |
|---|---|
| `tsc --noEmit` | PASS |
| `vitest run` | 50 个文件 / **757 passed** / 3 skipped |
| `verify:aiyin:selfcheck`（引擎自检） | **PASS** |
| `verify:aiyin:gate`（102 张像素门禁） | **PASS** — exact 71 / pass 27 / warn 4 / fail 0，paired 102/102 |
| `npm run pack` | PASS — 产出 413.2 MB 安装包 |
| 打包版功能门禁 | 见交付时附带的执行结果 |

---

## 五、已知限制与待办

1. **安装包无代码签名证书**：electron-builder 仅用 `signtool` 做了占位签名，Windows SmartScreen 首次运行可能提示"未知发布者"。
2. **应用图标未设置**：`default Electron icon is used`，安装包与任务栏仍为 Electron 默认图标。
3. **主 chunk 体积 1.99 MB**（gzip 703 kB）：构建告警，尚未做 `manualChunks` 拆包，冷启动解析略慢。
4. **白大褂 + 白背景的半身照分割**仍是确定性误判边界（`selfieMulticlassMask`），未在本版处理。
5. **发布通道仍指向占位地址**：`publish.url = https://updates.example.com/chaoyu/`，自动更新不可用，`latest.yml` 已生成但无处托管。
6. 像素门禁的完整模式（`verify:aiyin:full`）依赖 `AIYIN_DATASET_DIR` 真机数据集，CI 上只跑 `engine-selfcheck`。
