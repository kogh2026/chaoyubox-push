# 爱印官方 vs 自研 — 像素级同屏对照 harness

把「爱印官方输出」与「自研（本项目）输出」逐像素对照，同屏并排呈现、自动定位差异区域。
本目录是**基础搭建**（可运行、可复现、可扩展），四个要素在下面逐条写清。

---

## 1. 输入数据来源

| 项 | 来源 | 说明 |
|---|---|---|
| 测试图 | `D:/50/身份证正面`（51 张）、`D:/50/身份证反面`（51 张） | 真实拍摄的身份证正反面，共 102 张；配置在 `config.json.images.dirs` |
| 官方模型权重 | `resources/card-model/card-correction-fp32.onnx` | 爱印「卡证矫正 FP32」解密件（41.4 MB，SHA 前缀 `bbf5b9b2`） |
| 官方 worker 源码 | `../aiyin_decrypted_assets/vendor/id2pdf-card-correction-worker.js` | 爱印桌面 app 里被调用的**原始** worker（minified，7.8 KB） |
| ort 运行时 | `node_modules/onnxruntime-web/dist` | 与爱印 app 同款 wasm 后端（v1.21.0） |

> **不截图**。这里的对照基准全部是**真实像素数据**，不是屏幕截图——截图会引入缩放、
> 抗锯齿、显示器色彩管理等噪声，无法做像素级判定。GUI 截图路径见 §2 末尾。

---

## 2. 比对对象

### 官方侧：`official_worker`（默认，最高保真）
把爱印 worker 的 **JS 源文件原样 `eval`** 在 Node 里执行（`official_worker_node.cjs`），
不做任何算法移植：

- 宿主能力用最小垫片补齐：`self` / `importScripts` / `postMessage` / `ImageData`；
- worker 内部会把 `ort.env.wasm.wasmPaths` 改写成浏览器绝对路径 `/vendor/onnxruntime-web/`，
  在 Node 下会被解析成 `D:\vendor\...` → 用属性拦截把该赋值重定向到真实 dist 目录
  （`file:///.../node_modules/onnxruntime-web/dist/`），其余行为与浏览器一致；
- 输入 `{id, modelId, modelBytes, imageData:{data,width,height}, maxPages, minAreaFrac}`；
- 输出 `pages[].imageData`（透视矫正后的 RGBA 卡面）+ `corners` + `score` + `angle`。

因此官方侧产出 = 爱印 app 内 worker 的产出（同一份 JS、同一份权重、同一 wasm 后端）。

**备选 `official_model`**：`adapter_official_model.py` 是纯 Python 复刻（无 Node 时可用）。采样口径已与官方
`J()` 对齐（纯 `c/o`、无 `+0.5` 像素中心补偿），实测与官方 worker **逐页 mae≈0.48 / max=1**（单 LSB，来自
wasm 与 onnxruntime 的浮点累加顺序差异），旋转 0/90/180/270 四档同样成立。
等价性由 `verify_parity.py` 守门（见 §5），改完移植版务必跑一次。

**GUI 截图路径（未启用）**：`target: "gui"` 预留。本机 `ms-playwright` 浏览器二进制缺失
（`chromium_headless_shell-1248` 不存在），无法启动官方桌面 app 抓画布；且 **GUI 显示的就是
worker 输出**，像素信息量不比 worker 多，反而是截图链路会引入额外噪声。故基础版以 worker 为准。

### 参考侧：`reference_dumps`（自研）
自研 app（`src/tools/CardLayout.tsx` + `lib/cardCorrectMl.ts`）在 Chromium 里真实渲染后
落盘的 PNG 裁图：`.tmp/regress/post/model__<目录>/<idx>_<原图名>.png`，
由 `tools/bench_regress.py --dump` 生成。

---

## 3. 输出形式

```
<out>/
├── official/           官方侧裁图（PNG，无损）+ manifest.json（页数/score/angle/corners）
├── side_by_side/       三栏并排图：参考 | 官方 | 差异热力图（含 bbox 高亮）
├── gallery.html        同屏对照图库（可按 verdict 过滤，图片懒加载）
├── report.json         逐卡明细 + 聚合 + worst10
├── summary.md          Markdown 摘要
└── run.log             运行日志
```

