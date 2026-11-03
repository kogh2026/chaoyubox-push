# -*- coding: utf-8 -*-
"""抠图三方对比：爱印 matting-v1 vs 我们的 MODNet vs ISNet（@imgly MIT 权重口径）。

回答「精细发丝档相对爱印是变好还是变差」。

ISNet 口径（照抄 @imgly/background-removal 的实现，见 node_modules 内 dist/index.mjs）：
  - 双线性 resize 到 1024×1024（不保长宽比，keepAspect=false）
  - mean=[128,128,128], std=[256,256,256] → 等价 (x/255 − 0.5) × 2
  - 输出 [1,1,1024,1024]（模型内已 sigmoid）
  - 再 resize 回原图尺寸

注意：ISNet 权重是分片存放的（resources/matting-model/ 下 22 个哈希分片，
由 resources.json 的 /models/isnet_fp16 描述），需要拼接后再喂给 onnxruntime。

用法：
  python tools/matting_compare/compare3.py --dir "D:/50/寸照" --limit 51
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
OUT_ROOT = ROOT / ".tmp" / "matting-compare"
RES_ROOT = ROOT / "resources" / "matting-model"
MODNET_MODEL = RES_ROOT / "modnet" / "modnet.onnx"

ISNET_SIZE = 1024


def load_isnet() -> bytes:
    """拼接 ISNet fp16 权重分片。"""
    manifest = json.loads((RES_ROOT / "resources.json").read_text(encoding="utf-8"))
    entry = manifest["/models/isnet_fp16"]
    buf = bytearray()
    for chunk in sorted(entry["chunks"], key=lambda c: c["offsets"][0]):
        p = RES_ROOT / chunk["name"]
        if not p.exists():
            raise FileNotFoundError(f"缺少 ISNet 分片: {p}")
        buf.extend(p.read_bytes())
    if len(buf) != entry["size"]:
        raise RuntimeError(f"ISNet 分片拼接大小不符: {len(buf)} / {entry['size']}")
    return bytes(buf)


def run_isnet(session: ort.InferenceSession, img: np.ndarray) -> tuple[np.ndarray, int]:
    ih, iw = img.shape[:2]
    pil = Image.fromarray(img).resize((ISNET_SIZE, ISNET_SIZE), Image.BILINEAR)
    a = np.asarray(pil).astype(np.float32)
    # @imgly 的 tensorHWCtoBCHW：float32Data = (rawByte - 128) / 256
    # 注意是「0-255 原始值减 128 再除 256」，不是 (x/255-0.5)/0.5 —— 后者会把对比度放大一倍，
    # 导致前景概率被压低、大面积漏抠（实测前景占比 29% vs 正确口径 63%）。
    a = (a - 128.0) / 256.0
    data = np.ascontiguousarray(a.transpose(2, 0, 1)[None], dtype=np.float32)
    t0 = time.perf_counter()
    out = session.run(None, {"input": data})
    ms = round((time.perf_counter() - t0) * 1000)
    alpha = out[0][0, 0]
    apil = Image.fromarray((np.clip(alpha, 0, 1) * 255).astype(np.uint8), mode="L").resize((iw, ih), Image.BILINEAR)
    return np.asarray(apil), ms


def metrics(a_ref: np.ndarray, a_ours: np.ndarray) -> dict:
    r = a_ref.astype(np.int16)
    o = a_ours.astype(np.int16)
    diff = np.abs(r - o).astype(np.float64)
    rb, ob = r >= 128, o >= 128
    union = np.logical_or(rb, ob).sum()
    iou = float(np.logical_and(rb, ob).sum()) / float(union) if union else 1.0
    edge = ((r >= 16) & (r <= 240)) | ((o >= 16) & (o <= 240))
    lost = np.logical_and(rb, ~ob).sum()
    return {
        "iou": round(iou, 5),
        "meanAbs": round(float(diff.mean()), 3),
        "p99Abs": round(float(np.percentile(diff, 99)), 3),
        "edgeDiff": round(float(diff[edge].mean()) if edge.any() else 0.0, 3),
        "lostFgRatio": round(float(lost) / float(rb.sum()) if rb.sum() else 0.0, 5),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--limit", type=int, default=51)
    args = ap.parse_args()

    src = Path(args.dir)
    files = sorted([p for p in src.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png")])[: args.limit]

    officialDir = OUT_ROOT / "official"
    manifest = json.loads((officialDir / "manifest.json").read_text(encoding="utf-8"))
    officialMap = {it["key"]: it for it in manifest["items"]}

    so = ort.SessionOptions()
    so.log_severity_level = 3
    modSess = ort.InferenceSession(str(MODNET_MODEL), sess_options=so, providers=["CPUExecutionProvider"])
    print("[compare3] loading ISNet fp16 weights ...", flush=True)
    isnetBytes = load_isnet()
    isnetSess = ort.InferenceSession(isnetBytes, sess_options=so, providers=["CPUExecutionProvider"])
    print(f"[compare3] ISNet loaded ({len(isnetBytes)/1048576:.1f} MB)", flush=True)

    rows = []
    for p in files:
        key = p.stem
        if key not in officialMap:
            continue
        img = Image.open(p).convert("RGB")
        arr = np.asarray(img)

        a512 = np.fromfile(officialDir / f"{key}.f32", dtype=np.float32).reshape(512, 512)
        a_ref = np.asarray(
            Image.fromarray((np.clip(a512, 0, 1) * 255).astype(np.uint8), mode="L").resize(
                (img.width, img.height), Image.BILINEAR)
        )

        # MODNet
        sys.path.insert(0, str(ROOT / "tools" / "matting_compare"))
        from compare import run_modnet  # 复用同一口径
        mAlpha, mMs = run_modnet(modSess, arr)
        # ISNet
        iAlpha, iMs = run_isnet(isnetSess, arr)

        row = {
            "key": key,
            "modnet": metrics(a_ref, mAlpha) | {"ms": mMs},
            "isnet": metrics(a_ref, iAlpha) | {"ms": iMs},
            "aiyinMs": officialMap[key]["inferenceMs"],
        }
        rows.append(row)
        print(f"  {key}: modnet IoU={row['modnet']['iou']}  isnet IoU={row['isnet']['iou']}", flush=True)

    def agg(path: list[str]) -> dict:
        out = {}
        for f in ("iou", "meanAbs", "p99Abs", "edgeDiff", "lostFgRatio", "ms"):
            vals = [r[path[0]][f] for r in rows]
            out[f] = round(float(np.mean(vals)), 4) if vals else None
        return out

    aMod = agg(["modnet"])
    aIs = agg(["isnet"])
    aAiy = round(float(np.mean([r["aiyinMs"] for r in rows])), 1)

    report = {"dir": str(src), "n": len(rows), "modnet": aMod, "isnet": aIs, "aiyinMs": aAiy, "records": rows}
    (OUT_ROOT / "report3.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n=== 三方汇总（对比爱印 matting-v1，51 张寸照）===")
    print(f"{'指标':<14}{'MODNet(快速)':<16}{'ISNet(精细)':<16}")
    print(f"{'IoU':<14}{aMod['iou']:<16}{aIs['iou']:<16}")
    print(f"{'edgeDiff':<14}{aMod['edgeDiff']:<16}{aIs['edgeDiff']:<16}")
    print(f"{'lostFgRatio':<14}{aMod['lostFgRatio']:<16}{aIs['lostFgRatio']:<16}")
    print(f"{'p99Abs':<14}{aMod['p99Abs']:<16}{aIs['p99Abs']:<16}")
    print(f"{'耗时/张(ms)':<14}{aMod['ms']:<16}{aIs['ms']:<16}  爱印 {aAiy}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
