# -*- coding: utf-8 -*-
"""移植版一致性门禁：`official_model`（Python 移植） vs `official_worker`（爱印真 JS）逐位对照。

为什么需要它：`official_model` 曾被用作"官方输出"的替身，但它只是**移植**。移植一旦与
官方 JS 出现口径偏差（典型：`J()` 的归一化采样写成 (c+0.5)/W 而非官方的 c/o），
用它当基准就会把偏差记到"官方"账上，污染整个 harness 的结论。

本脚本用真 JS 的输出当基准，逐个 card 比移植版，并同时跑一遍 `offset=0.5` 的历史实现，
把修复收益量化出来（before/after 对照）。

用法：
  python tools/aiyin_compare/verify_parity.py --limit 6
  python tools/aiyin_compare/verify_parity.py --limit 20 \\
      --dirs "C:/Users/Coldhack/Desktop/下载结果/身份证人像面" --out .tmp/parity_check

判定（退出码）：
  0 = 所有配对页 mae < 1.0 且 max_diff <= 2（移植与官方等价，可由浮点后端差异解释）
  1 = 存在超限页（移植与官方不等价，**不得**用 official_model 当基准）
  2 = 运行错误（Node/模型缺失等）
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

MAE_LIMIT = 1.0
MAX_LIMIT = 2


def _to_rgb(a: np.ndarray) -> np.ndarray:
    return a[:, :, :3] if a.ndim == 3 and a.shape[2] >= 3 else a


def compare_pages(off_png: Path, model_pages: list[dict]) -> list[dict]:
    """把官方 worker 落盘的每页 PNG 与移植版对应页对比。"""
    rows = []
    for j, pg in enumerate(model_pages):
        if j == 0:
            src = off_png
        else:
            src = off_png.with_name(off_png.name.replace("__p0.png", f"__p{j}.png"))
        if not src.exists():
            rows.append({"page": j, "ok": False, "note": f"官方侧缺页 {src.name}"})
            continue
        a = np.asarray(Image.open(src).convert("RGB"), dtype=np.int16)
        b = _to_rgb(pg["rgb"]).astype(np.int16)
        if a.shape != b.shape:
            rows.append({"page": j, "ok": False,
                         "note": f"尺寸不一致 官方{a.shape[1]}x{a.shape[0]} vs 移植{b.shape[1]}x{b.shape[0]}"})
            continue
        d = np.abs(a - b)
        rows.append({
            "page": j,
            "mae": float(d.mean()),
            "max": int(d.max()),
            "identical_px_pct": float((d.max(axis=2) == 0).mean() * 100),
            "shape": (a.shape[1], a.shape[0]),
            "ok": None,
        })
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=6, help="每个目录取前 N 张")
    ap.add_argument("--dirs", nargs="*", default=[r"C:/Users/Coldhack/Desktop/下载结果/身份证人像面"])
    ap.add_argument("--out", default=".tmp/parity_check")
    ap.add_argument("--with-legacy", action="store_true", default=True,
                    help="同时跑 offset=0.5 的历史实现做 before/after 对照")
    args = ap.parse_args()

    out_dir = (ROOT / args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    import adapter_official_worker as aow
    import adapter_official_model as aom

    model_path = ROOT / "resources" / "card-model" / "card-correction-fp32.onnx"
    if not model_path.exists():
        print(f"[FAIL] 模型缺失 {model_path}")
        return 2

    jobs = []
    for d in args.dirs:
        dp = Path(d)
        imgs = sorted(p for p in dp.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png"})
        for p in imgs[:args.limit]:
            jobs.append((dp.name, p))
    if not jobs:
        print("[FAIL] 没有可用图片")
        return 2
    print(f"样本：{len(jobs)} 张（{', '.join(sorted({t for t, _ in jobs}))}）")

    # ---- 基准：爱印真 worker（Node 托管）----
    worker = aow.OfficialWorkerNode(
        r"D:/Downloads/2026-10-23-08-38-11/aiyin_decrypted_assets/vendor/id2pdf-card-correction-worker.js",
        str(model_path),
    )
    entries = [(f"{tag}__{p.name}", p) for tag, p in jobs]
    t0 = time.time()
    ref = worker.run_batch(entries, out_dir / "official", log=lambda m: None)
    print(f"官方 worker：{sum(len(v) for v in ref.values())} 页 / {time.time() - t0:.1f}s")

    # ---- 移植版（修复后）----
    wk = aom.OfficialWorker.load(str(model_path))
    print(f"移植版采样偏移：SAMPLE_OFFSET={aom.SAMPLE_OFFSET}")

    print()
    hdr = f"{'image':<28}{'pg':<4}{'size':<12}{'after mae':<11}{'after max':<11}{'before mae':<12}{'before max':<11}{'identical%':<11}"
    print(hdr)
    print("-" * len(hdr))

    bad = []
    worst_after = (0.0, 0)
    worst_before = (0.0, 0)
    for tag, p in jobs:
        arr = np.asarray(Image.open(p).convert("RGBA"), dtype=np.uint8)
        key = f"{tag}__{p.name}"
        off_pages = ref.get(key, [])
        if not off_pages:
            print(f"{p.name:<28}-    官方未检出，跳过")
            continue

        pages_after = wk.run_image(arr)
        # 历史实现（offset=0.5）复现
        aom.SAMPLE_OFFSET = 0.5
        pages_before = wk.run_image(arr)
        aom.SAMPLE_OFFSET = 0.0

        ra = compare_pages(off_pages[0]["png"], pages_after)
        rb = compare_pages(off_pages[0]["png"], pages_before)
        for row_a, row_b in zip(ra, rb):
            if "mae" not in row_a:
                print(f"{p.name:<28}{row_a['page']:<4}{'-':<12}{row_a['note']}")
                bad.append((p.name, row_a["page"], row_a["note"]))
                continue
            ok = row_a["mae"] < MAE_LIMIT and row_a["max"] <= MAX_LIMIT
            if not ok:
                bad.append((p.name, row_a["page"], f"mae={row_a['mae']:.3f} max={row_a['max']}"))
            worst_after = (max(worst_after[0], row_a["mae"]), max(worst_after[1], row_a["max"]))
            if "mae" in row_b:
                worst_before = (max(worst_before[0], row_b["mae"]), max(worst_before[1], row_b["max"]))
            size = f"{row_a['shape'][0]}x{row_a['shape'][1]}"
            b_mae = f"{row_b['mae']:.3f}" if "mae" in row_b else "-"
            b_max = f"{row_b['max']}" if "max" in row_b else "-"
            print(f"{p.name:<28}{row_a['page']:<4}{size:<12}{row_a['mae']:<11.4f}"
                  f"{row_a['max']:<11}{b_mae:<12}{b_max:<11}{row_a['identical_px_pct']:<11.2f}")

    print()
    print(f"修复后最差：mae={worst_after[0]:.4f} max={worst_after[1]}")
    print(f"修复前最差：mae={worst_before[0]:.4f} max={worst_before[1]}")
    if bad:
        print(f"[FAIL] {len(bad)} 页超限（mae>={MAE_LIMIT} 或 max>{MAX_LIMIT}）：")
        for n, pg, msg in bad[:10]:
            print(f"   {n} p{pg}: {msg}")
        return 1
    print("[PASS] 移植版与官方 worker 逐页等价（差异在浮点后端噪声范围内）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
