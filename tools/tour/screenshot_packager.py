#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""截图并打包功能模块（Screenshot Packager）

一句话：抓取「全屏 / 指定窗口 / 指定区域」的截图，按可配置规则命名存盘，
最后自动把所有截图压成一个 zip 归档。

特性
----
- 三种捕获模式：screen（全屏）、window（按标题找窗口）、region（手动框选坐标）。
- 文件命名可配置：支持 {prefix} {ts} {counter} {label} 占位符，计数器可设零宽。
- 输出目录可配置；归档名也可配置，默认打成一个 zip。
- 完备的错误处理：缺依赖、窗口找不到、区域格式错、目录为空、归档已存在等都有明确报错。
- 既能「边截边打」（capture / batch），也能「只打包已有目录」（pack）。

依赖
----
- Pillow（必需）：pip install pillow
- 仅 window 模式用到 Windows API（ctypes，无需 pywin32）。

用法（命令行）
------------
  # 抓全屏一张，命名后自动打包
  python screenshot_packager.py capture --label 主界面

  # 按窗口标题抓爱印，抓 3 张（不同标签）后打包
  python screenshot_packager.py batch --mode window --window-title 爱印 --labels 主界面 证件照 证卡

  # 手动框选区域（左,上,右,下）
  python screenshot_packager.py capture --mode region --region 100,100,900,600 --label 局部

  # 只把你已有的截图目录打包（不重新截图）
  python screenshot_packager.py pack --output-dir ./aiyin_tour_shots --archive-name 我的截图.zip

编程调用
--------
  from screenshot_packager import CaptureConfig, capture_one, package_dir
  cfg = CaptureConfig(output_dir=Path("./shots"), mode="window", window_title="爱印")
  path = capture_one(cfg, label="主界面")
  archive = package_dir(cfg)
"""

from __future__ import annotations

import argparse
import ctypes
import zipfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

try:
    from PIL import ImageGrab
except ImportError:  # pragma: no cover
    ImageGrab = None  # type: ignore[assignment]


# ----------------------------------------------------------------------------
# 异常定义
# ----------------------------------------------------------------------------

class ScreenshotPackagerError(Exception):
    """模块所有自定义异常的基类。"""


class DependencyError(ScreenshotPackagerError):
    """缺少必需依赖（如 Pillow）。"""


class ConfigError(ScreenshotPackagerError):
    """配置不合法（如 region 格式错、mode 不支持）。"""


class WindowNotFoundError(ScreenshotPackagerError):
    """window 模式下找不到匹配标题的窗口。"""


class NoScreenshotsError(ScreenshotPackagerError):
    """打包时目录下没有任何截图文件。"""


class ArchiveExistsError(ScreenshotPackagerError):
    """归档文件已存在且未开启覆盖。"""


# ----------------------------------------------------------------------------
# 配置
# ----------------------------------------------------------------------------

# 命名模板支持的占位符
#   {prefix}   前缀（来自 config.prefix）
#   {ts}       时间戳（来自 config.timestamp_format）
#   {counter}  自增序号，零宽由 config.counter_width 控制
#   {label}    用户传入的标签（非法字符会被清洗）
DEFAULT_NAME_TEMPLATE = "{prefix}{ts}_{counter}_{label}.png"
DEFAULT_ARCHIVE_TEMPLATE = "{prefix}screenshots_{ts}.zip"


@dataclass
class CaptureConfig:
    """截图与打包的全部可配置项。

    Attributes:
        output_dir: 截图保存目录。
        mode: 捕获模式，取值 screen / window / region。
        window_title: window 模式下的窗口标题子串。
        region: region 模式下的 (left, top, right, bottom) 物理像素。
        all_screens: screen 模式是否合并所有显示器。
        name_template: 文件名模板，见模块顶部占位符说明。
        prefix: 文件名前缀。
        timestamp_format: 时间戳 strftime 格式。
        counter_width: 计数器零填充宽度（3 → 001）。
        start_counter: 计数器起始值。
        archive_template: 归档文件名模板。
        archive_format: 归档格式（当前仅支持 zip）。
        file_glob: 打包时匹配的文件模式。
        overwrite_archive: 归档已存在时是否覆盖。
    """

    output_dir: Path = Path("./shots")
    mode: str = "screen"
    window_title: str = ""
    region: Optional[tuple[int, int, int, int]] = None
    all_screens: bool = False

    name_template: str = DEFAULT_NAME_TEMPLATE
    prefix: str = ""
    timestamp_format: str = "%Y%m%d_%H%M%S"
    counter_width: int = 3
    start_counter: int = 1

    archive_template: str = DEFAULT_ARCHIVE_TEMPLATE
    archive_format: str = "zip"
    file_glob: str = "*.png"
    overwrite_archive: bool = False

    def validate(self) -> None:
        """校验配置合法性，非法时抛出 ConfigError。

        Raises:
            ConfigError: mode 不支持、window 缺标题、region 格式错或越界。
        """
        if self.mode not in ("screen", "window", "region"):
            raise ConfigError(f"不支持的 mode：{self.mode!r}，应为 screen/window/region")
        if self.mode == "window" and not self.window_title:
            raise ConfigError("mode=window 时必须提供 window_title")
        if self.mode == "region":
            if not self.region:
                raise ConfigError("mode=region 时必须提供 region=(left,top,right,bottom)")
            left, top, right, bottom = self.region
            if not (right > left and bottom > top):
                raise ConfigError(f"region 越界：{self.region}（需 right>left 且 bottom>top）")
        if self.archive_format != "zip":
            raise ConfigError(f"暂仅支持 zip，收到 {self.archive_format!r}")


# ----------------------------------------------------------------------------
# 命名与路径
# ----------------------------------------------------------------------------

def _sanitize(label: str) -> str:
    """清洗标签中的非法文件名字符（Windows 禁用 \\ / : * ? " < > |）。"""
    return "".join(c for c in label if c not in r'\/:*?"<>|').strip()