差异热力图配色：

| 颜色 | 含义 |
|---|---|
| 灰 | 无差异 |
| 红→黄 | 内容差异（亮度按差值放大 6×），阈值取自 `diff_threshold_per_channel`（默认 8） |
| 蓝 | **越界填充口径差异**：一侧纯白(≥245)、另一侧纯黑(≤10) |
| 黄框 | 内容差异的包围盒（不含蓝色填充区） |

---

## 4. 像素一致的容差标准

参考侧是**有损**的：自研 app 的裁图经 `canvas.toDataURL('image/jpeg', 0.92)` 落盘
（`src/lib/cardCorrectClient.ts:162`），官方 worker 给的是无损 RGBA。
即使算法完全等价，也会出现 mae≈1、max≈20。所以**不能用绝对阈值**，本 harness 用三层归因：

### 4.1 噪声地板归一化
把官方图按**同参数** q0.92 往返一次，得到纯编码噪声地板 `noise_mae`；
实测 `noise_ratio = interior_mae / noise_mae`。**ratio ≤ 1 即差异完全由编码噪声解释**。

### 4.2 三类差异分离
| 类型 | 处理 |
|---|---|
| 编码噪声 | 用 ratio 归因（§4.1） |
| 重采样误差 | 参考侧被 app 降到 1100 长边、官方是原生（可达 2000+）。尺寸不同时 LANCZOS 对齐并置 `resized=true`；另算 `structSSIM`（两侧缩到 192px、裁掉 2% 边缘）抗重采样 |
| 越界填充口径 | 自研填白 / 爱印填黑（**已知设计差异**）。按内容识别（一侧≥245 且另一侧≤10）后从主裁决剔除，只置 `border_flag` |

边框环宽度自适应（≥ min(维度)×0.6%，至少 2px），避免几像素宽的填充带漏进"内部"把 `max_diff` 顶爆。

### 4.3 分档（`config.json.tolerance`）

| 档 | 条件 | 含义 |
|---|---|---|
| `exact` | 内部 `max_diff==0` 且 `fill_frac==0` | 逐位相同 |
| `strict` | 内部 `max_diff≤12` 且 `noise_ratio≤0.90` 且 `structSSIM≥0.9990` 且 `fill_frac≤0.05%` 且**未降采样** | 差异低于编码噪声，像素级等价 |
| `pass` | 内部 `max_diff≤40` 且 `noise_ratio≤1.80` 且 `structSSIM≥0.9950` 且 `fill_frac≤2%` | 差异可由编码噪声解释（算法等价） |
| `warn` | 内部 `max_diff≤72` 且 `noise_ratio≤3.50` 且 `structSSIM≥0.9800` | 有可测差异，需人工看并排图 |
| `fail` | 以上都不满足 | 真实不一致 |

主判据是 `noise_ratio`；`structSSIM` 只作结构兜底（参考侧被 JPEG 压过，天然落在 0.998~0.9995，
当精密尺子会误伤）。自测 `test_lib_diff.py` 用合成图锁定这四类情形的判定口径（5/5 通过）：
逐位相同→`exact`、JPEG q92 往返→`pass`(ratio≈1.00)、白/黑填充→`pass`+`border_flag`、
内容位移 12px→`fail`、2× 放大（降采样场景）→`warn`+`resized`。

---

## 5. 移植版一致性门禁（`verify_parity.py`）

`official_model` 是"官方输出的替身"，一旦它与官方 JS 有口径偏差，偏差会被记到"官方"账上，
污染整份报告。所以它必须自己先被验证：

```bash
python tools/aiyin_compare/verify_parity.py --limit 6      # 默认取新数据集前 6 张
```

