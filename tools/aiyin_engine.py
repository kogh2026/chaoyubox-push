# -*- coding: utf-8 -*-
"""以爱印「卡证矫正 FP32」ONNX 模型在原生 onnxruntime 上跑 100 张图像，独立给出
爱印方案的处理效率(推理耗时)、稳定性(失败率)与检测覆盖(每张卡数, maxPages=2)。

本脚本是 src/lib/cardCorrectMl.ts 的 Python 等价移植（同一模型、同一常量、同一循环），
用于：
  - 给爱印方案的"原生推理耗时/失败率"一个真实数字（app 里是 wasm，偏高）；
  - 验证我们对爱印引擎的 1:1 移植与爱印真值一致（检测张数/置信应吻合）；
  - 提供与自研(post-fix)方案对比的基准列。

注意：只做"检测+计数+计时"，不重采样出校正图（校正图由 app bench 落盘，二者共用同一引擎）。
用法：
  python tools/aiyin_engine.py --dir "D:/50/身份证正面" --dir "D:/50/身份证反面" --out .tmp/aiyin/engine.json
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / "resources" / "card-model" / "card-correction-fp32.onnx"
TARGET_ASPECT = 85.6 / 54.0

# ---- 常量（照抄 cardCorrectMl.ts / 爱印）----
MODEL_INPUT = 768
GRID = 192
TH_FIRST = 0.3
TH_KNOWN = 0.1
TH_LOOP = 0.03
OVERLAP_FRAC = 0.25
AREA_RATIO = 0.5
MEAN = np.array([0.408, 0.447, 0.47], dtype=np.float32)
STD = np.array([0.289, 0.274, 0.278], dtype=np.float32)
ROOM_MIN = 0.3
MAX_PAGES = 2
MIN_AREA_FRAC = 0.04


def preprocess(img: np.ndarray, w: int, h: int) -> np.ndarray:
    center_x, center_y = w / 2.0, h / 2.0
    scale = max(w, h)
    S = MODEL_INPUT
    out = np.empty((1, 3, S, S), dtype=np.float32)
    l = S / scale
    u = S / 2
    xs = (np.arange(S) - u) / l + center_x
    ys = (np.arange(S) - u) / l + center_y
    # 双线性采样
    Mx = np.floor(xs).astype(int); My = np.floor(ys).astype(int)
    bx = (xs - Mx); by = (ys - My)
    inb = (Mx >= 0) & (My >= 0) & (Mx < w - 1) & (My < h - 1)
    Mx = np.clip(Mx, 0, w - 1); My = np.clip(My, 0, h - 1)
    for p in range(3):
        ch = img[:, :, 2 - p].astype(np.float32)  # RGBA->BGR
        top = ch[My, Mx] * (1 - bx)[None, :] + ch[My, np.clip(Mx + 1, 0, w - 1)] * bx[None, :]
        bot = ch[np.clip(My + 1, 0, h - 1), Mx] * (1 - bx)[None, :] + ch[np.clip(My + 1, 0, h - 1), np.clip(Mx + 1, 0, w - 1)] * bx[None, :]
        val = (top * (1 - by)[:, None] + bot * by[:, None]) / 255.0
        val = (val - MEAN[p]) / STD[p]
        val[~inb] = -MEAN[p] / STD[p]
        out[0, p] = val
    return out


def point_in_quad(coords8, cx, cy) -> bool:
    pos = neg = 0
    for s in range(4):
        ix, iy = coords8[s * 2], coords8[s * 2 + 1]
        lx, ly = coords8[(s * 2 + 2) % 8], coords8[(s * 2 + 3) % 8]
        c = (lx - ix) * (cy - iy) - (ly - iy) * (cx - ix)
        if c > 0: pos += 1
        elif c < 0: neg += 1
    return pos == 4 or neg == 4


def dedup_contained(cands, n=TH_FIRST):
    if len(cands) < 2:
        return cands
    out = []
    for o in range(len(cands)):
        if cands[o].score < n:
            break
        a = cands[o].coords
        ccx = (a[0] + a[2] + a[4] + a[6]) / 4
        ccy = (a[1] + a[3] + a[5] + a[7]) / 4
        contained = False
        for l in range(len(cands)):
            if o == l or cands[l].score < n:
                continue
            if point_in_quad(cands[l].coords, ccx, ccy) and cands[o].score < cands[l].score:
                contained = True
                break
        if not contained:
            out.append(cands[o])
    # 保持降序
    return out


def poly_area(pts):
    n = 0
    for e in range(4):
        o = pts[e]; a = pts[(e + 1) % 4]
        n += o[0] * a[1] - a[0] * o[1]
    return abs(n) / 2


def clip_poly_by_quad_area(poly, quad) -> float:
    # Sutherland–Hodgman：以 quad 为裁剪框，裁剪 poly，返回交集面积（1:1 移植 cardCorrectMl）。
    o = [tuple(p) for p in poly]
    for a in range(4):
        s = tuple(quad[a]); i = tuple(quad[(a + 1) % 4])
        # 边 s->i 的有向法向：r(u)=sign*((i-s)×(u-s))
        def r(u):
            return (i[0] - s[0]) * (u[1] - s[1]) - (i[1] - s[1]) * (u[0] - s[0])
        l = o
        o = []
        for u in range(len(l)):
            c = l[u]; h = l[(u + len(l) - 1) % len(l)]
            fc = r(c); fh = r(h)
            if fc >= 0:
                if fh < 0:
                    o.append(line_intersect(h, c, s, i))
                o.append(c)
            elif fh >= 0:
                o.append(line_intersect(h, c, s, i))
    return poly_area(o) if len(o) >= 3 else 0.0


def line_intersect(p1, p2, p3, p4):
    a = p2[0] - p1[0]; b = p2[1] - p1[1]
    c = p4[0] - p3[0]; d = p4[1] - p3[1]
    den = a * d - b * c
    if abs(den) < 1e-9:
        return p1
    u = ((p3[0] - p1[0]) * d - (p3[1] - p1[1]) * c) / den
    return (p1[0] + a * u, p1[1] + b * u)


def decode(out, w, h, th):
    scores = out["scores"].reshape(-1)
    quads = out["quads"].reshape(-1, 8)
    angles = out["angle"].reshape(-1)
    cands = []
    for r in range(len(scores)):
        cands.append(type("C", (), {"coords": quads[r].tolist(), "score": float(scores[r]), "angle": float(angles[r])})())
    s = GRID / max(w, h)
    i = GRID / 2
    res = []
    for c in dedup_contained(cands, th):
        if c.score <= th:
            continue
        corners = [((c.coords[k * 2] - i) / s + w / 2, (c.coords[k * 2 + 1] - i) / s + h / 2) for k in range(4)]
        u = int(((c.angle % 4) + 4) % 4)
        res.append({"corners": corners, "score": c.score, "angle": u})
    return res


def accept_next(decoded, accepted, frame_area):
    first_area = poly_area(accepted[0]) if accepted else 0
    for a in decoded:
        ar = poly_area(a["corners"])
        if ar / max(1, frame_area) < MIN_AREA_FRAC:
            continue
        if any(clip_poly_by_quad_area(a["corners"], acc) / ar >= OVERLAP_FRAC for acc in accepted):
            continue
        if accepted:
            if a["score"] > TH_KNOWN:
                return a
            if a["score"] > TH_LOOP and ar >= AREA_RATIO * first_area:
                return a
        else:
            if a["score"] > TH_FIRST:
                return a
    return None


def edge_room(corners, w, h):
    cx = sum(p[0] for p in corners) / 4
    cy = sum(p[1] for p in corners) / 4
    best = 0.0
    for s in range(4):
        i0, i1 = corners[s], corners[(s + 1) % 4]
        length = np.hypot(i1[0] - i0[0], i1[1] - i0[1])
        if length < 1:
            continue
        nx, ny = (i1[1] - i0[1]) / length, -(i1[0] - i0[0]) / length
        mx, my = (i0[0] + i1[0]) / 2, (i0[1] + i1[1]) / 2
        if nx * (mx - cx) + ny * (my - cy) < 0:
            nx, ny = -nx, -ny
        opp = (corners[(s + 2) % 4], corners[(s + 3) % 4])
        d = (abs((opp[0][1] - i0[1]) * (cx - i0[0]) - (opp[0][0] - i0[0]) * (cy - i0[1])) / length +
             abs((opp[1][1] - i0[1]) * (cx - i0[0]) - (opp[1][0] - i0[0]) * (cy - i0[1])) / length) / 2
        if d < 1:
            continue
        for m in (0.0, 0.5, 1.0):
            x = np.clip(i0[0] + m * (i1[0] - i0[0]), 0, w)
            y = np.clip(i0[1] + m * (i1[1] - i0[1]), 0, h)
            bx = (w - x) / nx if nx > 1e-9 else (x / -nx if nx < -1e-9 else 1e9)
            by = (h - y) / ny if ny > 1e-9 else (y / -ny if ny < -1e-9 else 1e9)
            best = max(best, min(bx, by) / d)
    return best


def whiten(working, corners):
    ys = [p[1] for p in corners]
    s = max(0, int(min(ys))); i = min(working.shape[0] - 1, int(np.ceil(max(ys))))
    for r in range(s, i + 1):
        l = r + 0.5
        xs = []
        for c in range(4):
            h = corners[c]; f = corners[(c + 1) % 4]
            if h[1] == f[1]:
                continue
            d = min(h[1], f[1]); mm = max(h[1], f[1])
            if l < d or l >= mm:
                continue
            x = h[0] + (l - h[1]) / (f[1] - h[1]) * (f[0] - h[0])
            xs.append(x)
        if len(xs) < 2:
            continue
        xs.sort()
        for c in range(0, len(xs) - 1, 2):
            aa = max(0, int(round(xs[c]))); bb = min(working.shape[1] - 1, int(round(xs[c + 1])))
            working[r, aa:bb + 1, :] = 255


def run_image(sess, img: np.ndarray, in_name: str) -> dict:
    h, w = img.shape[:2]
    t0 = time.perf_counter()
    out0 = sess.run(["scores", "quads", "angle", "ftype"], {in_name: preprocess(img, w, h)})
    dt_ms = (time.perf_counter() - t0) * 1000.0
    working = img.copy()
    frame_area = max(1, w * h)
    accepted = []
    pages = []
    room = None
    for x in range(MAX_PAGES):
        if x == 0:
            outd = {"scores": out0[0], "quads": out0[1], "angle": out0[2], "ftype": out0[3]}
        else:
            o = sess.run(["scores", "quads", "angle", "ftype"], {in_name: preprocess(working, w, h)})
            outd = {"scores": o[0], "quads": o[1], "angle": o[2], "ftype": o[3]}
        th = TH_FIRST if x == 0 else TH_LOOP
        decoded = decode(outd, w, h, th)
        nxt = accept_next(decoded, accepted, frame_area)
        if not nxt:
            break
        pages.append({"score": nxt["score"], "angle": nxt["angle"]})
        accepted.append(nxt["corners"])
        if len(pages) == 1:
            room = edge_room(nxt["corners"], w, h)
            if room < ROOM_MIN:
                break
        whiten(working, nxt["corners"])
    return {"nCards": len(pages), "scores": [round(p["score"], 3) for p in pages], "room": round(room, 3) if room is not None else None, "timeMs": round(dt_ms, 1)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", action="append", default=None)
    ap.add_argument("--n", type=int, default=9999)
    ap.add_argument("--out", type=str, default=str(ROOT / ".tmp" / "aiyin" / "engine.json"))
    args = ap.parse_args()
    dirs = [Path(d) for d in args.dir] if args.dir else [Path(r"D:\50\身份证正面"), Path(r"D:\50\身份证反面")]
    so = ort.SessionOptions()
    so.intra_op_num_threads = 4
    sess = ort.InferenceSession(str(MODEL), so, providers=["CPUExecutionProvider"])
    # 探测输入名
    in_name = sess.get_inputs()[0].name

    results = []
    total_cards = 0
    times = []
    fails = 0
    for d in dirs:
        for p in sorted([f for f in d.iterdir() if f.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".bmp"}])[: args.n]:
            try:
                arr = np.asarray(Image.open(p).convert("RGBA"), dtype=np.uint8)
                r = run_image(sess, arr, in_name)
                r["file"] = str(p)
                r["dir"] = d.name
                results.append(r)
                total_cards += r["nCards"]
                times.append(r["timeMs"])
            except Exception as e:  # noqa: BLE001
                fails += 1
                results.append({"file": str(p), "dir": d.name, "error": str(e)[:120]})
    times = [t for t in times if t]
    agg = {
        "nImages": len(results),
        "totalCards": total_cards,
        "fails": fails,
        "avgTimeMs": round(sum(times) / len(times), 1) if times else None,
        "p95TimeMs": round(sorted(times)[int(len(times) * 0.95)], 1) if times else None,
        "maxTimeMs": round(max(times), 1) if times else None,
    }
    out = {"agg": agg, "results": results}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(agg, ensure_ascii=False, indent=2))
    print("AIYIN_ENGINE_OK" if fails == 0 else f"AIYIN_ENGINE_FAIL fails={fails}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
