#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""爱印工具箱 · 真机巡览脚本（复刻第一手素材采集器）

用途
----
在你**本机**（能联网、爱印能正常显示窗口）运行，截取爱印每个功能与界面的截图，
作为「复刻体验」的第一手素材。当前 WorkBuddy 沙箱环境无法让爱印画出窗口且联网被掐，
所以这份脚本是给你自己机器用的，不依赖沙箱。

三种用法
--------
1) manual（默认，最稳）：你手动点开每个功能，脚本在回车时截下爱印窗口。
2) calibrate：脚本依次提示你点击 10 个工具，记录坐标存盘（只需做一次）。
3) auto：读取校准坐标，自动点开 10 个工具并截图。

依赖
----
- Pillow   ：必需（截图），pip install pillow
- pyautogui：仅 calibrate / auto 模式需要（自动点击），pip install pyautogui

注意
----
- 本脚本只做「截图 + 记录坐标」，不修改爱印任何文件。
- 截图默认存到 ./aiyin_tour_shots/，文件名带序号和标签，方便对照。
"""

from __future__ import annotations

import ctypes
import json
import os
import subprocess
import sys
import time
from ctypes import wintypes
from datetime import datetime
from pathlib import Path
from typing import Optional

try:
    from PIL import ImageGrab
except ImportError:  # pragma: no cover
    sys.exit("❌ 缺少 Pillow，请先：pip install pillow")

# pyautogui 仅在 calibrate/auto 模式按需导入
try:
    import pyautogui
    _HAS_PYAUTOGUI = True
except ImportError:
    _HAS_PYAUTOGUI = False


# ----------------------------------------------------------------------------
# 配置
# ----------------------------------------------------------------------------

# 爱印安装路径（如不同请改这里，或设环境变量 AIYIN_EXE）
EXE_PATH = os.environ.get(
    "AIYIN_EXE",
    r"D:\Program Files (x86)\爱印\aiyin-toolbox-desktop\爱印工具箱.exe",
)
SHOTS_DIR = Path(os.environ.get("AIYIN_TOUR_DIR", "./aiyin_tour_shots"))
COORDS_FILE = Path("./aiyin_tour_coords.json")

# 10 个工具的展示顺序（与《功能清单》一致），用于 auto/calibrate 提示
TOOLS: list[tuple[str, str, str]] = [
    ("1", "证件照批量处理", "本地"),
    ("2", "AI 证件照", "AI/需登录"),
    ("3", "AI 照片修复", "AI/需登录"),
    ("4", "团拍助手", "网页/联机"),
    ("5", "证卡拼版助手", "网页"),
    ("6", "图片拼版", "网页"),
    ("7", "批量制卡", "网页"),
    ("8", "批量打印", "网页"),
    ("9", "Office 转 PDF", "本地"),
    ("10", "文件互传", "网页/局域网"),
]


# ----------------------------------------------------------------------------
# Windows 窗口查找（ctypes，无 pywin32 依赖）
# ----------------------------------------------------------------------------

user32 = ctypes.windll.user32
EnumWindows = user32.EnumWindows
SetProcessDPIAware = user32.SetProcessDPIAware

WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def _set_dpi_aware() -> None:
    """让进程 DPI 感知，使 GetWindowRect 返回物理像素、与 ImageGrab 同一坐标系。"""
    try:
        SetProcessDPIAware()
    except Exception:
        pass


def find_aiyin_window() -> Optional[tuple[int, int, int, int]]:
    """查找爱印主窗口矩形 (left, top, right, bottom)。

    Returns:
        窗口物理像素矩形；未找到返回 None。
    """
    found: dict[str, tuple[int, int, int, int]] = {}

    def _callback(hwnd: int, _lparam: int) -> bool:
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value
        if "爱印" in title:
            rect = wintypes.RECT()
            if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                found["rect"] = (rect.left, rect.top, rect.right, rect.bottom)
        return True

    EnumWindows(WNDENUMPROC(_callback), 0)
    return found.get("rect")


def ensure_running() -> bool:
    """确保爱印已在运行；未运行则尝试启动。

    Returns:
        True 表示爱印窗口可定位，False 表示启动失败。
    """
    rect = find_aiyin_window()
    if rect:
        return True
    if not Path(EXE_PATH).exists():
        print(f"⚠️ 未找到爱印 exe：{EXE_PATH}")
        return False
    print("→ 启动爱印中…")
    subprocess.Popen([EXE_PATH], shell=False)
    for _ in range(10):
        time.sleep(2)
        rect = find_aiyin_window()
        if rect:
            print("✓ 爱印已启动")
            return True
    print("⚠️ 爱印启动后仍未找到窗口（可能需你手动点开）")
    return False


# ----------------------------------------------------------------------------
# 截图与坐标
# ----------------------------------------------------------------------------

def capture(label: str) -> Optional[Path]:
    """截取爱印窗口并保存到 SHOTS_DIR。

    Args:
        label: 截图标签，会作为文件名一部分。

    Returns:
        保存的文件路径；失败返回 None。
    """
    rect = find_aiyin_window()
    if not rect:
        print("⚠️ 未找到爱印窗口，跳过截图（请先打开爱印）")
        return None
    SHOTS_DIR.mkdir(parents=True, exist_ok=True)
    left, top, right, bottom = rect
    img = ImageGrab.grab(bbox=(left, top, right, bottom))
    ts = datetime.now().strftime("%H%M%S")
    safe_label = "".join(c for c in label if c not in r'\/:*?"<>|')
    path = SHOTS_DIR / f"{ts}_{safe_label}.png"
    img.save(path)
    print(f"✓ 截图：{path}  ({right - left}x{bottom - top})")
    return path


def load_coords() -> dict[str, dict]:
    if not COORDS_FILE.exists():
        return {}
    return json.loads(COORDS_FILE.read_text(encoding="utf-8"))


def save_coords(coords: dict[str, dict]) -> None:
    COORDS_FILE.write_text(
        json.dumps(coords, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"✓ 坐标已保存：{COORDS_FILE}")


# ----------------------------------------------------------------------------
# 模式
# ----------------------------------------------------------------------------

def mode_manual() -> None:
    """手动模式：你点开功能，回车即截。"""
    if not ensure_running():
        return
    print("\n=== 手动巡览模式 ===")
    print("操作步骤：在爱印里点开你想记录的功能/界面 → 回到这里输入标签 → 回车截图")
    print("标签建议：主界面 / 工具1-证件照批量 / 工具5-证卡拼版-首屏 / …")
    print("直接回车（空标签）退出。\n")
    while True:
        label = input("截图标签（回车退出）: ").strip()
        if not label:
            break
        capture(label)
        time.sleep(0.3)


def mode_calibrate() -> None:
    """校准模式：依次记录 10 个工具在主界面的点击坐标。"""
    if not _HAS_PYAUTOGUI:
        sys.exit("❌ calibrate 需要 pyautogui：pip install pyautogui")
    if not ensure_running():
        return
    print("\n=== 校准模式 ===")
    print("接下来窗口会列出 10 个工具，请按序号在主界面上**点击对应工具图标**，" "脚本记录鼠标位置。")
    coords: dict[str, dict] = {}
    for tid, name, kind in TOOLS:
        input(f"[{tid}] 请把鼠标移到「{name}」（{kind}）图标上，按回车后 3 秒内点击它…")
        time.sleep(3)
        x, y = pyautogui.position()
        coords[tid] = {"name": name, "kind": kind, "x": x, "y": y}
        print(f"  ✓ 记录 ({x}, {y})")
    save_coords(coords)
    print("\n校准完成。之后可用：python aiyin_tour.py --mode auto")


def mode_auto() -> None:
    """自动模式：读取校准坐标，依次点开 10 个工具并截图。"""
    if not _HAS_PYAUTOGUI:
        sys.exit("❌ auto 需要 pyautogui：pip install pyautogui")
    coords = load_coords()
    if not coords:
        sys.exit(f"❌ 没有校准数据 {COORDS_FILE}，请先跑：python aiyin_tour.py --mode calibrate")
    if not ensure_running():
        return
    print("\n=== 自动巡览模式 ===")
    for tid, name, kind in TOOLS:
        c = coords.get(tid)
        if not c:
            print(f"[{tid}] {name}：缺坐标，跳过")
            continue
        print(f"→ 点击 {name}（{kind}）…")
        pyautogui.click(c["x"], c["y"])
        time.sleep(3.5)  # 等网页/本地功能加载
        capture(f"工具{tid}-{name}")
    print("\n自动巡览完成，截图在", SHOTS_DIR)


def mode_list() -> None:
    """打印 10 个工具清单，不截图。"""
    print("爱印 10 大工具（巡览目标）：\n")
    for tid, name, kind in TOOLS:
        print(f"  [{tid}] {name}  ——  {kind}")
    print("\n详细观察要点见《爱印-真机巡览清单.md》。")


# ----------------------------------------------------------------------------
# 入口
# ----------------------------------------------------------------------------

def main() -> None:
    _set_dpi_aware()
    args = sys.argv[1:]
    if "--list" in args:
        mode_list()
        return
    if "--mode" in args:
        i = args.index("--mode") + 1
        mode = args[i] if i < len(args) else "manual"
    else:
        mode = "manual"
    if mode == "calibrate":
        mode_calibrate()
    elif mode == "auto":
        mode_auto()
    else:
        mode_manual()


if __name__ == "__main__":
    main()