| 项 | 说明 |
|---|---|
| 基准 | `official_worker`（爱印真 JS + 真 FP32 权重 + ort-wasm） |
| 被测 | `official_model`（Python 移植，`SAMPLE_OFFSET=0`） |
| 同时跑 | `SAMPLE_OFFSET=0.5` 的历史实现，输出 before/after 两列 |
| 判定 | 每页 `mae < 1.0` 且 `max_diff ≤ 2` → PASS |
| 退出码 | 0 等价 ｜ 1 不等价（不可用移植版当基准）｜ 2 运行错误 |

实测（2026-10-31，新数据集 `身份证人像面`，含 angle=1 的旋转卡）：

| 样本 | 修复后 mae / max | 修复前 mae / max |
|---|---|---|
| 130535198906280022 | 0.4544 / 1 | 1.490 / 66 |
| 140902200706250079 | 0.4939 / 1 | 3.384 / 49 |
| 152103199005057242 | 0.4827 / 1 | 2.165 / 86 |
| 152527198708240025 | 0.4650 / 1 | 1.489 / 43 |

`max=1` 是 wasm 与 onnxruntime 的浮点累加顺序差（单 LSB），已到移植精度的物理下限。

---

## 6. GUI 截图 adapter（`adapter_official_gui.py`）

前面两条官方侧路径（`official_worker` / `official_model`）都停在**裸像素**，没有「画到 canvas →
合成上屏」这一段。真实用户看到的差异只可能出现在这一段：色彩管理、CSS 缩放、DPR、预乘 alpha。
GUI adapter 就是来覆盖它的。

### 6.1 前置：安装 Playwright 浏览器依赖（**必须先做**）

```bash
python -m playwright install chromium        # 首次约 150 MB
```

只装 Python 包不够——`playwright` 的驱动和浏览器是两回事。缺浏览器时 adapter 会直接抛出
带上面这行命令的中文提示，而不是 Playwright 的英文堆栈。离线环境可设 `PLAYWRIGHT_BROWSERS_PATH`
指向已有浏览器目录。

### 6.2 两种模式

| 模式 | 做法 | 用途 |
|---|---|---|
| `render`（默认，可进 CI） | 本目录 `gui_host.html` 起宿主页：把 vendor worker 作为**真 Web Worker** 加载（`/vendor/card-correction-worker.js` + `/vendor/onnxruntime-web/ort.min.js`，与爱印 app 内的绝对路径一致），worker 返回的 `ImageData` 用 `putImageData` 画到 1:1 的 `<canvas>` | 验证「worker 产出 → canvas → 屏幕」这一段；完全确定性、可无人值守 |
| `attach`（真机） | `chromium.connectOverCDP()` 接管**已在运行**的爱印桌面端 | 需要官方 app 自身外壳/图标的证据时用 |

`attach` 用法：

```bash
# 1) 带调试端口启动官方桌面端（Electron 支持 CDP）
"爱印工具箱.exe" --remote-debugging-port=9222
# 2) 在 app 里手动导入图片、等识别完成
python -c "
from tools.aiyin_compare.adapter_official_gui import OfficialGuiAdapter
OfficialGuiAdapter('', '').attach_app('.tmp/aiyin_gui_attach')"
```

`attach` **不模拟 UI 点击**（不绑定官方交互逻辑），只负责「找到画布 → 抓画布像素 + 截图」。

### 6.3 输入 / 输出

| 项 | 内容 |
|---|---|
| 输入 | 与原图**同像素**的 PNG（用 PIL 解码后重编码，隔离"浏览器 JPEG 解码器 vs libjpeg"的 ±1 差异；`--serve-original` 可关掉）+ 官方 FP32 ONNX + vendor worker JS + `node_modules/onnxruntime-web/dist` |
| 输出·权威像素 | `gui_canvas/<key>__p<i>.png` —— `canvas.toDataURL('image/png')` 回读，无损。**harness 把它当官方侧裁图** |
| 输出·屏幕像素 | `gui_shot/<key>__p<i>.png` —— `locator().screenshot()`，合成上屏后的真实屏幕像素 |
| 输出·元数据 | `gui/manifest.json`（画布尺寸/CSS 尺寸/DPR/score/angle/passes/room/耗时/错误） |
| 输出·对照条 | `side_by_side/<key>__p0__gui.png` —— 画布 ｜ 截图 ｜ 截图−画布(噪声) ｜ 截图−worker(差异) 四栏 |
| 返回值 | 与 `OfficialWorkerNode.run_batch` 同构（`{key: [{page, png, shot, width, ...}]}`），harness 可直接换用 |

