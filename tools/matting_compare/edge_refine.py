# -*- coding: utf-8 -*-
"""边缘精修（A/B 对照）实验台。

目标：验证「MODNet + 边缘精修」能否消除换底后发丝处的原底色残留，
同时不损伤发丝细节。

## 成因假设（需实测验证）
抠图模型输出的是 alpha 蒙版，前景像素的 RGB 仍是**原图**的颜色。原始照片里
「发丝」这类半透明像素本身就是 前景色×alpha + 原底色×(1-alpha) 的**混合色**
（摄影/光栅化天然如此）。直接把它贴到新底色上，混合色里的原底色分量就会
在新底色上显形 —— 这就是残留晕边的成因。

对应三种精修策略：
  none    : 不处理（基线）
  naive   : 现有 defringe 的做法 —— 把边缘 RGB 整体替换为最近不透光像素的纯色
            （会把发丝自身颜色一起抹平）
  unmix   : 颜色解混 —— 由 C = a·F + (1-a)·B 反解纯前景色 F = (C - (1-a)·B)/a，
            B 取该图原底色估计。保留发丝本身的色调与半透明渐变。

## 指标
  residue   边缘带内「仍接近原底色」的像素占比（越低越好）
  colorErr  边缘带内与原底色的平均 |ΔRGB| 距离（越低越好）
  detailKeep 发丝区（alpha 0<a<1 的高梯度区）与**精修前**的 alpha 结构相似度
             （SSIM，越高说明细节没被抹掉）
  fgLoss    前景面积变化（<0 意味着掉细节）

用法：
  python tools/matting_compare/edge_refine.py --dir "D:/50/学员寸照" --count 8 --bg blue
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent.parent
AIYIN_WORKER = ROOT.parent / "aiyin_decrypted_assets" / "vendor" / "id-photo-matting-worker.js"
AIYIN_MODEL = ROOT.parent / "aiyin_models_decrypted" / "11680454a03dcfea.onnx"
OFFICIAL_NODE = ROOT / "tools" / "matting_compare" / "official_node.cjs"

Strategy = Literal["none", "naive", "unmix"]


def aligned_size(width: int, height: int, longest: int = 512, align: int = 32) -> tuple[int, int]:
    """照抄爱印 `pf()`：按最长边等比缩放并对齐到 align 的倍数。"""
    ratio = longest / max(1, width, height)

    def scaled(value: int) -> int:
        return min(longest, max(align, round(value * ratio / align) * align))

    return scaled(width), scaled(height)


def estimate_bg(rgb: np.ndarray, alpha: np.ndarray | None = None) -> np.ndarray:
    """估计原图底色。

    优先用 **alpha=0 区域的中位数**（那是模型判定的确定背景，最可靠）；
    无 alpha 时回退到四角 6% 区域均值。

    为什么不用四角法：证件照的四角常常落在人像（肩膀、浅色衣服）上，
    实测红底那张四角均值给的是 (234,126,133)（其实是肤色），而真实底色是 (239,22,30)
    —— 四角法会把肤色当底色，导致解混把前景推向错误颜色。

    Args:
        rgb: 原图 HxWx3 float 数组。
        alpha: 可选的 alpha 蒙版 HxW float（0..1）。

    Returns:
        3 元素背景色估计（float）。
    """
    if alpha is not None:
        zero = alpha <= 0.004
        if zero.sum() > 200:
            return np.median(rgb[zero], axis=0)
    if alpha is not None:
        zero = alpha <= 0.004
        if zero.sum() > 200:
            return np.median(rgb[zero], axis=0)
    h, w = rgb.shape[:2]
    m = max(1, int(min(w, h) * 0.06))
    corners = [
        rgb[:m, :m].reshape(-1, 3).mean(0),
        rgb[:m, -m:].reshape(-1, 3).mean(0),
        rgb[-m:, :m].reshape(-1, 3).mean(0),
        rgb[-m:, -m:].reshape(-1, 3).mean(0),
    ]
    return np.median(np.stack(corners), axis=0)


def refine_unmix(
    rgb: np.ndarray,
    alpha: np.ndarray,
    bg: np.ndarray,
    strength: float = 1.0,
    kappa: float = 0.35,
) -> np.ndarray:
    """颜色解混（与产品实现 src/lib/edgeRefine.ts 同口径）。

    C = a·F + (1−a)·B  →  F = (C − (1−a)·B) / a

    三步：①解混 + 色域钳制 ②仅在边缘带内做 3×3 平滑 ③按置信度加权写回。

    Args:
        rgb: 原图 HxWx3 float（0..255）。
        alpha: HxW float（0..1）。
        bg: 原底色估计（3 元素）。
        strength: 精修强度 0..1。
        kappa: 置信度指数，越小越激进。

    Returns:
        精修后的 RGB（float，与输入同形）。
    """
    out = rgb.copy()
    edge = (alpha > 0.004) & (alpha < 0.996)
    if not edge.any():
        return out

    h, w = alpha.shape
    a_full = alpha
    idx = np.argwhere(edge)
    a = a_full[edge][:, None]
    c = rgb[edge]
    b = bg[None, :].astype(np.float64)

    # ① 解混
    inv = 1.0 / np.maximum(a, 1e-3)
    f = (c - (1.0 - a) * b) * inv
    # 色域钳制：以 C 为中心、半径 max(24, |C−B|·2.5)
    lim = np.maximum(24.0, np.abs(c - b) * 2.5)
    f = np.clip(f, c - lim, c + lim)
    f = np.clip(f, 0.0, 255.0)
    delta = f - c

    # ② 仅在边缘带内做 3×3 盒滤波（孤立发丝像素不能被全透明邻居稀释）
    dmap = np.zeros((h, w, 3), dtype=np.float64)
    dmap[edge] = delta
    acc = np.zeros_like(dmap)
    cnt = np.zeros((h, w, 1), dtype=np.float64)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            shifted = np.roll(np.roll(dmap, dy, axis=0), dx, axis=1)
            shifted_edge = np.roll(np.roll(edge, dy, axis=0), dx, axis=1)
            acc[shifted_edge] += shifted[shifted_edge]
            cnt[shifted_edge] += 1.0
    smoothed = np.divide(acc, cnt, out=np.zeros_like(acc), where=cnt > 0)
    delta = smoothed[edge]

    # ③ 置信度加权：w = 1 − (1−a)^(1/kappa)，下限 0.35
    pw = 1.0 / max(0.05, kappa)
    wbase = 1.0 - np.power(1.0 - a, pw)
    w = np.clip(strength * wbase, 0.35, 1.0)

    out[edge] = c + delta * w
    return out


def refine_naive(rgb: np.ndarray, alpha: np.ndarray, strength: float = 1.0) -> np.ndarray:
    """现有 defringe 的等价实现：边缘 RGB 替换为最近不透光邻居的纯色。

    Args:
        rgb: 原图 HxWx3 float（0..255）。
        alpha: HxW float（0..1）。
        strength: 替换强度 0..1。

    Returns:
        处理后的 RGB。
    """
    out = rgb.copy()
    h, w = alpha.shape
    opaque = alpha >= 0.98
    edge = (alpha > 0.004) & (alpha < 0.996)
    if not edge.any() or not opaque.any():
        return out

    # 迭代膨胀：把不透明像素的颜色向外扩散 5 轮（照抄 defringe 的 RADIUS=5）
    cur = rgb.copy()
    known = opaque.copy()
    for _ in range(5):
        # 8 邻域求和与计数（用移位实现，避免 numpy 版本差异）
        acc = np.zeros_like(cur)
        cnt = np.zeros((h, w), dtype=np.float64)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                shifted = np.roll(np.roll(cur, dy, axis=0), dx, axis=1)
                mask = np.roll(np.roll(known, dy, axis=0), dx, axis=1)
                acc[mask] += shifted[mask]
                cnt[mask] += 1
        newly = edge & (~known) & (cnt > 0)
        if not newly.any():
            break
        cur[newly] = acc[newly] / cnt[newly][:, None]
        known |= newly

    target = cur[edge]
    out[edge] = rgb[edge] * (1 - strength) + target * strength
    return out


def composite(rgb: np.ndarray, alpha: np.ndarray, hex_color: str) -> np.ndarray:
    """把前景按 alpha 合成到底色。

    Args:
        rgb: HxWx3 float（0..255）。
        alpha: HxW float（0..1）。
        hex_color: 底色 #RRGGBB。

    Returns:
        HxWx3 uint8 成品。
    """
    bg = np.array(
        [int(hex_color[1:3], 16), int(hex_color[3:5], 16), int(hex_color[5:7], 16)],
        dtype=np.float64,
    )
    a = alpha[:, :, None]
    out = rgb * a + bg[None, None, :] * (1.0 - a)
    return np.clip(out, 0, 255).astype(np.uint8)


def metrics(
    out_rgb: np.ndarray,
    orig_rgb: np.ndarray,
    alpha: np.ndarray,
    bg: np.ndarray,
    target_bg: np.ndarray,
) -> dict[str, float]:
    """计算边缘质量指标。

    Args:
        out_rgb: 精修后合成到目标底的成品 HxWx3 uint8。
        orig_rgb: 精修前的原图 HxWx3 float。
        alpha: alpha 蒙版 HxW float（0..1）。
        bg: 原底色估计。
        target_bg: 目标底色 RGB。

    Returns:
        指标字典。
    """
    edge = (alpha > 0.004) & (alpha < 0.996)
    if edge.sum() == 0:
        return {"residue": 0.0, "colorErr": 0.0, "fgLoss": 0.0, "detailRatio": 1.0, "haze": 0.0}

    oe = out_rgb[edge].astype(np.float64)
    d = np.abs(oe - bg[None, :]).sum(1)
    residue = float((d < 60).mean())
    color_err = float(d.mean())

    # haze（残雾/晕边）：成品边缘像素里**同时**离原底色近、离目标底色也近的比例
    # → 说明这一像素还挂着原底色，没被目标底色接管
    d_t = np.abs(oe - target_bg[None, :]).sum(1)
    haze = float(((d < 60) & (d_t > 60)).mean())

    fg_before = float((alpha >= 0.5).mean())
    return {
        "residue": round(residue * 100, 3),
        "colorErr": round(color_err, 3),
        "haze": round(haze * 100, 3),
        "fgLoss": round(fg_before, 4),
    }


def ssim_1d(a: np.ndarray, b: np.ndarray) -> float:
    """对 alpha 结构做一维 SSIM（衡量发丝细节是否被抹平）。

    Args:
        a: 参照 alpha。
        b: 对比 alpha。

    Returns:
        SSIM 值（1 为完全相同）。
    """
    c1 = (0.01 * 255) ** 2
    c2 = (0.03 * 255) ** 2
    mu_a = a.mean()
    mu_b = b.mean()
    sa = a.var()
    sb = b.var()
    cov = ((a - mu_a) * (b - mu_b)).mean()
    num = (2 * mu_a * mu_b + c1) * (2 * cov + c2)
    den = (mu_a**2 + mu_b**2 + c1) * (sa + sb + c2)
    return float(num / den) if den else 1.0


def run_official(items: list[dict[str, Any]], out_dir: Path, raw_dir: Path) -> dict[str, Any]:
    """调用 Node 托管的爱印官方 worker 产出 alpha 基线。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    raw_dir.mkdir(parents=True, exist_ok=True)
    job = {
        "workerPath": str(AIYIN_WORKER),
        "modelPath": str(AIYIN_MODEL),
        "modelId": "matting-v1",
        "outDir": str(out_dir),
        "items": items,
    }
    job_path = out_dir / "job.json"
    job_path.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
    proc = subprocess.run(
        ["node", str(OFFICIAL_NODE), "--job", str(job_path)],
        cwd=str(ROOT), capture_output=True, text=True, timeout=3600,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"official worker failed: {proc.stderr[-1500:]}")
    return json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--count", type=int, default=8)
    ap.add_argument("--bg", default="#438EDB", help="目标底色（默认蓝底，最容易看出残留）")
    ap.add_argument("--seed", type=int, default=20261103)
    ap.add_argument("--out", default=".tmp/edge-refine")
    args = ap.parse_args()

    src = Path(args.dir)
    out_root = ROOT / args.out
    out_root.mkdir(parents=True, exist_ok=True)
    work = ROOT / ".tmp" / "edge-refine-work"
    raw_dir, off_dir = work / "raw", work / "official"

    files = sorted(p for p in src.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    import random
    picked = random.Random(args.seed).sample(files, min(args.count, len(files)))

    # --- 解码 + 对齐 + 送官方 worker ---
    items: list[dict[str, Any]] = []
    metas: dict[str, dict[str, Any]] = {}
    for p in picked:
        with Image.open(p) as im:
            im = im.convert("RGB")
            w, h = im.size
            tw, th = aligned_size(w, h)
            small = im.resize((tw, th), Image.LANCZOS)
            rgba = np.asarray(small.convert("RGBA"), dtype=np.uint8)
        raw_path = raw_dir / f"{p.stem}.rgba"
        raw_path.parent.mkdir(parents=True, exist_ok=True)
        raw_path.write_bytes(rgba.tobytes())
        items.append({"key": p.stem, "rawPath": str(raw_path), "width": tw, "height": th})
        metas[p.stem] = {"path": p, "orig": (w, h), "infer": (tw, th)}

    t0 = time.perf_counter()
    manifest = run_official(items, off_dir, raw_dir)
    worker_secs = time.perf_counter() - t0
    official = {it["key"]: it for it in manifest["items"]}
    print(f"[refine] 官方 worker: {len(official)} 张，{worker_secs:.1f}s")

    rows: list[dict[str, Any]] = []
    for p in picked:
        key = p.stem
        if key not in official:
            continue
        meta = metas[key]
        with Image.open(p) as im:
            rgb_full = np.asarray(im.convert("RGB"), dtype=np.float64)
        w, h = meta["orig"]

        a_small = np.fromfile(off_dir / f"{key}.f32", dtype=np.float32).reshape(
            meta["infer"][1], meta["infer"][0]
        )
        alpha_full = np.asarray(
            Image.fromarray((np.clip(a_small, 0, 1) * 255).astype(np.uint8), mode="L").resize(
                (w, h), Image.BILINEAR
            ),
            dtype=np.float64,
        ) / 255.0

        bg = estimate_bg(rgb_full, alpha_full)
        target_bg = np.array(
            [int(args.bg[1:3], 16), int(args.bg[3:5], 16), int(args.bg[5:7], 16)],
            dtype=np.float64,
        )

        variants: dict[str, np.ndarray] = {
            "none": rgb_full,
            "naive": refine_naive(rgb_full, alpha_full, 1.0),
            "unmix": refine_unmix(rgb_full, alpha_full, bg, 1.0),
        }

        rec: dict[str, Any] = {
            "name": p.name,
            "key": key,
            "bg": [round(float(x), 1) for x in bg],
            "inferenceMs": official[key]["inferenceMs"],
        }

        for strat, rgb_v in variants.items():
            out_img = composite(rgb_v, alpha_full, args.bg)
            m = metrics(out_img, rgb_full, alpha_full, bg, target_bg)
            # 细节保留：边缘带 R 通道梯度幅值之比（精修不该抹平发丝的明暗结构）
            edge = (alpha_full > 0.004) & (alpha_full < 0.996)
            if edge.sum() > 1:
                g0 = float(np.abs(np.diff(rgb_full[edge][:, 0])).mean())
                g1 = float(np.abs(np.diff(rgb_v[edge][:, 0])).mean())
                m["detailRatio"] = round(g1 / g0 if g0 > 0 else 1.0, 4)
            else:
                m["detailRatio"] = 1.0
            rec[strat] = m
            Image.fromarray(out_img).save(out_root / f"{key}__{strat}.png")

        # alpha 指纹（精修不动 alpha，此处记录作为基线指纹）
        rec["alphaHash"] = int((alpha_full[::7, ::7] * 255).sum())
        rows.append(rec)

    # --- 汇总 ---
    print("\n=== 边缘精修 A/B/C 对照（目标底色 %s）===" % args.bg)
    print(f"{'样本':<24}{'none 晕边':<12}{'naive 晕边':<12}{'unmix 晕边':<12}{'none 残留':<12}{'unmix 残留':<12}{'unmix 细节'}")
    print("-" * 108)
    for r in rows:
        print(
            f"{r['name']:<24}"
            f"{r['none']['haze']:<12.2f}{r['naive']['haze']:<12.2f}{r['unmix']['haze']:<12.2f}"
            f"{r['none']['residue']:<12.2f}{r['unmix']['residue']:<12.2f}{r['unmix']['detailRatio']:.3f}"
        )
    agg = {}
    for strat in ("none", "naive", "unmix"):
        agg[strat] = {
            "haze": round(float(np.mean([r[strat]["haze"] for r in rows])), 3),
            "residue": round(float(np.mean([r[strat]["residue"] for r in rows])), 3),
            "colorErr": round(float(np.mean([r[strat]["colorErr"] for r in rows])), 2),
            "detailRatio": round(float(np.mean([r[strat]["detailRatio"] for r in rows])), 4),
        }
    print("\n=== 均值 ===")
    for strat, v in agg.items():
        print(
            f"  {strat:<6} 晕边 {v['haze']:>6.2f}%  残留 {v['residue']:>6.2f}%  "
            f"平均色偏 {v['colorErr']:>7.1f}  细节保持 {v['detailRatio']:.3f}"
        )

    (out_root / "report.json").write_text(
        json.dumps({"bg": args.bg, "aggregate": agg, "records": rows}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\n[refine] 产物 -> {out_root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
