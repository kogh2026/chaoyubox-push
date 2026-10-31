# -*- coding: utf-8 -*-
"""统一临时文件根目录 —— 默认落在**仓库内** `.tmp/`（仓库在 D 盘）。

为什么不用系统默认
------------------
Windows 的 `%TEMP%` 在 C 盘。本项目跑一轮基准或打包版门禁就会产出数 GB 中间件：
102 张卡的裸 RGBA dump、Electron 独立 userData（一个空 profile 就有上百 MB）、
浏览器解压目录。C 盘余量本来就紧张，实测跑一轮直接写满到 0 字节——连 shell
回显都 ENOSPC，工具链整体失灵。所以所有脚本的临时目录统一收口到仓库内 `.tmp/`。

覆盖方式
--------
    set CHAOYU_TMP_ROOT=E:\\scratch     # 想放到别的盘 / 更快的 SSD
    python tools/xxx.py

用法
----
    from tmproot import mkdtemp, scratch, tmp_root

    work = mkdtemp("chaoyu-export-")   # 唯一目录，互不干扰
    d = scratch("lib_diff")            # 固定目录，每次调用先清空，适合自测

`.tmp/` 已在 .gitignore 里，整体删除不影响仓库。
"""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

# tools/tmproot.py -> 仓库根
ROOT = Path(__file__).resolve().parent.parent
ENV_VAR = "CHAOYU_TMP_ROOT"


def tmp_root() -> Path:
    """临时文件根目录（保证存在）。"""
    env = os.environ.get(ENV_VAR)
    base = Path(env).expanduser() if env else ROOT / ".tmp"
    base.mkdir(parents=True, exist_ok=True)
    return base


def mkdtemp(prefix: str) -> Path:
    """在临时根下建一个唯一目录。"""
    return Path(tempfile.mkdtemp(prefix=prefix, dir=str(tmp_root())))


def scratch(name: str) -> Path:
    """在临时根下取一个**固定**目录，先清空再返回（自测用，避免目录越攒越多）。"""
    d = tmp_root() / name
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True, exist_ok=True)
    return d


def adopt_tmp_env(subdir: str = "tmp") -> Path:
    """把当前进程的临时目录改到 D 盘，并同步 `tempfile.tempdir`。

    给 Playwright 这类「每建一个 context 就在 %TEMP% 下拉一个浏览器 profile」的
    工具用：正常关闭会自己清，但被 Ctrl-C / 超时中断就会留下 20~50 MB 残骸。
    `tempfile` 会在首次调用时缓存 tempdir，所以两个地方都要改。
    """
    base = tmp_root() / subdir
    base.mkdir(parents=True, exist_ok=True)
    for k in ("TMP", "TEMP", "TMPDIR"):
        os.environ[k] = str(base)
    tempfile.tempdir = str(base)
    return base


if __name__ == "__main__":
    print(f"ROOT      = {ROOT}")
    print(f"TMP_ROOT  = {tmp_root()}")
    print(f"override  = {os.environ.get(ENV_VAR) or '(未设置)'}")
