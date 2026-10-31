# -*- coding: utf-8 -*-
"""官方侧适配器：**原样执行爱印 vendor worker**（Node 托管），不做算法移植。

与 adapter_official_model.py（Python 1:1 移植）的区别：
- official_worker：把爱印解密得到的 id2pdf-card-correction-worker.js 原文件在 Node 里 eval 执行，
  同一份 JS、同一份 FP32 权重、同一 ort(wasm) 后端 → 官方产出逐位可信。
- official_model：纯 Python 复刻，便于无 Node 环境/单步调试，但存在移植误差（亚像素偏移）。

协议：Python 把每张图解码成 raw RGBA 落盘 → Node 批量跑 → 回写 raw RGBA → Python 转 PNG。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
RUNNER = HERE / "official_worker_node.cjs"


class OfficialWorkerNode:
    """批量调用 Node 托管的爱印官方 worker。"""

    def __init__(self, worker_path: str, model_path: str, max_pages: int = 2,
                 min_area_frac: float = 0.04):
        self.worker_path = str(Path(worker_path).resolve())
        self.model_path = str(Path(model_path).resolve())
        self.max_pages = max_pages
        self.min_area_frac = min_area_frac
        self.last_stats: dict = {}

    def run_batch(self, entries: list[tuple[str, Path]], out_dir: Path,
                  log=print) -> dict[str, list[dict]]:
        """entries: [(key, image_path)]，key 由调用方定义并用于回查。

        返回 {key: [ {page, png, width, height, score, angle, upright_turns, corners} ]}
        另外 last_stats 里带 nPages/passes/room（用于结构性差异分析）。
        """
        out_dir = Path(out_dir).resolve()
        out_dir.mkdir(parents=True, exist_ok=True)
        raw_dir = out_dir / "_raw"
        raw_dir.mkdir(parents=True, exist_ok=True)

        items = []
        for key, img_path in entries:
            arr = np.asarray(Image.open(img_path).convert("RGBA"), dtype=np.uint8)
            h, w = arr.shape[:2]
            raw_path = raw_dir / f"{_safe(key)}.rgba"
            raw_path.write_bytes(arr.tobytes())
            items.append({"key": key, "rawPath": str(raw_path), "width": int(w), "height": int(h)})

        job = {
            "workerPath": self.worker_path,
            "modelPath": self.model_path,
            "maxPages": self.max_pages,
            "minAreaFrac": self.min_area_frac,
            "outDir": str(out_dir),
            "items": items,
        }
        job_path = out_dir / "job.json"
        job_path.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")

        cmd = ["node", str(RUNNER), "--job", str(job_path)]
        proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(ROOT))
        if proc.returncode != 0:
            raise RuntimeError(f"官方 worker 运行失败：{(proc.stderr or proc.stdout)[-2000:]}")
        log(f"  官方 worker：{proc.stdout.strip()}")

        man_path = out_dir / "manifest.json"
        manifest = json.loads(man_path.read_text(encoding="utf-8"))
        if manifest.get("errors"):
            for e in manifest["errors"][:5]:
                log(f"  ! 官方侧失败 {e['key']}: {e['error']}")

        # 结构性元数据（每图页数/passes/room）
        stats: dict[str, dict] = {}
        for c in manifest["clips"]:
            if c.get("page", -1) < 0:
                stats[c["key"]] = {"nPages": c.get("nPages", 0),
                                   "passes": c.get("passes"), "room": c.get("room")}

        result: dict[str, list[dict]] = {}
        for c in manifest["clips"]:
            if c.get("page", -1) < 0:
                continue
            w, h = int(c["width"]), int(c["height"])
            buf = (out_dir / c["file"]).read_bytes()
            rgba = np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 4)
            png = out_dir / f"{_safe(c['key'])}__p{c['page']}.png"
            Image.fromarray(rgba[:, :, :3], "RGB").save(png)
            result.setdefault(c["key"], []).append({
                "page": c["page"], "png": png, "width": w, "height": h,
                "score": c.get("score"), "angle": c.get("angle"),
                "upright_turns": c.get("uprightTurns"), "corners": c.get("corners"),
            })
        for v in result.values():
            v.sort(key=lambda x: x["page"])

        self.last_stats = stats
        return result


def _safe(s: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in s)


if __name__ == "__main__":
    # 自测：单图跑官方 worker
    img = sys.argv[1] if len(sys.argv) > 1 else r"D:/50/身份证正面/42108119890413556X.jpg"
    w = OfficialWorkerNode(
        "../../aiyin_decrypted_assets/vendor/id2pdf-card-correction-worker.js",
        ROOT / "resources/card-model/card-correction-fp32.onnx",
    )
    res = w.run_batch([("demo", Path(img))], ROOT / ".tmp/aiyin_worker_demo")
    for k, v in res.items():
        print(k, [(x["page"], x["width"], x["height"], round(x["score"], 3), x["angle"]) for x in v])