### 6.4 调用方式

```bash
# 独立自测（打印三个差值与判定）
python tools/aiyin_compare/adapter_official_gui.py --limit 2
# 验证 CSS 缩放链路的额外损失（画布被放大 1.5× 显示）
python tools/aiyin_compare/adapter_official_gui.py --limit 2 --css-scale 1.5
# 走 harness 全链路（GUI 侧当官方侧，参考侧仍是自研 dump）
python tools/aiyin_compare/harness.py --official-adapter official_gui --limit 3 \
    --out .tmp/aiyin_compare_gui
```

### 6.5 截图对比判定逻辑

截图**不可能**与像素数据逐位相同，所以 `lib_gui_diff` 用**自指噪声地板**，而不是绝对阈值：

```
floor_mae   = |截图 − 同一块画布的回读|          ← 只含"截图/上屏"引入的噪声
content_mae = |截图 − worker 原始 RGBA(对齐后)|   ← 用户看到 vs 算法产出
ratio       = content_mae / floor_mae
```

| 判据 | 阈值 | 含义 |
|---|---|---|
| `gui_exact` | 尺寸一致（未重采样）且 `floor_mae ≤ 0.5` 且 `canvas_vs_worker_mae ≤ 0.5` 且 `structSSIM ≥ 0.9995` | 截图与画布**逐位等价**（DPR=1 且 1:1 显示时的正常结果） |
| `gui_ok` | `ratio ≤ 1.5` 且 `structSSIM ≥ 0.995` | 截图相对 worker 的偏差不超过截图自身噪声（忠实） |
| `gui_warn` | `ratio ≤ 3.0` 且 `structSSIM ≥ 0.98` | 有可见偏差（缩放/色彩管理），需看差异条 |
| `gui_fail` | 其余 | 内容被改动（错页、裁错、黑边、丢帧） |

三个差值的诊断含义：

| 差值 | 非 0 说明 |
|---|---|
| `canvas_vs_worker_mae` | canvas 2D 改过像素（alpha 预乘 / 色彩管理） |
| `floor_mae` | 上屏链路有损失（CSS 缩放、DPR≠1、抗锯齿） |
| `content_mae` | 用户看到的内容 ≠ 算法算出的内容 |

> **为什么还要 structSSIM**：如果偏差发生在「画布回读本身就与截图不同步」（例如截到了上一帧），
> `floor_mae` 和 `content_mae` 会**同步变大**，ratio 仍是 1.00，只看 ratio 会漏判。
> `structSSIM` 是唯一能抓住这类结构性错位的兜底判据——自测用例 `t_content_shift`
> 就是这样被拦下的（ratio=1.00 但 structSSIM=0.926）。

自测：`python tools/aiyin_compare/test_lib_gui_diff.py`（6/6 通过），锁定
逐位相同→`gui_exact`、JPEG 压一次→`gui_ok`(ratio≈1)、内容位移→`gui_fail`、
画布被篡改→不判 `gui_exact`、无 worker 基准→退化模式、四栏条出图。

### 6.6 实测（2026-10-31，4 张真实身份证，DPR=1）

| 场景 | 画布vsWorker | 截图vs画布 | 判定 | 说明 |
|---|---|---|---|---|
| 1:1 显示（默认） | 0.0000 | **0.0000** | `gui_exact` | 截图与画布、与 worker **三者逐位相同** |
| CSS 放大 1.5× 显示 | 0.0000 | 0.25 / 0.73 | `gui_ok` | 缩放链路代价极小，且被正确降档而非误判 |

**结论**：爱印画布→屏幕这一段在 1:1 显示下**零损失**；`canvas.toDataURL` 与 worker 裸 RGBA 也逐位相同
（`canvas_vs_worker_mae = 0.0000`）。所以 GUI 截图路径的价值不在"发现像素误差"，
而在**证明这段没有误差**，以及将来若出现缩放/色彩管理改动，能被 0 阈值立刻抓住。

