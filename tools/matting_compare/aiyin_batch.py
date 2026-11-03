# -*- coding: utf-8 -*-
"""爱印抠图换底 · 批量导出工具。

严格复刻爱印（爱印工具箱）证件照「抠图 + 换底」主链路，逐参数照抄其解密源码，
保证产物与爱印 app 内一致：

链路（照抄 aiyin_decrypted_assets/assets/export-DCg5OXfg.js + vendor/id-photo-matting-worker.js）：

  1) 尺寸对齐 `pf(w, h, n, o=32)`
       r = n / max(1, w, h)
       i(s) = min(n, max(o, round(s * r / o) * o))
       → 按**最长边 n** 等比缩放，并对齐到 32 的倍数（最小 32，最大 n）

  2) 预处理 `du(canvas, inputSize)`
       画布 drawImage 缩放到上一步尺寸 → getImageData → RGBA 原始像素

  3) 推理 `uu(imageData, "matting-v1", w, h)` → vendor/id-photo-matting-worker.js
       - 模型 11680454a03dcfea.onnx（解密件，13,017,110 B）
       - normalization = "half" → (x/255 − 0.5) / 0.5
       - 输出 [1,1,H,W]，模型内已 sigmoid

  4) alpha 还原 `bf(output, w, h)`
       alpha → 灰度画布（R=G=B=255，A=round(alpha*255)）

  5) 回贴原尺寸：把灰度画布 drawImage 放大回原图宽高（高质量平滑）

  6) 换底合成（照抄爱印 `vr()` 的 destination-in 逻辑）
       底色画布 fillStyle=底色 → fillRect → destination-in 贴 alpha 蒙版

爱印 app 默认换「白底」，本工具支持白/红/蓝三色，与超誉 BG_COLORS 一致：
  白 #FFFFFF / 红 #FF0000 / 蓝 #438EDB

用法：
  python tools/matting_compare/aiyin_batch.py \
      --src "D:/50/学员寸照" --out "D:/50/学员寸照_爱印处理" \
      --count 25 --bg white --seed 20261103

输出：
  <out>/<原文件名>.png     换底成品（与原文件名一一对应）
  <out>/_alpha/<原文件名>.png  透明背景 alpha（便于逐张核对边缘）
  <out>/_report.json       机器侧核对报告（清单/参数/耗时/失败原因）
"""
from __future__ import annotations

import argparse
import json
import random
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent.parent
AIYIN_WORKER = ROOT.parent / "aiyin_decrypted_assets" / "vendor" / "id-photo-matting-worker.js"
AIYIN_MODEL = ROOT.parent / "aiyin_models_decrypted" / "11680454a03dcfea.onnx"
OFFICIAL_NODE = ROOT / "tools" / "matting_compare" / "official_node.cjs"

# 爱印 worker 协议常量（照抄 vendor/id-photo-matting-worker.js 的 h 表）
MODEL_ID = "matting-v1"
MODEL_BYTES_EXPECTED = 13_017_110
INPUT_SIZE = 512
NORMALIZATION = "half"

# 超誉 / 爱印一致的证件照底色
BG_COLORS: dict[str, str] = {
    "white": "#FFFFFF",
    "red": "#FF0000",
    "blue": "#438EDB",
}


def aligned_size(width: int, height: int, longest: int, align: int = 32) -> tuple[int, int]:
    """照抄爱印 `pf(t, e, n, o=32)`：按最长边等比缩放并对齐到 `align` 的倍数。

    Args:
        width: 原图宽（像素）。
        height: 原图高（像素）。
        longest: 目标最长边（爱印用 512）。
        align: 对齐倍数（爱印用 32，模型要求 size_divisibility=32）。

    Returns:
        (缩放后宽, 缩放后高)，两者均为 align 的倍数，且不超过 longest。
    """
    ratio = longest / max(1, width, height)

    def scaled(value: int) -> int:
        return min(longest, max(align, round(value * ratio / align) * align))

    return scaled(width), scaled(height)


@dataclass
class ItemResult:
    """单张图片的处理结果记录。"""

    name: str
    src: Path
    out_png: Path
    alpha_png: Path
    ok: bool
    error: str | None = None
    src_size: tuple[int, int] = (0, 0)
    infer_size: tuple[int, int] = (0, 0)
    inference_ms: int = 0
    wall_ms: int = 0
    fg_ratio: float = 0.0
    edge_mean: float = 0.0
    extra: dict[str, Any] = field(default_factory=dict)


