# -*- coding: utf-8 -*-
"""对比 pre-fix 与 post-fix 在同样 100 张图像上的输出，定位回归。

读取 tools/bench_regress.py 落盘的：
  .tmp/regress/pre/report.json  + .tmp/regress/pre/<mode>__<dir>/*.png
  .tmp/regress/post/report.json + .tmp/regress/post/<mode>__<dir>/*.png

对比维度：
  1) 指标：卡片数 / 徽标分布 / 平均置信 / 长宽比偏差（几何是否变化）
  2) 像素：同名卡片校正裁剪图逐像素 diff（定位 warp 几何/填充回归）
  3) 边框：检测修复①（越界填白）在哪些卡上把黑边变白边
  4) 增删：post 比 pre 多/少的卡片（定位修复②多卡补检的副作用）
输出 .tmp/regress/compare.json 并打印摘要。
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PRE = ROOT / ".tmp" / "regress" / "pre"
POST = ROOT / ".tmp" / "regress" / "post-final"
OUT = ROOT / ".tmp" / "regress" / "compare.json"

DIRS = ["身份证正面", "身份证反面"]
MODES = ["model", "cv"]
TARGET_ASPECT = 85.6 / 54.0


def load_report(side: Path) -> dict:
    p = side / "report.json"
    if not p.exists():
        raise SystemExit(f"[FAIL] 缺报告：{p}")
    return json.loads(p.read_text(encoding="utf-8"))


def crop_path(side: Path, mode: str, dtag: str, name: str) -> Path | None:
    d = side / f"{mode}__{dtag}"
    if not d.exists():
        return None
    # 文件名形如 <idx>_<safe(name)>.png
    safe = "".join(c if c.isalnum() or c in "._-()" else "_" for c in name)[:120]
    cand = [f for f in d.glob("*.png") if safe in f.name]
    return cand[0] if cand else None


def border_mean(img: np.ndarray) -> tuple[float, float, float]:
    h, w = img.shape[:2]
    ring = np.concatenate([
        img[0:3, :, :].reshape(-1, 3),
        img[-3:, :, :].reshape(-1, 3),
        img[:, 0:3, :].reshape(-1, 3),
        img[:, -3:, :].reshape(-1, 3),
    ], axis=0).astype(float)
    return tuple(float(ring[:, i].mean()) for i in range(3))


def pixel_diff(pre_p: Path, post_p: Path) -> dict:
    a = np.asarray(Image.open(pre_p).convert("RGB"), dtype=np.float32)
    b = np.asarray(Image.open(post_p).convert("RGB"), dtype=np.float32)
    if a.shape != b.shape:
        b = np.asarray(Image.open(post_p).convert("RGB").resize((a.shape[1], a.shape[0]), Image.BILINEAR), dtype=np.float32)
    diff = np.abs(a - b)
    changed = (diff.sum(axis=2) > 24).sum()
    total = a.shape[0] * a.shape[1]
    mean_diff = float(diff.mean())
    # 边框区域（最外 3px）
    bp, bpo = border_mean(a), border_mean(b)
    return {
        "size": [a.shape[1], a.shape[0]],
        "changedFrac": round(changed / total, 4),
        "meanDiff": round(mean_diff, 2),
        "borderPre": [round(x, 1) for x in bp],
        "borderPost": [round(x, 1) for x in bpo],
        "borderBlackToWhite": (sum(bp) / 3 < 40 and sum(bpo) / 3 > 200),
    }


def main() -> int:
    pre_r = load_report(PRE)
    post_r = load_report(POST)
    result: dict = {"modes": {}}

    for m in MODES:
        result["modes"][m] = {"dirs": {}}
        for dtag in DIRS:
            pre_items = {it["name"]: it for it in pre_r["dirs"][m][dtag]["items"]}
            post_items = post_r["dirs"][m][dtag]["items"]
            post_by_name: dict[str, list[dict]] = {}
            for it in post_items:
                post_by_name.setdefault(it["name"], []).append(it)

            pre_sum = pre_r["dirs"][m][dtag]["summary"]
            post_sum = post_r["dirs"][m][dtag]["summary"]

            metrics = {
                "items": {"pre": pre_sum["items"], "post": post_sum["items"], "delta": post_sum["items"] - pre_sum["items"]},
                "badges": {"pre": pre_sum["badges"], "post": post_sum["badges"]},
                "avgConf": {"pre": pre_sum["avgConf"], "post": post_sum["avgConf"]},
                "aspectMedianDev": {"pre": pre_sum["aspectMedianDev"], "post": post_sum["aspectMedianDev"]},
                "aspectWorst": {"pre": pre_sum["aspectWorst"], "post": post_sum["aspectWorst"]},
            }

            # 像素 diff：对每张 pre 卡，在同名 post 卡里挑最像的
            pixel_changes = []
            added = []
            removed = []
            pre_names = set(pre_items.keys())
            post_names = set(post_by_name.keys())
            for name in pre_names - post_names:
                removed.append(name)
            for name in post_names - pre_names:
                added.append(name)

            for name, pit in pre_items.items():
                posts = post_by_name.get(name)
                if not posts:
                    continue
                pp = crop_path(PRE, m, dtag, name)
                if not pp:
                    continue
                best = None
                for qit in posts:
                    qp = crop_path(POST, m, dtag, name)
                    if not qp:
                        continue
                    d = pixel_diff(pp, qp)
                    if best is None or d["meanDiff"] < best["meanDiff"]:
                        best = d
                if best and best["changedFrac"] > 0.001:
                    pixel_changes.append({"name": name, **best})

            # 增删卡里若同名多张，标记
            added_dup = [n for n in added if n in pre_names]  # 不应有
            result["modes"][m]["dirs"][dtag] = {
                "metrics": metrics,
                "pixelChangedCards": sorted(pixel_changes, key=lambda x: -x["changedFrac"]),
                "addedCards": sorted(added),
                "removedCards": sorted(removed),
                "nPixelChanged": len(pixel_changes),
                "nAdded": len(added),
                "nRemoved": len(removed),
                "blackToWhiteCards": sorted([c["name"] for c in pixel_changes if c["borderBlackToWhite"]]),
            }

    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    # 打印摘要
    print("=== 前后版本回归对比（100 张正反面）===")
    for m in MODES:
        for dtag in DIRS:
            d = result["modes"][m]["dirs"][dtag]
            mt = d["metrics"]
            print(f"\n[{m}] {dtag}")
            print(f"  卡片数   pre={mt['items']['pre']} post={mt['items']['post']} (Δ={mt['items']['delta']})")
            print(f"  徽标pre  {mt['badges']['pre']}")
            print(f"  徽标post {mt['badges']['post']}")
            print(f"  平均置信 pre={mt['avgConf']['pre']} post={mt['avgConf']['post']}")
            print(f"  长宽比中位偏差 pre={mt['aspectMedianDev']['pre']} post={mt['aspectMedianDev']['post']}")
            print(f"  长宽比最差偏差 pre={mt['aspectWorst']['pre']} post={mt['aspectWorst']['post']}")
            print(f"  像素变化卡={d['nPixelChanged']}  黑边→白边卡={len(d['blackToWhiteCards'])}  新增卡={d['nAdded']}  消失卡={d['nRemoved']}")
            if d["addedCards"]:
                print(f"    新增(可能为补检): {d['addedCards'][:10]}")
    print(f"\ncompare.json: {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