两条踩过的坑（已固化进代码）：

- **画布落在分数坐标**（flex 居中 → 6.5px）→ 截图被浏览器重采样，mae≈2~5，会误判成"上屏有损"。
  改为绝对定位 + JS 算整数 `left/top`（`window.__snap`）。
- **画布宽于视口**时居中的 flex 容器向左溢出，元素截图 clip 错位 → mae 飙到 131。
  adapter 现在按 CSS 尺寸把视口贴合画布（+24px 边距）后再对齐。

---

## 7. CI 回归门禁

把上面所有东西变成**能拦住合并**的判定。入口是 `ci_gate.py`（EXIT 码即结论）。

### 7.1 触发条件

| 场景 | 触发 | 跑什么 |
|---|---|---|
| PR 改动命中像素链路 | `pull_request` + paths 过滤：`src/lib/cardCorrect*`、`cardDetect*`、`cvGeometry*`、`specFraming.ts`、`src/tools/CardLayout.tsx`、`resources/card-model/**`、`tools/aiyin_compare/**`、`tools/bench_regress.py` | `engine-selfcheck`（必跑） |
| 合并进 main | `push: branches: [main]` | 同上（防止绕过 PR 直接推） |
| 每夜 | `schedule: 17 2 * * *` | 全量 `pixel-gate` |
| 手动 | `workflow_dispatch`（可传 `limit` / `mode`） | 全量 `pixel-gate` |
| PR 打了 `aiyin-pixel` 标签 | `pull_request` + label | 全量 `pixel-gate` |
| 本地推送 | husky `pre-push`（`tools/git-hooks.mjs`） | 动到像素链路时追加 `selfcheck` |

### 7.2 执行步骤

```bash
# ① 引擎自测（数据无关，秒级~1分钟）：lib_diff / lib_gui_diff / 移植版等价性
python tools/aiyin_compare/ci_gate.py --mode selfcheck

# ② 全链路：重生成参考侧 dump → harness 对照 → 门禁判定（一条命令跑完）
python tools/aiyin_compare/ci_gate.py --mode full --out .tmp/aiyin_gate \
    --official-adapter official_model --require-baseline            # 全量
python tools/aiyin_compare/ci_gate.py --mode full --limit 20        # 冒烟（自动 --partial）

# ③ 只判定已有报告（最常用：先跑 harness，再反复调策略）
python tools/aiyin_compare/ci_gate.py --mode report \
    --report .tmp/aiyin_compare/report.json --require-baseline
```

CI 里分两个 job：`engine-selfcheck`（windows-latest，必跑、设为 required check）和
`pixel-gate`（自托管 runner：身份证照片**不能进仓库**，需要 runner 上挂 `AIYIN_DATASET_DIR`
与 `.tmp/regress/post`；否则该 job 不跑而不是假绿）。

> CI 默认用 `official_model` 当官方侧：爱印 vendor worker 的 JS 不在仓库里（在
> `aiyin_decrypted_assets/`），而移植版已被 `verify_parity.py` 证明与它逐页等价（mae<0.5, max=1），
> 所以 CI 不需要那份私有 JS。要跑 `official_worker`/`official_gui` 时相应 runner 上必须有该文件。

### 7.3 失败判定标准（四层，缺一层就会漏）

| 层 | 检查项 | 阈值（`gate_policy.json`） | 拦什么 |
|---|---|---|---|
| 绝对 | `no_fail` | `fail == 0` | 真实不一致 |
| 绝对 | `warn_budget` | `warn/paired ≤ 8%` | "需人工复核"的卡泛滥 |
| 绝对 | `pairing_coverage` | `paired/total ≥ 95%` | 官方侧大片没检出/没产出 |
| 相对 | `baseline_drift` | 平均内部 MAE `≤1.25×` 基线；structSSIM 下降 `≤0.002`；exact+strict 占比下降 `≤5pp` | **整体悄悄变差**（20 张 exact→pass，fail 仍是 0） |
| 逐卡 | `per_card_regression` | 降档卡数 `≤0` | 单卡从 pass→warn、warn→fail |
| 集合 | `no_missing_baseline_cards` | 缺失 `≤0` | 测试集被悄悄缩减/参考侧 dump 缺号 |
| GUI | `gui_no_fail` / `gui_warn_budget` / `gui_coverage` | `gui_fail==0`、warn ≤10%、覆盖 ≥95% | 屏幕看到的内容 ≠ 算法产出 |

