# -*- coding: utf-8 -*-
"""抠图对比：爱印官方 matting-v1 vs 我们的 MODNet（以及可选 ISNet）。

回答的问题：V4「精细发丝」的 A/B/C/D 四方案，最终效果能不能**超越爱印**？
先建立爱印真值基线（官方 worker 原样跑，零移植），再逐像素比。

口径必须与爱印一致，否则比的是噪声：
  爱印 worker（vendor/id-photo-matting-worker.js）：
    - 输入 512×512（32 的倍数），不保长宽比
    - normalization="half" → (x/255 − 0.5)/0.5
    - 输出 [1,1,512,512]，已是 sigmoid 后的 alpha

  我们的 MODNet（src/lib/matting.worker.ts runModnet）：
    - 最短边 512、32 倍数、保持长宽比
    - 归一化 (x/255)*2 − 1
    - 输出 [1,1,h,w]，已 sigmoid

指标：
  IoU        alpha>=128 区域的交并比（整体轮廓一致）
  meanAbs    |Δalpha| 平均（整体差异）
  p99Abs     |Δalpha| 99 分位（极端差异）
  edgeDiff   只在「边缘带」（任一侧 alpha ∈ 16..240）统计的平均 |Δalpha| —— 最能反映发丝质量
  hairRecall  爱印 alpha>128 而我方 alpha<128 的像素占比（我方**丢掉**的发丝，越低越好）

用法：
  python tools/matting_compare/compare.py --dir "D:/50/寸照" --limit 10
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent.parent
AIYIN_WORKER = ROOT.parent / "aiyin_decrypted_assets" / "vendor" / "id-photo-matting-worker.js"
AIYIN_MODEL = ROOT.parent / "aiyin_models_decrypted" / "11680454a03dcfea.onnx"
MODNET_MODEL = ROOT / "resources" / "matting-model" / "modnet" / "modnet.onnx"
OFFICIAL_NODE = ROOT / "tools" / "matting_compare" / "official_node.cjs"

AIYIN_SIZE = 512


def modnet_size(iw: int, ih: int) -> tuple[int, int]:
    """照抄 src/lib/matting.worker.ts modnetSize：最短边 512、32 的倍数、保长宽比。"""
    scale = 512 / min(iw, ih)
    w = max(32, round(iw * scale))
    h = max(32, round(ih * scale))
    return (w - (w % 32) or 32, h - (h % 32) or 32)


def run_modnet(session: ort.InferenceSession, img: np.ndarray) -> tuple[np.ndarray, int]:
    """返回 (alpha 原尺寸 uint8, 推理毫秒)。归一化 (x/255)*2−1，照抄 runModnet。"""
    ih, iw = img.shape[:2]
    w, h = modnet_size(iw, ih)
    pil = Image.fromarray(img).resize((w, h), Image.BILINEAR)
    a = np.asarray(pil).astype(np.float32) / 255.0 * 2.0 - 1.0
    data = np.ascontiguousarray(a.transpose(2, 0, 1)[None], dtype=np.float32)
    t0 = time.perf_counter()
    out = session.run(None, {"input": data})
    ms = round((time.perf_counter() - t0) * 1000)
    alpha = out[0][0, 0]
    # 回贴到原尺寸（双线性）
    apil = Image.fromarray((np.clip(alpha, 0, 1) * 255).astype(np.uint8), mode="L").resize((iw, ih), Image.BILINEAR)
    return np.asarray(apil), ms


def metrics(a_ref: np.ndarray, a_ours: np.ndarray) -> dict:
    """a_ref / a_ours 均为 uint8 原尺寸 alpha。"""
    r = a_ref.astype(np.int16)
    o = a_ours.astype(np.int16)
    diff = np.abs(r - o).astype(np.float64)

    rb = r >= 128
    ob = o >= 128
    inter = np.logical_and(rb, ob).sum()
    union = np.logical_or(rb, ob).sum()
    iou = float(inter) / float(union) if union else 1.0

    edge = (r >= 16) & (r <= 240) | (o >= 16) & (o <= 240)
    edge_diff = float(diff[edge].mean()) if edge.any() else 0.0

    # 我方丢掉的“爱印认为是前景”的像素（发丝断裂的直接体现）
    lost = np.logical_and(rb, ~ob).sum()
    hair_recall = float(lost) / float(rb.sum()) if rb.sum() else 0.0

    return {
        "iou": round(iou, 5),
        "meanAbs": round(float(diff.mean()), 3),
        "p99Abs": round(float(np.percentile(diff, 99)), 3),
        "edgeDiff": round(edge_diff, 3),
        "lostFgRatio": round(hair_recall, 5),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--out", default=".tmp/matting-compare")
    args = ap.parse_args()

    src = Path(args.dir)
    files = sorted([p for p in src.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png")])[: args.limit]
    if not files:
        print(f"no images in {src}")
        return 1

    outRoot = ROOT / args.out
    rawDir = outRoot / "raw"
    officialDir = outRoot / "official"
    rawDir.mkdir(parents=True, exist_ok=True)
    officialDir.mkdir(parents=True, exist_ok=True)

    # 1) 解码 → 512×512 raw RGBA（爱印输入规格），同时存原图数组供 MODNet 用
    items = []
    meta = []
    for p in files:
        img = Image.open(p).convert("RGB")
        small = img.resize((AIYIN_SIZE, AIYIN_SIZE), Image.BILINEAR)
        rgba = np.asarray(small.convert("RGBA"), dtype=np.uint8).reshape(-1)
        key = p.stem
        rawPath = rawDir / f"{key}.rgba"
        rawPath.write_bytes(rgba.tobytes())
        items.append({"key": key, "rawPath": str(rawPath), "width": AIYIN_SIZE, "height": AIYIN_SIZE})
        meta.append({"key": key, "src": str(p), "w": img.width, "h": img.height})

    # 2) 调爱印官方 worker
    job = {
        "workerPath": str(AIYIN_WORKER),
        "modelPath": str(AIYIN_MODEL),
        "modelId": "matting-v1",
        "outDir": str(officialDir),
        "items": items,
    }
    jobPath = outRoot / "job.json"
    jobPath.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")

    print(f"[compare] running aiyin official worker on {len(items)} images ...")
    t0 = time.perf_counter()
    proc = subprocess.run(
        ["node", str(OFFICIAL_NODE), "--job", str(jobPath)],
        cwd=str(ROOT), capture_output=True, text=True,
    )
    if proc.returncode != 0:
        print(proc.stdout[-2000:])
        print(proc.stderr[-3000:])
        return 2
    officialWall = time.perf_counter() - t0
    print(f"[compare] official done in {officialWall:.1f}s")

    manifest = json.loads((officialDir / "manifest.json").read_text(encoding="utf-8"))
    officialMap = {it["key"]: it for it in manifest["items"]}

    # 3) 跑我们的 MODNet
    so = ort.SessionOptions()
    so.log_severity_level = 3
    sess = ort.InferenceSession(str(MODNET_MODEL), sess_options=so, providers=["CPUExecutionProvider"])

    rows = []
    for m in meta:
        key = m["key"]
        if key not in officialMap:
            continue
        img = Image.open(m["src"]).convert("RGB")
        arr = np.asarray(img)
        ours, ms = run_modnet(sess, arr)

        # 爱印输出是 512 尺度，回贴到原尺寸再比（与官方 app 的行为一致：512 推理 → resize 回原图）
        off = officialDir / f"{key}.f32"
        a512 = np.fromfile(off, dtype=np.float32).reshape(AIYIN_SIZE, AIYIN_SIZE)
        a_ref = np.asarray(
            Image.fromarray((np.clip(a512, 0, 1) * 255).astype(np.uint8), mode="L").resize(
                (img.width, img.height), Image.BILINEAR
            )
        )

        mm = metrics(a_ref, ours)
        mm["key"] = key
        mm["modnetMs"] = ms
        mm["aiyinMs"] = officialMap[key]["inferenceMs"]
        rows.append(mm)

    agg = {}
    for f in ("iou", "meanAbs", "p99Abs", "edgeDiff", "lostFgRatio", "modnetMs", "aiyinMs"):
        vals = [r[f] for r in rows if f in r]
        agg[f] = round(float(np.mean(vals)), 4) if vals else None
    agg["n"] = len(rows)

    report = {"dir": str(src), "aggregate": agg, "records": rows,
              "officialErrors": manifest.get("errors", [])}
    (outRoot / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n=== 汇总（我方 MODNet vs 爱印 matting-v1）===")
    print(f"样本 {agg['n']} 张")
    print(f"IoU        {agg['iou']}   (1=完全一致)")
    print(f"edgeDiff   {agg['edgeDiff']}   (边缘带平均差，越小越好)")
    print(f"lostFg     {agg['lostFgRatio']}   (我方丢掉的发丝占比，越小越好)")
    print(f"耗时/张    我方 {agg['modnetMs']}ms  爱印 {agg['aiyinMs']}ms")
    return 0


if __name__ == "__main__":
    sys.exit(main())
