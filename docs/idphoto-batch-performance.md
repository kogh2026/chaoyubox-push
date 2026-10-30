# 证件照批量处理性能分析与优化（50 张 12MP 一寸照）

> 2026-10-28 实测。机器：4 核 4 线程 / 16GB RAM，Electron 45，COI 开启（ORT 多线程可用）。
> 测试集：50 张 3024×4032（12MP）JPG（`tools/make_bench_photos.py` 生成）。
> 复跑：`python tools/bench_batch50.py --label <名> --n 50 [--engine modnet]`，报告在 `.tmp/bench-batch50/`。

## 一、基线（修复前，v0.5.9 dist）

| 指标 | 数值 |
|---|---|
| 抠图 50 张（t0→全部角标） | **428.1 s** |
| 首次出图（导入→结果卡全部出现） | **484.6 s（约 8 分钟）** |
| 主线程长任务（抠图段） | 247 次 / **468 s**（界面整段假死） |
| 切换红底（整批重合成） | **41.4 s** |
| 再切回白底 | **41.5 s**（无缓存，全量重算） |
| 渲染进程 JS 堆峰值 | 407 MB |
| 单次 getImageData 最大像素 | **12.19 M（整张 12MP 原图）** |
| 进程工作集 | ~5.6 GB |

## 二、定位到的根因（按影响排序）

1. **Worker 池排队逻辑 bug（最致命）**：`mattingPool.pump()` 派发完 4 个 Worker 后，
   只要队列还有剩余就走 `drainToMain()` —— 批量 50 张时 46 张全部甩回**主线程**「并发」跑。
   后果：Worker 池形同虚设；主线程被 ORT 占满（整段 468s 长任务 → 界面假死）；
   内存暴涨（每张 12MP 解码位图 + ORT 会话）；且主线程 `matte()` 恒用 ISNet，
   **切「快速」引擎不生效**（这解释了 MODNet 基线与 ISNet 几乎一样慢）。
2. **合成在原始分辨率上做逐像素运算**：`composePhoto` 把 12MP matte 画到原尺寸画布，
   `getImageData` 单次 12.19M 像素（48MB），去晕边再分配 3×48MB 临时数组 —— 而成品只有 295×413。
   每张 ~1.1s，50 张 56s；换底色重复此过程（41s×每次）。
3. **ORT 线程超订**：@imgly 写死 `numThreads = hardwareConcurrency`，4 个 Worker 各开 4 线程
   = 16 线程抢 4 核（实测单张 8.3s 退化到 34s）。
4. **抠图输入/输出全走 12MP**：@imgly 内部恒 resize 到 1024，输入多大推理都一样慢，
   但 12MP 的解码、PNG 回传（1.3MB/张）、主线程再解码全是纯浪费。
5. **状态更新风暴**：进度/异常检测每张 setState → 50 张缩略图整表重渲染几十次。
6. **50 张 12MP `<img>` 预览**无 lazy/async，视口外也参与解码。

## 三、已落地的修复（全部在 src，已过 581 项单测 + 真机基准复测）

| 修复 | 文件 |
|---|---|
| `drainToMain` 只在「一个 Worker 都拿不到」时触发；主线程回退改**串行**，不再并发锁死 | `mattingPool.ts` |
| 派发延后一拍（setTimeout 0）统一决定并发度；按「核数/并发度」给每个 Worker 分配 ORT 线程，单张吃满全核、批量均分 | `mattingPool.ts`、`matting.worker.ts`（覆写 `hardwareConcurrency`） |
| Worker 内先把输入预缩到 ≤1024 长边，再以 `image/x-rgba8` 零重采样喂给 @imgly（推理质量不变，解码/回传/内存大降） | `matting.worker.ts` |
| 合成拆成 `buildPersonLayer`（缩放到输出尺寸 + 像素调整，可缓存）+ `compositeLayer`（只画底色，2~5ms）；`composePhoto` 保持兼容 | `matting.ts` |
| 人物层按 `id\|匀肤\|像素参数指纹` 缓存（FIFO 120 条）：**换底色/纸张不再重做去晕边/阈值/美白** | `IdPhoto.tsx` |
| 合成循环每 8 张让出一帧；异常检测攒 8 条刷一次；抠图进度 5 次/秒节流 | `IdPhoto.tsx` |
| 批量 ≥10 张且用「精细」时显示橙色提示条（附实测耗时对比，点击一键切「快速」） | `IdPhoto.tsx`、`index.css`（`.idp-tip`） |
| 预览/结果 `<img>` 加 `loading="lazy" decoding="async"` | `IdPhoto.tsx` |
| 顺手修了一个合成几何 bug：contain（无取景）时旧代码被无条件 clamp 顶到左上角，现已恢复居中；clamp 仅对 cover 取景生效 | `matting.ts`（`composeGeometry`，含 11 项单测） |

## 四、优化后实测（同一测试集、同一口径）

| 指标 | 基线 | 优化后·精细(ISNet) | 优化后·快速(MODNet) |
|---|---|---|---|
| 抠图 50 张 | 428.1 s | **287.9 s**（1.49×） | **44.7 s（9.6×）** |
| 首次出图（导入→全部结果） | 484.6 s | 294.0 s | **50.7 s** |
| 首次合成+异常检测 | 56.5 s | 6.1 s | 5.9 s |
| 换红底（50 张重合成） | 41.4 s | **1.70 s（24×）** | 1.66 s |
| 再切回白底 | 41.5 s | 1.68 s | 1.70 s |
| 主线程长任务（抠图段） | 247 次 / 468 s | 51 次 / 7.8 s（60×） | 51 次 / 7.9 s |
| 单次 getImageData 最大像素 | 12.19 M | 0.12 M（100×） | 0.12 M |
| JS 堆峰值 | 407 MB | 27.8 MB | 132 MB |

成品质量：295×413 JPG，纯红底、人像完整、边缘无晕边（`result-sample.jpg`）。

## 五、剩余上限与建议

- 4 核机器上「精细」抠图 ~21 s/张·核 是模型物理下限，50 张 ≈ 5 分钟；**批量场景建议用「快速」（MODNet 512）**，
  50 张 45 s，界面全程可操作。界面已有橙色一键切换提示。
- 后续可再评估：WebGPU（`device:'gpu'`）推理、2 Worker×2 线程的配比、合成挪入 OffscreenCanvas Worker。
- 打包提醒：下次 `npm run pack` 前会先清空 `dist-pkg-current`（既定约定）。
