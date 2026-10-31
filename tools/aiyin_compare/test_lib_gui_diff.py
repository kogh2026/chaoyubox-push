# -*- coding: utf-8 -*-
"""lib_gui_diff 自测：锁定「截图保真度」判定口径，防止改容差把 fail 放成 ok。

跑法：python tools/aiyin_compare/test_lib_gui_diff.py
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))  # tools/ —— 取 tmproot

import lib_gui_diff  # noqa: E402
from tmproot import scratch  # noqa: E402


def _card(seed: int = 0, w: int = 240, h: int = 150) -> np.ndarray:
    """合成一张"证件"：渐变底 + 条纹 + 文字块，保证有足够高频细节让 SSIM 有意义。"""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w]
    base = np.zeros((h, w, 3), dtype=np.float32)
    base[..., 0] = 200 + 30 * np.sin(x / 27.0 + seed)
    base[..., 1] = 190 + 25 * np.cos(y / 19.0)
    base[..., 2] = 175 + 20 * np.sin((x + y) / 33.0)
    for i in range(3):
        y0 = 12 + i * 40
        base[y0:y0 + 10, 12:w - 80, :] = rng.integers(20, 70, size=(10, w - 92, 3))
    base[..., 0] = np.clip(base[..., 0], 0, 255)
    return base.astype(np.uint8)


def _save(arr: np.ndarray, p: Path) -> Path:
    Image.fromarray(arr, "RGB").save(p)
    return p


def _jpeg(arr: np.ndarray, q: int = 92) -> np.ndarray:
    buf = io.BytesIO()
    Image.fromarray(arr, "RGB").save(buf, "JPEG", quality=q, subsampling=2)
    buf.seek(0)
    return np.asarray(Image.open(buf).convert("RGB"), dtype=np.uint8)


def _shift(arr: np.ndarray, dx: int = 9) -> np.ndarray:
    out = np.full_like(arr, 255)
    out[:, dx:] = arr[:, :-dx]
    return out


def main() -> int:
    tmp = scratch("gui_diff")
    card = _card()
    canvas = _save(card, tmp / "canvas.png")
    worker = _save(card, tmp / "worker.png")
    ok = True

    def check(name: str, verdict_want: str, **kw):
        nonlocal ok
        g = lib_gui_diff.compare_gui(**kw)
        good = g.verdict == verdict_want
        ok = ok and good
        print(f"  {'PASS' if good else 'FAIL'}  {name:<26} -> verdict={g.verdict} "
              f"(want {verdict_want}) floor={g.floor_mae:.4f} ratio={g.noise_ratio:.2f} "
              f"structSSIM={g.struct_ssim:.5f}")
        return g

    # 1) 截图 == 画布（DPR=1、1:1 显示）→ gui_exact
    shot_ident = _save(card, tmp / "shot_ident.png")
    check("t_identical", "gui_exact",
          shot=shot_ident, canvas_native=canvas, worker=worker)

    # 2) 截图只是画布被 JPEG 压了一次 → 噪声地板高、ratio≈1 → gui_ok
    shot_jpeg = _save(_jpeg(card, 92), tmp / "shot_jpeg.png")
    g2 = check("t_jpeg_floor", "gui_ok",
               shot=shot_jpeg, canvas_native=canvas, worker=worker)

    # 3) 截图内容整体位移 9px（画布与实际渲染不一致）→ 必须 fail
    shot_shift = _save(_shift(card, 9), tmp / "shot_shift.png")
    g3 = check("t_content_shift", "gui_fail",
               shot=shot_shift, canvas_native=canvas, worker=worker)

    # 4) 画布回读被"篡改"（模拟 canvas 2D 改了像素）→ 不能判 exact
    tampered = card.copy()
    tampered[40:80, 60:140] = 255 - tampered[40:80, 60:140]
    canvas_bad = _save(tampered, tmp / "canvas_bad.png")
    g4 = lib_gui_diff.compare_gui(shot=shot_ident, canvas_native=canvas_bad, worker=worker)
    good = g4.verdict != "gui_exact" and g4.canvas_vs_worker_mae > 0.5
    ok = ok and good
    print(f"  {'PASS' if good else 'FAIL'}  t_canvas_tampered          -> verdict={g4.verdict} "
          f"canvas_vs_worker_mae={g4.canvas_vs_worker_mae:.3f}")

    # 5) 缺 worker 基准时仍能判（退化模式）
    g5 = lib_gui_diff.compare_gui(shot=shot_ident, canvas_native=canvas, worker=None)
    good = g5.verdict == "gui_exact"
    ok = ok and good
    print(f"  {'PASS' if good else 'FAIL'}  t_no_worker_baseline       -> verdict={g5.verdict}")

    # 6) 四栏对照条能出图
    strip = lib_gui_diff.make_gui_strip(shot_shift, canvas, tmp / "strip.png", worker=worker)
    good = strip.exists() and Image.open(strip).height > 0
    ok = ok and good
    print(f"  {'PASS' if good else 'FAIL'}  t_make_strip               -> {strip.name} "
          f"{Image.open(strip).size if good else '-'}")

    print(f"\n{'6/6 passed' if ok else 'FAILED'}  (tmp={tmp})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