def render_name(template: str, *, prefix: str, ts: str, counter: int,
                counter_width: int, label: str) -> str:
    """把命名模板渲染成最终文件名。

    Args:
        template: 含占位符的模板。
        prefix: 前缀。
        ts: 已格式化的时间戳字符串。
        counter: 当前序号。
        counter_width: 序号零填充宽度。
        label: 已清洗的标签。

    Returns:
        渲染后的文件名（不含目录）。
    """
    # 标签来自用户输入，文件名必须清洗非法字符，统一在此处理
    safe_label = _sanitize(label)
    return (
        template.replace("{prefix}", prefix)
        .replace("{ts}", ts)
        .replace("{timestamp}", ts)
        .replace("{counter}", str(counter).zfill(counter_width))
        .replace("{seq}", str(counter).zfill(counter_width))
        .replace("{label}", safe_label)
    )


def _archive_name(cfg: CaptureConfig, ts: str) -> str:
    """根据模板生成归档文件名。"""
    return (
        cfg.archive_template.replace("{prefix}", cfg.prefix)
        .replace("{ts}", ts)
        .replace("{timestamp}", ts)
    )


# ----------------------------------------------------------------------------
# Windows 窗口查找（ctypes，无 pywin32 依赖）
# ----------------------------------------------------------------------------

def _set_dpi_aware() -> None:
    """让进程 DPI 感知，使 GetWindowRect 返回物理像素、与 ImageGrab 同坐标系。"""
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


def find_window_rect(title_substring: str) -> Optional[tuple[int, int, int, int]]:
    """按标题子串查找首个可见窗口的矩形 (left, top, right, bottom)。

    Args:
        title_substring: 窗口标题包含的字符串（如 "爱印"）。

    Returns:
        窗口物理像素矩形；未找到返回 None。
    """
    _set_dpi_aware()
    user32 = ctypes.windll.user32
    found: dict[str, tuple[int, int, int, int]] = {}

    def _callback(hwnd: int, _lparam: int) -> bool:
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        if title_substring in buf.value:
            rect = ctypes.wintypes.RECT()
            if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                found["rect"] = (rect.left, rect.top, rect.right, rect.bottom)
        return True

    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.wintypes.BOOL, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)
    user32.EnumWindows(WNDENUMPROC(_callback), 0)
    return found.get("rect")


