# 超誉工作台（桌面工具箱原型）

按 [replica](https://github.com/Jakeschincariol/replica-skill) 流程对
[aiyinbox.com](https://www.aiyinbox.com/)（原版桌面工具箱）做的克隆起点。

> **clean-room 声明**：本工程仅复刻原产品的**功能与流程**，不复制其源码、Logo、文案、模型权重或素材。
> 原产品是 Electron 应用，本地 ML（识别/矫正/换底/美颜）在客户端 WASM 跑；本克隆用开源等价方案重做，不搬运其权重。

## 当前进度
- ✅ 工程骨架：Vite + React + TS，已包成真正可运行的 **Electron 桌面应用**。
- ✅ **批量打印报价引擎**（核心、无 ML）：拖入 PDF/图片 → 数页数 + 逐页判定黑白/点彩/彩色 → 价格表管理 → 实时报价。
- ✅ **证卡拼版助手**（纯前端、无 ML）：导入证件照 → 选纸张与规格（1寸/2寸/护照…）→ 网格排版（带裁剪参考线）→ 导出 PDF / **真打印**（Electron 调系统打印机，支持灰度、份数、双面）。
- ⬜ 其余工具、Office→PDF、本地 ML（证件照换底/透视矫正）见后续阶段。
- ⛔ AI 证件照 / AI 照片修复（依赖微信登录 + 云端推理）默认 skip。

## 运行

### 浏览器验证（无需 Electron）
```bash
npm install
npm run dev        # 打开 http://localhost:5173
```

### 作为桌面应用运行（Electron + 真打印）
```bash
npm install
npm run build                 # 先产出 dist/
npm run electron             # 用 Electron 打开桌面窗口
# 开发态（热更新）：先 npm run dev，另开终端跑：
npm run electron:dev         # 加载 http://localhost:5173
```
> 真打印说明：在 Electron 里点「打印（真实打印机）」会调用 `webContents.print`，
> 走系统打印对话框；可传 `grayscale`(灰度)、`copies`(份数)、`duplex`(双面) 给驱动。
> 浏览器环境下同一按钮退化为 `window.print()`，桌面浏览器同样打到真实打印机。

### 打包成安装包（Windows NSIS）
```bash
npm run pack                 # 产物在 release/
```
> 安装 Electron / electron-builder 二进制走 npmmirror 镜像（GitHub releases 本机被墙），
> 环境变量：`ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR`。

### 临时文件放哪
所有脚本的中间件默认落仓库内 `.tmp/`（C 盘空间紧张，一轮门禁能产出数 GB），
统一入口是 `tools/tmproot.py` / `tools/tmproot.cjs`，可用 `CHAOYU_TMP_ROOT` 覆盖。
细节与仍留在 C 盘的大件见 [docs/dev-temp-paths.md](docs/dev-temp-paths.md)。

## 路线图
- **Phase 1（已完成）**：Web 原型 → Electron 壳 + 真打印（灰度/份数/双面）。
- **Phase 2（进行中）**：证卡拼版已上线；下一步证件照换底（开源 matting）、Office→PDF（LibreOffice/原生辅助）、replica-design 设计 token。
- **Phase 3（可选）**：团拍助手、图片拼版、批量制卡、文件互传、自动更新。

## 关键文件
- `electron/main.cjs` / `electron/preload.cjs` — Electron 主进程与打印桥
- `src/lib/cardLayout.ts` — 证卡拼版布局引擎（布局计算 / cover 裁切 / 预览）
- `src/lib/sheetPdf.ts` — 排版导出 PDF（jsPDF，mm 单位）
- `src/lib/pdfAnalyze.ts` — 页数统计 + 逐页颜色判定
- `src/lib/quote.ts` — 报价引擎
- `src/tools/CardLayout.tsx` / `BatchPrint.tsx` — 工具界面
- `../replica/recon.md` / `architecture.md` / `schema.sql` — replica 流程产出