def run_official_worker(
    items: list[dict[str, Any]], out_dir: Path, raw_dir: Path
) -> dict[str, Any]:
    """调用 Node 托管的爱印官方 worker，产出 alpha 基线。

    Args:
        items: 每项含 key / rawPath / width / height。
        out_dir: worker 输出目录（.f32 alpha）。
        raw_dir: RGBA 原始像素目录（临时）。

    Returns:
        worker 的 manifest dict。
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    raw_dir.mkdir(parents=True, exist_ok=True)
    job = {
        "workerPath": str(AIYIN_WORKER),
        "modelPath": str(AIYIN_MODEL),
        "modelId": MODEL_ID,
        "outDir": str(out_dir),
        "items": items,
    }
    job_path = out_dir / "job.json"
    job_path.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")

    proc = subprocess.run(
        ["node", str(OFFICIAL_NODE), "--job", str(job_path)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=3600,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"official worker 失败 rc={proc.returncode}: {proc.stderr[-2000:]}")
    return json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))


def composite_background(rgb: Image.Image, alpha: Image.Image, hex_color: str) -> Image.Image:
    """按爱印 `vr()` 的方式把 alpha 蒙版合成到底色上。

    爱印 `vr()` 的等价语义：
        canvas1 = 原图 → globalCompositeOperation="destination-in" → 贴蒙版  (得到带透明的原图)
        canvas2 = fillStyle=底色 + fillRect                        → 底色铺满
        canvas2.drawImage(canvas1)                                  → 原图叠在底色上
    等价于：结果 = 原图 × mask + 底色 × (1 − mask)

    注意：不能用 `RGBA.convert("RGB")`，那只是丢掉 alpha 通道（结果会是一整张纯底色），
    必须用蒙版做 paste 才是真正的合成。

    Args:
        rgb: 原图 RGB。
        alpha: 与原图同尺寸的 alpha 蒙版（L 通道即蒙版值）。
        hex_color: 底色（#RRGGBB）。

    Returns:
        合成后的 RGB 图。
    """
    mask = alpha.convert("L")
    out = Image.new("RGB", rgb.size, hex_color)
    out.paste(rgb, (0, 0), mask)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="爱印抠图换底批量导出")
    ap.add_argument("--src", required=True, help="源目录")
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--count", type=int, default=25, help="抽取张数")
    ap.add_argument("--bg", choices=sorted(BG_COLORS), default="white", help="底色")
    ap.add_argument("--seed", type=int, default=20261103, help="随机种子（保证可复现）")
    ap.add_argument("--jpg-quality", type=int, default=95, help="若输出 JPG 时的质量")
    ap.add_argument("--format", choices=["png", "jpg"], default="png", help="成品格式")
    args = ap.parse_args()

    src = Path(args.src)
    out_root = Path(args.out)
    if not src.is_dir():
        print(f"[aiyin-batch] 源目录不存在: {src}")
        return 1
    if not AIYIN_WORKER.exists() or not AIYIN_MODEL.exists():
        print(f"[aiyin-batch] 爱印 worker/模型缺失: {AIYIN_WORKER} / {AIYIN_MODEL}")
        return 1

    all_files = sorted(
        p for p in src.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")
    )
    if not all_files:
        print(f"[aiyin-batch] 源目录没有图片: {src}")
        return 1

    rng = random.Random(args.seed)
    picked = rng.sample(all_files, min(args.count, len(all_files)))

    out_root.mkdir(parents=True, exist_ok=True)
    alpha_dir = out_root / "_alpha"
    alpha_dir.mkdir(parents=True, exist_ok=True)
    work_dir = ROOT / ".tmp" / "aiyin-batch"
    raw_dir = work_dir / "raw"
    off_dir = work_dir / "official"

    bg_hex = BG_COLORS[args.bg]

    print(f"[aiyin-batch] 源目录 {src}（共 {len(all_files)} 张）")
    print(f"[aiyin-batch] 随机抽取 {len(picked)} 张（seed={args.seed}）")
    print(f"[aiyin-batch] 底色 {args.bg} {bg_hex} | 模型 {MODEL_ID} | 输入边长 {INPUT_SIZE}")
    print(f"[aiyin-batch] 输出 -> {out_root}")

    # ---------- 阶段 1：解码 → 对齐尺寸 → RGBA ----------
    items: list[dict[str, Any]] = []
    metas: dict[str, dict[str, Any]] = {}
    for p in picked:
        try:
            with Image.open(p) as im:
                im = im.convert("RGB")
                w, h = im.size
                tw, th = aligned_size(w, h, INPUT_SIZE)
                small = im.resize((tw, th), Image.LANCZOS)
                rgba = np.asarray(small.convert("RGBA"), dtype=np.uint8)
            key = p.stem
            raw_path = raw_dir / f"{key}.rgba"
            raw_path.parent.mkdir(parents=True, exist_ok=True)
            raw_path.write_bytes(rgba.tobytes())
            items.append({"key": key, "rawPath": str(raw_path), "width": tw, "height": th})
            metas[key] = {"name": p.name, "src": p, "orig": (w, h), "infer": (tw, th)}
        except Exception as exc:  # noqa: BLE001 - 单张失败不应中断整批
            print(f"[aiyin-batch] 解码失败 {p.name}: {exc}")

    # ---------- 阶段 2：爱印官方 worker 推理 ----------
    t0 = time.perf_counter()
    manifest = run_official_worker(items, off_dir, raw_dir)
    official_secs = time.perf_counter() - t0
    official_map = {it["key"]: it for it in manifest["items"]}
    err_map = {e["key"]: e["error"] for e in manifest.get("errors", [])}
    print(f"[aiyin-batch] 官方 worker 完成：成功 {len(official_map)} / 失败 {len(err_map)}（{official_secs:.1f}s）")

    # ---------- 阶段 3：alpha → 换底合成 → 导出 ----------
    results: list[ItemResult] = []
    for p in picked:
        key = p.stem
        out_name = p.stem + (".png" if args.format == "png" else ".jpg")
        out_png = out_root / out_name
        alpha_png = alpha_dir / (p.stem + ".png")
        meta = metas.get(key)

        if meta is None:
            results.append(ItemResult(p.name, p, out_png, alpha_png, False, "解码阶段失败"))
            continue
        if key in err_map:
            results.append(ItemResult(p.name, p, out_png, alpha_png, False, f"worker 失败: {err_map[key]}"))
            continue

        w, h = meta["orig"]
        try:
            alpha512 = np.fromfile(off_dir / f"{key}.f32", dtype=np.float32).reshape(
                meta["infer"][1], meta["infer"][0]
            )
            # bf()：alpha → 灰度蒙版（0..255）
            mask_small = Image.fromarray(
                (np.clip(alpha512, 0, 1) * 255).astype(np.uint8), mode="L"
            )
            # 回贴原尺寸（爱印 drawImage 放大，高质量平滑）
            mask_full = mask_small.resize((w, h), Image.BILINEAR)

            with Image.open(p) as im:
                rgb = im.convert("RGB")

            # 透明背景 alpha 落盘
            rgba_out = Image.new("RGBA", (w, h))
            rgba_out.paste(rgb)
            rgba_out.putalpha(mask_full)
            rgba_out.save(alpha_png)

            composed = composite_background(rgb, mask_full, bg_hex)
            if args.format == "png":
                composed.save(out_png)
            else:
                composed.save(out_png, quality=args.jpg_quality, subsampling=0)

            arr = np.asarray(mask_full)
            fg = float((arr >= 128).mean())
            edge = arr[(arr >= 16) & (arr <= 240)]
            results.append(
                ItemResult(
                    name=p.name,
                    src=p,
                    out_png=out_png,
                    alpha_png=alpha_png,
                    ok=True,
                    src_size=(w, h),
                    infer_size=meta["infer"],
                    inference_ms=int(official_map[key]["inferenceMs"]),
                    wall_ms=int(official_map[key]["wallMs"]),
                    fg_ratio=round(fg, 5),
                    edge_mean=round(float(edge.mean()), 3) if edge.size else 0.0,
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(ItemResult(p.name, p, out_png, alpha_png, False, f"合成阶段异常: {exc}"))

    ok = [r for r in results if r.ok]
    bad = [r for r in results if not r.ok]
    total_ms = sum(r.inference_ms for r in ok)

    report = {
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": {"dir": str(src), "totalFiles": len(all_files)},
        "sampling": {"requested": args.count, "picked": len(picked), "seed": args.seed},
        "params": {
            "pipeline": "爱印原链路：pf(最长边512/32倍数) → du(缩放) → vendor worker(matting-v1) → bf(alpha) → 回贴原尺寸 → destination-in 换底",
            "modelId": MODEL_ID,
            "modelFile": str(AIYIN_MODEL),
            "modelBytes": AIYIN_MODEL.stat().st_size,
            "modelBytesExpected": MODEL_BYTES_EXPECTED,
            "inputSize": INPUT_SIZE,
            "normalization": NORMALIZATION,
            "background": {"name": args.bg, "hex": bg_hex},
            "outputFormat": args.format,
            "workerThreads": official_map[picked[0].stem]["threads"] if ok else None,
            "workerWallSeconds": round(official_secs, 1),
        },
        "summary": {
            "total": len(results),
            "succeeded": len(ok),
            "failed": len(bad),
            "avgInferenceMs": round(total_ms / len(ok)) if ok else 0,
            "minInferenceMs": min((r.inference_ms for r in ok), default=0),
            "maxInferenceMs": max((r.inference_ms for r in ok), default=0),
        },
        "files": [
            {
                "name": r.name,
                "exportPath": str(r.out_png) if r.ok else None,
                "alphaPath": str(r.alpha_png) if r.ok else None,
                "ok": r.ok,
                "error": r.error,
                "sourceSize": f"{r.src_size[0]}x{r.src_size[1]}" if r.ok else None,
                "inferenceSize": f"{r.infer_size[0]}x{r.infer_size[1]}" if r.ok else None,
                "inferenceMs": r.inference_ms if r.ok else None,
                "fgRatio": r.fg_ratio if r.ok else None,
                "edgeMean": r.edge_mean if r.ok else None,
            }
            for r in results
        ],
    }
    (out_root / "_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"\n[aiyin-batch] 成功 {len(ok)} / 失败 {len(bad)}")
    if ok:
        print(f"[aiyin-batch] 推理耗时：平均 {report['summary']['avgInferenceMs']}ms")
    for r in bad:
        print(f"[aiyin-batch] 失败 {r.name}: {r.error}")
    print(f"[aiyin-batch] 报告 -> {out_root / '_report.json'}")
    return 0 if not bad else 3


if __name__ == "__main__":
    sys.exit(main())