# ----------------------------------------------------------------------------
# 捕获与保存
# ----------------------------------------------------------------------------

def capture_image(cfg: CaptureConfig):
    """按配置抓取一帧图像对象（未存盘）。

    Returns:
        PIL.Image.Image 对象。

    Raises:
        DependencyError: 缺少 Pillow。
        ConfigError: 配置非法。
        WindowNotFoundError: window 模式找不到窗口。
    """
    if ImageGrab is None:
        raise DependencyError("缺少 Pillow，请先：pip install pillow")
    cfg.validate()

    if cfg.mode == "screen":
        return ImageGrab.grab(all_screens=cfg.all_screens)
    if cfg.mode == "window":
        rect = find_window_rect(cfg.window_title)
        if not rect:
            raise WindowNotFoundError(f"未找到标题含 {cfg.window_title!r} 的可见窗口")
        left, top, right, bottom = rect
        return ImageGrab.grab(bbox=(left, top, right, bottom))
    # region
    left, top, right, bottom = cfg.region  # type: ignore[misc]
    return ImageGrab.grab(bbox=(left, top, right, bottom))


def capture_one(cfg: CaptureConfig, label: str = "", counter: Optional[int] = None) -> Path:
    """抓取一帧并按命名规则保存到 output_dir。

    Args:
        cfg: 配置。
        label: 用户标签（用于文件名与归档归类）。
        counter: 序号；省略时使用 cfg.start_counter。

    Returns:
        保存的文件路径。

    Raises:
        ScreenshotPackagerError: 任何捕获/保存失败。
    """
    counter = cfg.start_counter if counter is None else counter
    ts = datetime.now().strftime(cfg.timestamp_format)
    name = render_name(
        cfg.name_template,
        prefix=cfg.prefix,
        ts=ts,
        counter=counter,
        counter_width=cfg.counter_width,
        label=label,
    )
    cfg.output_dir.mkdir(parents=True, exist_ok=True)
    img = capture_image(cfg)
    path = cfg.output_dir / name
    try:
        img.save(path)
    except OSError as exc:  # 权限/磁盘等
        raise ScreenshotPackagerError(f"保存截图失败：{path}（{exc}）") from exc
    return path


# ----------------------------------------------------------------------------
# 打包
# ----------------------------------------------------------------------------

def package_dir(cfg: CaptureConfig, archive_path: Optional[Path] = None) -> Path:
    """把 output_dir 下匹配 file_glob 的文件打包成归档。

    Args:
        cfg: 配置（提供 output_dir / file_glob / archive_template 等）。
        archive_path: 归档完整路径；省略时按 archive_template 生成于 output_dir 同级。

    Returns:
        生成的归档文件路径。

    Raises:
        NoScreenshotsError: 目录下没有任何匹配文件。
        ArchiveExistsError: 归档已存在且 overwrite_archive=False。
    """
    cfg.output_dir.mkdir(parents=True, exist_ok=True)
    files = sorted(cfg.output_dir.glob(cfg.file_glob))
    if not files:
        raise NoScreenshotsError(f"{cfg.output_dir} 下没有匹配 {cfg.file_glob} 的文件")

    if archive_path is None:
        ts = datetime.now().strftime(cfg.timestamp_format)
        # 默认归档放在截图目录内部，与图片同处一文件夹，更直观且不会污染父目录
        archive_path = cfg.output_dir / _archive_name(cfg, ts)
    if archive_path.exists() and not cfg.overwrite_archive:
        raise ArchiveExistsError(f"归档已存在：{archive_path}（用 --overwrite-archive 覆盖）")

    try:
        with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in files:
                zf.write(f, f.name)  # 仅以文件名入库，避免目录层级过深
    except OSError as exc:
        raise ScreenshotPackagerError(f"打包失败：{archive_path}（{exc}）") from exc
    return archive_path