> 第 4/5/6 层是"fail==0 就放行"这种门禁**必须**补的：只数 fail 的门禁对"整体降质"完全失明。

### 7.4 报告输出形式

| 产物 | 内容 | 用途 |
|---|---|---|
| 退出码 | `0` 通过 ｜ `1` 门禁不过 ｜ `2` 运行错误 | **CI 靠它阻断合并** |
| `gate_summary.md` | 每个检查项 PASS/FAIL + 明细 + 失败卡清单 | 人读；也塞进 `$GITHUB_STEP_SUMMARY` |
| `gate_result.json` | `{passed, meta, checks[]}` | 机读 / 二次处理 |
| `junit.xml` | 每个检查项一个 testcase，失败带 message | CI 测试报告直接渲染 |
| `::error::` 注解 | 失败项与失败卡逐条打到 stdout | PR 页面里直接显示成错误行 |
| artifacts | `report.json`、`gallery.html`、`side_by_side/**` | 30 天留存，回溯用 |

### 7.5 怎么做到"阻断合并"

1. **本地**：husky `pre-push` → 动了像素链路就跑 `selfcheck`，`exit 1` 直接把 push 打回。
   绕过：`git push --no-verify`（要求提交信息写明原因）。
2. **CI（需仓库有远端）**：把 `engine-selfcheck` 设为 main 分支保护的 **required status check**。
   私有前提下，**只有 required check 全绿才能 merge**。`pixel-gate` 若也设为 required，
   必须配自托管 runner（否则 job 不产生结果，PR 会卡住）。
3. **门禁自己也要被测**：`test_gate_negative.py` 用 9 个构造用例验证"该拦的都能拦住"
   （1 张 fail、warn 超预算、逐卡降档、整体漂移、缺卡、覆盖率崩、GUI fail、产物落地）。
   它跑在 CI 的第一步——防止有人把门禁改成永远 PASS。

```bash
python tools/aiyin_compare/test_gate_negative.py    # 9/9 通过
python tools/aiyin_compare/ci_gate.py --write-baseline \
    --report .tmp/aiyin_compare/report.json          # 确认无回归后才允许改写基线
```

> 当前仓库尚无远端，`git remote -v` 为空，所以 2 的"required check"要在接远端后配置一次；
> 1 与 3 已生效。

---

## 用法

```bash
# 默认（官方 = Node 托管爱印真 worker，参考 = 自研 dump）
python tools/aiyin_compare/harness.py

# 冒烟：每目录前 8 张
python tools/aiyin_compare/harness.py --limit 8 --out .tmp/aiyin_compare_smoke

# 只调比对逻辑、复用已生成的官方裁图（不重跑模型）
python tools/aiyin_compare/harness.py --reuse-official --out .tmp/aiyin_compare_smoke

# 无 Node 时用 Python 移植版
python tools/aiyin_compare/harness.py --official-adapter official_model
```

前置：参考侧 dump 需先由 `python tools/bench_regress.py --dist dist --dir ... --dump .tmp/regress/post`
生成（或改 `config.json.reference.dumps_dir` 指向已有目录）。

## 文件

