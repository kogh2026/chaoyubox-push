#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""screenshot_packager 的单元测试（无需显示器即可运行）。

运行：
    python test_screenshot_packager.py        # 独立运行
    pytest test_screenshot_packager.py         # 或用 pytest
"""

import tempfile
from pathlib import Path
from zoneinfo import ZoneInfo

from screenshot_packager import (
    ArchiveExistsError,
    CaptureConfig,
    ConfigError,
    NoScreenshotsError,
    WindowNotFoundError,
    _archive_name,
    _parse_region,
    package_dir,
    render_name,
)


def test_render_name_default():
    name = render_name(
        "{prefix}{ts}_{counter}_{label}.png",
        prefix="", ts="20261103_101010", counter=1, counter_width=3, label="主界面",
    )
    assert name == "20261103_101010_001_主界面.png"


def test_render_name_sanitize_label():
    name = render_name(
        "{counter}_{label}.png",
        prefix="", ts="", counter=7, counter_width=3, label='非法/\\:*?标签',
    )
    # 非法字符被清洗，序号零填充
    assert name == "007_非法标签.png"


def test_render_name_width_and_prefix():
    name = render_name(
        "{prefix}{counter}.png",
        prefix="shot_", ts="", counter=42, counter_width=5, label="",
    )
    assert name == "shot_00042.png"


def test_validate_bad_mode():
    cfg = CaptureConfig(mode="full")
    try:
        cfg.validate()
        assert False, "应抛出 ConfigError"
    except ConfigError:
        pass


def test_validate_window_requires_title():
    cfg = CaptureConfig(mode="window", window_title="")
    try:
        cfg.validate()
        assert False
    except ConfigError:
        pass


def test_validate_region_out_of_bounds():
    cfg = CaptureConfig(mode="region", region=(100, 100, 50, 200))
    try:
        cfg.validate()
        assert False
    except ConfigError:
        pass


def test_validate_region_ok():
    cfg = CaptureConfig(mode="region", region=(0, 0, 800, 600))
    cfg.validate()  # 不应抛异常


def test_parse_region_valid():
    assert _parse_region("0,0,800,600") == (0, 0, 800, 600)


def test_parse_region_malformed():
    # 空串是「未提供」，应返回 None 而非报错
    assert _parse_region("") is None
    # 非空但格式错才报错
    for bad in ("1,2,3", "a,b,c,d", "1,2,3,4,5"):
        try:
            _parse_region(bad)
            assert False, f"应抛 ConfigError: {bad!r}"
        except ConfigError:
            pass


def test_package_dir_basic():
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        for i in range(3):
            (d / f"img_{i}.png").write_bytes(b"\x89PNG fake")
        cfg = CaptureConfig(output_dir=d)
        archive = package_dir(cfg)
        assert archive.exists()
        import zipfile
        with zipfile.ZipFile(archive) as zf:
            names = zf.namelist()
        assert set(names) == {"img_0.png", "img_1.png", "img_2.png"}


def test_package_dir_empty():
    with tempfile.TemporaryDirectory() as td:
        cfg = CaptureConfig(output_dir=Path(td))
        try:
            package_dir(cfg)
            assert False
        except NoScreenshotsError:
            pass


def test_package_dir_archive_exists():
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        (d / "a.png").write_bytes(b"x")
        cfg = CaptureConfig(output_dir=d, overwrite_archive=False)
        _ = package_dir(cfg)
        try:
            package_dir(cfg)  # 再次打包，未覆盖应报错
            assert False
        except ArchiveExistsError:
            pass
        # 开启覆盖则应成功
        cfg.overwrite_archive = True
        package_dir(cfg)


def test_archive_name_template():
    cfg = CaptureConfig(prefix="my_", archive_template="{prefix}screens_{ts}.zip")
    name = _archive_name(cfg, "20261103")
    assert name == "my_screens_20261103.zip"


def _run_all() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"✓ {t.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"✗ {t.__name__}: {exc}")
    print(f"\n{len(tests) - failed}/{len(tests)} 通过")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_run_all())