# ----------------------------------------------------------------------------
# 命令行入口
# ----------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="截图并自动打包为 zip 归档",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    def _add_common(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--output-dir", default="./shots", help="截图保存目录")
        sp.add_argument("--mode", choices=["screen", "window", "region"], default="screen")
        sp.add_argument("--window-title", default="", help="window 模式的窗口标题子串")
        sp.add_argument("--region", default="", help="region 模式坐标：左,上,右,下")
        sp.add_argument("--all-screens", action="store_true", help="screen 模式合并所有显示器")
        sp.add_argument("--name-template", default=DEFAULT_NAME_TEMPLATE)
        sp.add_argument("--prefix", default="")
        sp.add_argument("--timestamp-format", default="%Y%m%d_%H%M%S")
        sp.add_argument("--counter-width", type=int, default=3)
        sp.add_argument("--archive-name", default="", help="归档文件名（覆盖模板）")
        sp.add_argument("--overwrite-archive", action="store_true")

    # capture：截一张后打包
    c1 = sub.add_parser("capture", help="截一张截图，随后打包")
    c1.add_argument("--label", default="", help="该张截图的标签")
    _add_common(c1)

    # batch：按标签列表截多张后打包
    c2 = sub.add_parser("batch", help="按标签列表截多张，随后打包")
    c2.add_argument("--labels", nargs="*", default=[], help="每个标签截一张")
    _add_common(c2)

    # pack：只打包已有目录
    c3 = sub.add_parser("pack", help="仅把已有目录的截图打包（不重新截图）")
    c3.add_argument("--output-dir", default="./shots", help="含截图的目录")
    c3.add_argument("--file-glob", default="*.png", help="匹配模式")
    c3.add_argument("--archive-name", default="", help="归档文件名")
    c3.add_argument("--prefix", default="")
    c3.add_argument("--overwrite-archive", action="store_true")

    return p


def _parse_region(text: str) -> Optional[tuple[int, int, int, int]]:
    if not text:
        return None
    try:
        parts = [int(x) for x in text.split(",")]
    except ValueError as exc:
        raise ConfigError(f"region 格式应为 左,上,右,下，收到 {text!r}") from exc
    if len(parts) != 4:
        raise ConfigError(f"region 需要 4 个整数，收到 {parts}")
    return tuple(parts)  # type: ignore[return-value]


def _make_config(args: argparse.Namespace) -> CaptureConfig:
    # pack 子命令没有 mode/window/region 等参数，统一用 getattr 兜底避免 AttributeError
    return CaptureConfig(
        output_dir=Path(args.output_dir),
        mode=getattr(args, "mode", "screen"),
        window_title=getattr(args, "window_title", ""),
        region=_parse_region(getattr(args, "region", "")),
        all_screens=getattr(args, "all_screens", False),
        name_template=getattr(args, "name_template", DEFAULT_NAME_TEMPLATE),
        prefix=getattr(args, "prefix", ""),
        timestamp_format=getattr(args, "timestamp_format", "%Y%m%d_%H%M%S"),
        counter_width=getattr(args, "counter_width", 3),
        archive_template=(
            (getattr(args, "archive_name", "") or DEFAULT_ARCHIVE_TEMPLATE)
            if getattr(args, "archive_name", "")
            else DEFAULT_ARCHIVE_TEMPLATE
        ),
        file_glob=getattr(args, "file_glob", "*.png"),
        overwrite_archive=getattr(args, "overwrite_archive", False),
    )


def main(argv: Optional[list[str]] = None) -> int:
    """命令行主入口。返回进程退出码（0 成功，1 失败）。"""
    args = _build_parser().parse_args(argv)
    try:
        if args.cmd in ("capture", "batch"):
            cfg = _make_config(args)
            cfg.validate()
            labels = [args.label] if args.cmd == "capture" else (args.labels or [""])
            saved: list[Path] = []
            for i, lab in enumerate(labels, start=cfg.start_counter):
                path = capture_one(cfg, label=lab, counter=i)
                saved.append(path)
                print(f"✓ 截图 {i}: {path}")
            archive = package_dir(cfg)
            print(f"✓ 已打包 {len(saved)} 张 → {archive}")
        else:  # pack
            cfg = _make_config(args)
            if args.archive_name:
                archive = cfg.output_dir / args.archive_name
            else:
                archive = None
            result = package_dir(cfg, archive_path=archive)
            print(f"✓ 已打包 → {result}")
    except ScreenshotPackagerError as exc:
        print(f"❌ {exc}", file=__import__("sys").stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
