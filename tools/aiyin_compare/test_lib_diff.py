# -*- coding: utf-8 -*-
"""lib_diff 自测：用合成图锁定三类差异的判定口径，不需要模型/不需要跑 worker。

跑法： python tools/aiyin_compare/test_lib_diff.py   （无 pytest 依赖，返回码 0=全过）
"""
from __future__ import annotations

import io
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))  # tools/ —— 取 tmproot

import lib_diff  # noqa: E402
from tmproot import scratch  # noqa: E402

TOL = {
    "exact": {"max_diff": 0, "fill_frac": 0.0},
    "strict": {"max_diff": 12, "noise_ratio": 0.90, "struct_ssim": 0.9990, "fill_frac": 0.0005, "require_native": True},
    "pass": {"max_diff": 40, "noise_ratio": 1.80, "struct_ssim": 0.9950, "fill_frac": 0.02},
    "warn": {"max_diff": 72, "noise_ratio": 3.50, "struct_ssim": 0.9800, "fill_frac": 0.20},
}


def _card(w=420, h=265, seed=0):
    """造一张近似卡面的图：浅色底 + 深色文字块 + 渐变，避免纯色让 SSIM 失去分辨力。"""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w]
    base = 235 - 20 * (yy / h) - 10 * (xx / w)
    img = np.stack([base, base * 0.98, base * 0.95], axis=2).astype(np.uint8)
    for i in range(6):  # 模拟文字行
        y0 = 30 + i * 34
        img[y0:y0 + 16, 30:300] = 40
    img[20:110, 320:400] = np.array([210, 170, 160], dtype=np.uint8)  # 模拟头像
    img = np.clip(img + rng.integers(-2, 3, img.shape), 0, 255).astype(np.uint8)
    return img


def _save(arr, path: Path):
    Image.fromarray(arr).save(path)


# 每次运行清空一次，各用例在里面各拿一个唯一子目录（不落 C 盘 %TEMP%）
_RUN = scratch("lib_diff")


def _tmpdir():
    return Path(tempfile.mkdtemp(dir=str(_RUN)))


def t_identical():
    d = _tmpdir()
    a = _card()
    _save(a, d / "a.png")
    _save(a, d / "b.png")
    r = lib_diff.compare(d / "a.png", d / "b.png", TOL)
    assert r.verdict == "exact", r.verdict
    assert r.max_diff == 0 and r.noise_ratio == 0.0
    return "identical -> exact"


def t_jpeg_floor():
    """参考侧被 JPEG q92 压过 → 差异应完全被噪声地板解释（ratio≈1，判 pass）。"""
    d = _tmpdir()
    a = _card(seed=1)
    buf = io.BytesIO()
    Image.fromarray(a).save(buf, "JPEG", quality=92, subsampling=0)
    buf.seek(0)
    b = np.asarray(Image.open(buf).convert("RGB"), dtype=np.uint8)
    _save(b, d / "ref.png")
    _save(a, d / "off.png")
    r = lib_diff.compare(d / "ref.png", d / "off.png", TOL)
    assert 0.6 <= r.noise_ratio <= 1.6, f"ratio={r.noise_ratio} 应≈1"
    assert r.verdict in ("strict", "pass"), r.verdict
    return f"jpeg q92 floor -> ratio={r.noise_ratio:.2f} verdict={r.verdict}"


def t_fill_white_vs_black():
    """左侧 8 列：自研填白 vs 爱印填黑 → 应被识别为 fill 差异并从主裁决剔除。"""
    d = _tmpdir()
    a = _card(seed=2)
    b = a.copy()
    b[:, :8] = 0          # 官方：越界填黑
    a[:, :8] = 255        # 自研：越界填白
    _save(a, d / "ref.png")
    _save(b, d / "off.png")
    r = lib_diff.compare(d / "ref.png", d / "off.png", TOL)
    assert r.fill_frac > 0.01, f"fill_frac={r.fill_frac}"
    assert r.border_flag, "应标记边框填充口径差异"
    assert r.verdict in ("strict", "pass", "warn"), f"填充差异不该判 fail，实得 {r.verdict}"
    assert r.interior_mae < 2.0, f"内部区域应几乎无差异，实得 {r.interior_mae}"
    return f"white-vs-black fill -> fill={r.fill_frac*100:.1f}% interior_mae={r.interior_mae:.2f} verdict={r.verdict}"


def t_content_shift():
    """卡面内容整体位移 12px（真实不一致）→ 必须 warn/fail。"""
    d = _tmpdir()
    a = _card(seed=3)
    b = np.roll(a, 12, axis=1)
    _save(a, d / "ref.png")
    _save(b, d / "off.png")
    r = lib_diff.compare(d / "ref.png", d / "off.png", TOL)
    assert r.verdict in ("warn", "fail"), f"内容错位应判 warn/fail，实得 {r.verdict}"
    assert r.interior_mae > 5, r.interior_mae
    return f"content shift 12px -> interior_mae={r.interior_mae:.2f} verdict={r.verdict}"


def t_resize_downgrade():
    """官方原生 > 参考 1100 长边（app 降采样）→ resized=True 且不得判 exact。"""
    d = _tmpdir()
    a = _card(seed=4)
    big = np.asarray(Image.fromarray(a).resize((a.shape[1] * 2, a.shape[0] * 2), Image.BICUBIC))
    _save(a, d / "ref.png")
    _save(big, d / "off.png")
    r = lib_diff.compare(d / "ref.png", d / "off.png", TOL)
    assert r.resized is True
    assert r.verdict != "exact"
    assert r.struct_ssim > 0.98, r.struct_ssim
    return f"resized -> structSSIM={r.struct_ssim:.5f} verdict={r.verdict}"


def main():
    tests = [t_identical, t_jpeg_floor, t_fill_white_vs_black, t_content_shift, t_resize_downgrade]
    failed = 0
    for t in tests:
        try:
            print(f"  PASS  {t.__name__:24s} {t()}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL  {t.__name__:24s} {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
