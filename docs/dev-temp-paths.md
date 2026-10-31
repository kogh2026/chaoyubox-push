# 开发/测试临时文件放在哪（D 盘）

## 为什么改

Windows 的 `%TEMP%` 在 C 盘（`C:\Users\<user>\AppData\Local\Temp`）。本项目一轮证件照
基准或打包版门禁会产出数 GB 中间件：

| 中间件 | 单轮体量 |
|---|---|
| 官方 worker 裸 RGBA dump（102 张卡） | ~1 GB |
| 打包版门禁的独立 Electron userData（空 profile） | 150~300 MB |
| Playwright chromium 解压 | ~200 MB |
| Electron / electron-builder 下载缓存 | 250 MB + 28 MB |

C 盘余量本来就紧张，实测一轮直接写满到 0 字节——连 shell 回显都 `ENOSPC`，
`git`、`node`、`python` 全部报错，工具链整体失灵。所以把**项目自己产生的**临时文件
统一收口到仓库内 `.tmp/`（仓库在 D 盘）。

## 规则

默认根目录 = `<仓库>/.tmp/`，可用环境变量覆盖：

```bash
set CHAOYU_TMP_ROOT=E:\scratch      # cmd
$env:CHAOYU_TMP_ROOT='E:\scratch'   # powershell
```

`.tmp/` 已在 `.gitignore` 里，整目录删掉不影响仓库。

两个解析器是唯一入口，新脚本不要再直接调 `tempfile.mkdtemp()` / `os.tmpdir()`：

| 语言 | 文件 | 接口 |
|---|---|---|
| Python | `tools/tmproot.py` | `tmp_root()` / `mkdtemp(prefix)` / `scratch(name)` |
| Node | `tools/tmproot.cjs` | `tmpRoot()` / `mkdtemp(prefix)` / `scratch(name)` / `tempFile(name)` |

- `mkdtemp(prefix)` → 唯一目录，适合并行/一次性产物；
- `scratch(name)` → **固定**目录，每次调用先清空，适合自测（不会越攒越多）。

```python
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))  # tools/
from tmproot import mkdtemp
work = mkdtemp("my-run-")
```

```js
const { tempFile, mkdtemp } = require('./tmproot.cjs');
const out = tempFile('probe.pdf');
```

## 已收口的调用点

`tools/packaged_export_smoke.py`、`tools/packaged_options_persist.py`、
`tools/acrobat-outline.py`、`tools/printpdf.{verify,diag}.cjs`、
`electron/atomicWrite.check.cjs`、`electron/officeCom.check.cjs`、
`tools/aiyin_compare/test_lib_diff.py`、`test_lib_gui_diff.py`、`test_gate_negative.py`。

另外：

- **vitest** 早在 `vitest.config.ts` 里把 `TEMP/TMP/TMPDIR` 指到 `.tmp/vitest`（WorkBuddy 的
  fs shim 会拦 `%TEMP%` 写入，顺带也避免了 C 盘占用）。
- **Playwright** 浏览器目录由 `adapter_official_gui.py:ensure_browser_dir()` 判定：系统默认
  位置没有可用 `chrome-win*/chrome.exe` 时，自动把 `PLAYWRIGHT_BROWSERS_PATH` 指到
  `.tmp/ms-playwright`。只判"目录非空"会误判——下载中断会留下半成品目录。

## 刻意没改的地方

`electron/officeCom.cjs`（生产模块，随包发布）。asar 里只有 `dist/` 与 `electron/`，
拿不到 `tools/tmproot.cjs`，所以内联了一份解析器：`CHAOYU_TMP_ROOT` → 仓库 `.tmp`（开发态）
→ `os.tmpdir()`（打包态兜底，用户机器未必有 D 盘）。它只写一个几百字节、用后即删的
`.ps1`，不构成空间问题。

## 还留在 C 盘的大件（需要手动搬，脚本没动）

| 路径 | 体量 | 迁移方式 |
|---|---|---|
| `%LOCALAPPDATA%\electron\Cache` | 255 MB | `set ELECTRON_CACHE=D:\ecache` |
| `%LOCALAPPDATA%\electron-builder\Cache` | 28 MB | `set ELECTRON_BUILDER_CACHE=D:\ebcache` |
| `%LOCALAPPDATA%\ms-playwright`（半成品残骸） | 22 MB | 可直接删，需重装时用上面的 `.tmp/ms-playwright` |

前两项设成用户级环境变量即可，`npm run pack` 会自动沿用；不设则每次打包仍读 C 盘缓存
（命中时不下载，不会再涨，但也不会变小）。