| 文件 | 职责 |
|---|---|
| `harness.py` | 编排：读配置 → 批量跑官方侧 → **内容指纹**配对（24×24 灰度 NCC，≥0.90，避免 dump 缺号错配）→ diff → 出报告 |
| `official_worker_node.cjs` | Node 里原样托管爱印 worker |
| `adapter_official_worker.py` | 官方侧 Python 适配器（raw RGBA 进、PNG 出，模型只加载一次） |
| `adapter_official_model.py` | 官方侧纯 Python 移植（无 Node 时用，已与官方 worker 逐页等价） |
| `adapter_official_gui.py` | GUI 侧适配器（Playwright：真浏览器 worker → canvas → 截图；`attach` 模式可接管官方 app） |
| `gui_host.html` | GUI 宿主页（复刻「worker 产出 → canvas → 屏幕」这一段） |
| `adapter_reference.py` | 参考侧 dump 读取与配对索引 |
| `lib_diff.py` | 指标计算、三类差异分离、分档裁决、三栏并排图 |
| `lib_gui_diff.py` | 截图保真度判定（自指噪声地板 + 四栏对照条） |
| `lib_report.py` | JSON / Markdown / 日志 |
| `lib_viz.py` | gallery.html 同屏对照图库 |
| `ci_gate.py` | **CI 门禁**：report / full / selfcheck 三模式，退出码即结论 |
| `gate_policy.json` | 门禁阈值（改它等于改合并门槛） |
| `baseline.json` | 已验收基线（102 张卡的裁决与指标），漂移/降档判定的参照 |
| `verify_parity.py` | 移植版 vs 官方 worker 等价性门禁 |
| `test_lib_diff.py` / `test_lib_gui_diff.py` / `test_gate_negative.py` | 引擎自测 / 截图判定自测 / **门禁反向自测** |
| `config.json` | 全部可调项 |

## 实测结果（2026-10-31，102 张全量）

```
exact 71 ｜ pass 27 ｜ warn 4 ｜ fail 0
差异归因：bit_identical 71 ｜ resampler 30 ｜ jpeg_noise 1
平均内部 MAE 1.45/255 ｜ 平均噪声比 1.08 ｜ 平均 structSSIM 0.9986
官方侧：102/102 检出，0 错误，742.5 s（单线程 wasm，约 7.3 s/张含模型加载）
```

**核心结论：71/102 张卡在「按 canvas 参数 q0.92 + 4:2:0 重编码官方图」后与自研侧
逐位相同**。也就是说这两条链路的 warp 输出是同一份像素，差别只在一次 JPEG 编码。

这是一条可直接复现的硬判据，而不是"看起来一样"：

| 图（430623199107254528 反面） | mae | max | 像素差>40 占比 |
|---|---|---|---|
| 实测 自研 vs 官方 | 2.765 | 80 | 0.3589% |
| 官方图按 q92/**4:2:0** 重编码 | 2.765 | 80 | 0.3589% |
| 官方图按 q92/4:4:4 重编码（错的口径） | 2.147 | 27 | 0.0000% |

> 这一行解释了为什么必须用 4:2:0：`canvas.toDataURL('image/jpeg',0.92)` 走的是 4:2:0，
> 用 4:4:4 会低估噪声地板，把国徽这类高饱和红色区域的**纯编码伪影**误判成算法差异
> （早期版本因此误报 2 张 `fail`）。

剩余 30 张的差异全部可归因为**重采样器不同**：自研侧被 `downscaleLong` 压到 1100 长边
（官方原生最大 2615px），浏览器 canvas 的 high-quality 缩放与 PIL LANCZOS 不可能逐位一致。
其中 26 张仍在 `pass`，4 张落到 `warn`（ratio 1.9~2.25），结构相似度全部 ≥0.9985。

**顺带证实一条设计差异**：2 张卡检出「越界填充」口径不同——自研填白、爱印填黑；
在 `430105198108200543` 上爱印输出右侧/底部出现大片黑边，自研填白后是干净白边。
从成品观感看**自研更优**（黑边会被当成坏图）。这条已从主裁决剔除，只置 `border_flag`。

## 已知边界

- 参考侧 dump 可能缺号（`bench_regress.py` 只在 `src` 已是 dataURL 时落盘，多卡图首张可能未就绪）→ 内容指纹配对 + 缺失记为 `n/a` 结构性差异。
- `--reuse-official` 依赖文件名约定 `<dir>__<name>__p<i>.png`。
- 官方侧为单线程 wasm（`numThreads=1`），单图约 1–4 s；102 张约 10–15 min。
