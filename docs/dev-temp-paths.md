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
- **浏览器 profile** 由同文件的 `adopt_tmp_env()` 收口：Playwright 每建一个 context 就在
  `%TEMP%` 下拉一个 `playwright_chromiumdev_profile-*`（浏览器异常退出不会清），
  所以进程启动前把 `TMP/TEMP/TMPDIR` 与 `tempfile.tempdir` 一起指到 `.tmp/tmp`。

## 刻意没改的地方

`electron/officeCom.cjs`（生产模块，随包发布）。asar 里只有 `dist/` 与 `electron/`，
拿不到 `tools/tmproot.cjs`，所以内联了一份解析器：`CHAOYU_TMP_ROOT` → 仓库 `.tmp`（开发态）
→ `os.tmpdir()`（打包态兜底，用户机器未必有 D 盘）。它只写一个几百字节、用后即删的
`.ps1`，不构成空间问题。

## 本机已落地的磁盘迁移（2026-10-31）

C 盘一度被写到 0 字节（项目工具链整体 ENOSPC）。脚本层收口之后，又在**本机**做了一次
缓存搬迁，全部改成**用户级环境变量**指向 D 盘，程序按原语义读取、不需要软链接：

| 原路径 | 新路径 | 体量 | 环境变量 |
|---|---|---|---|
| `%LOCALAPPDATA%\electron\Cache` | `D:\caches\electron` | 255 MB | `ELECTRON_CACHE` |
| `%LOCALAPPDATA%\electron-builder\Cache` | `D:\caches\electron-builder` | 26 MB | `ELECTRON_BUILDER_CACHE` |
| `%LOCALAPPDATA%\ms-playwright` | `D:\caches\ms-playwright` | 22 MB | `PLAYWRIGHT_BROWSERS_PATH` |
| 系统 `TEMP` 根 | `D:\tmp` | 1.9 GB（清理后 0.4 GB） | `TMP` / `TEMP` / `TMPDIR` |

**生效时机与范围**：写在 `HKCU:\Environment`，**新开**的终端/进程继承；已运行的进程
（含 IDE、本会话）仍用旧值，重启后统一。系统级 `HKLM` 的 `TEMP`（`C:\Windows\TEMP`）
**没动**——服务与提权进程仍走那里，属预期。

迁移后 `D:\caches\ms-playwright` 里仍是原先那份**下载中断的半成品**（无 `chrome-win*/chrome.exe`），
所以 `adapter_official_gui.py` 仍按设计回退系统 Edge/Chrome；要真正用自带 chromium，执行
`python -m playwright install chromium`（现在会直接下到 D 盘）。

> 关于「删了但空间没释放」：本机的 safe-delete 钩子（genie-trash）会把删除动作变成
> **移入同盘回收站**，同盘移动不产生可用空间，且是**异步**清空的。实测删除 782 MB 后
> 立刻 `DriveInfo.AvailableFreeSpace` 几乎不变，一两分钟后回收站自行清空才真正落袋。
> 判断空间是否释放，别只看命令返回码，要看回收站体积与延迟后的可用空间。
