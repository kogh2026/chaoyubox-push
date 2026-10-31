#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
基于 D:\50 的 51 张身份证正面样本，量化对比 超誉(chao) 与 爱印(aiyin) 在
"证件照/证卡拼版助手（增强模型）" 任务上的表现。

任务本质：输入整张身份证照片 -> 定位卡片内嵌的人像区域 -> 输出 295x413 标准证件照。

本脚本产出两类真实可量化指标：
  A. 输入样本难度分布（自动）：模糊(Laplacian方差) / 倾斜(边缘主方向) / 光照(亮度/对比)
  B. 输出构图质量（自动）：覆盖率、空白失败、横向居中偏移、前景占比、是否触边裁切

注意：遮挡(occlusion)难以在无 cv2/无检测模型下可靠自动判定，单独标注为低置信，
      由后续人工/视觉抽检补充。
"""
import os, json, math
import numpy as np
from PIL import Image

IN_DIR   = "D:/50/身份证正面"
CHAO_DIR = "D:/50/chao-out"
AIYIN_DIR= "D:/50/aiyin-out/爱印证件照-2026-10-28-182405-088/单张照片"
OUT_JSON = "D:/50/analysis_metrics.json"

def load_gray(path, size=None):
    im = Image.open(path).convert("L")
    if size: im = im.resize(size)
    return np.asarray(im, dtype=np.float64)

# ---------- 输入难度指标 ----------
def blur_score(img):
    # Laplacian 方差（越小越模糊）
    r = np.roll(img, 1, 0); l = np.roll(img, -1, 0)
    d = np.roll(img, 1, 1); u = np.roll(img, -1, 1)
    lap = r + l + d + u - 4 * img
    return float(np.var(lap))

def brightness_contrast(img):
    return float(np.mean(img)), float(np.std(img))

def tilt_score(img):
    # 梯度主方向偏离 0/90 的程度（度）。卡边多为水平/垂直，倾斜则主方向偏移。
    gx = np.roll(img, 1, 1) - np.roll(img, -1, 1)
    gy = np.roll(img, 1, 0) - np.roll(img, -1, 0)
    mag = np.sqrt(gx*gx + gy*gy)
    ang = (np.arctan2(gy, gx) * 180 / np.pi) % 180  # 0..180
    # 加权直方图（36 bin，每 5 度）
    H, _ = np.histogram(ang, bins=36, range=(0,180), weights=mag)
    peak = H.argmax() * 5 + 2.5
    # 偏离最近 90 的倍数
    k = round(peak / 90)
    near = k * 90 % 180
    dev = abs(((peak - near + 90) % 180) - 90)
    return float(dev)

# ---------- 输出构图指标 ----------
def output_metrics(path):
    try:
        im = Image.open(path).convert("RGB").resize((100, 140))
    except Exception:
        return {"blank": True}
    a = np.asarray(im, dtype=np.float64)
    # 量化到 4bit/通道，取众数作为背景色
    q = (a / 16).astype(np.int32)
    flat = q.reshape(-1, 3)
    # 用 np.unique 计数取众数
    uniq, counts = np.unique(flat, axis=0, return_counts=True)
    mode = uniq[counts.argmax()]
    mode_color = mode * 16.0 + 8.0
    dist = np.sqrt(((a - mode_color) ** 2).sum(axis=2))
    fg = dist > 40  # 前景掩码
    fg_ratio = float(fg.mean())
    if fg_ratio < 0.02:
        return {"blank": True, "fg_ratio": fg_ratio}
    ys, xs = np.where(fg)
    cx = xs.mean(); cy = ys.mean()
    cx_off = (cx - 50) / 50.0          # 横向居中偏移 [-1,1]
    cy_off = (cy - 70) / 70.0          # 纵向（0=顶,1=底）
    # 触边裁切：顶/底 8% 行内前景密度
    top_band = fg[:11, :].mean()
    bot_band = fg[129:, :].mean()
    return {
        "blank": False, "fg_ratio": fg_ratio,
        "cx_off": float(cx_off), "cy_off": float(cy_off),
        "top_band": float(top_band), "bot_band": float(bot_band),
    }

def main():
    files = sorted([f for f in os.listdir(IN_DIR) if f.lower().endswith(('.jpg','.png','.jpeg'))])
    rows = []
    for f in files:
        inp = os.path.join(IN_DIR, f)
        g = load_gray(inp)
        blur = blur_score(g)
        br, ct = brightness_contrast(g)
        tilt = tilt_score(g)
        chao_p = os.path.join(CHAO_DIR, f)
        aiyin_p = os.path.join(AIYIN_DIR, f)
        chao = output_metrics(chao_p) if os.path.exists(chao_p) else {"missing": True}
        aiyin = output_metrics(aiyin_p) if os.path.exists(aiyin_p) else {"missing": True}
        rows.append({"file": f, "blur": blur, "bright": br, "contrast": ct,
                     "tilt": tilt, "chao": chao, "aiyin": aiyin})
    # 难度分桶
    blurs = np.array([r["blur"] for r in rows])
    # 模糊阈值：取 25 分位为参考，低于则算模糊
    blur_thr = float(max(blurs.min(), np.percentile(blurs, 20)))
    tilt_thr = 6.0   # 偏离 >6 度算明显倾斜
    bright_lo, bright_hi = 70.0, 185.0
    contrast_lo = 35.0
    for r in rows:
        r["is_blur"]  = bool(r["blur"] < blur_thr)
        r["is_tilt"]  = bool(r["tilt"] > tilt_thr)
        r["is_dark"]  = bool(r["bright"] < bright_lo)
        r["is_bright"]= bool(r["bright"] > bright_hi)
        r["is_lowc"]  = bool(r["contrast"] < contrast_lo)
        r["is_light"] = bool(r["is_dark"] or r["is_bright"] or r["is_lowc"])
        # 复杂样本：至少命中模糊/倾斜/光照之一
        r["complex"]  = bool(r["is_blur"] or r["is_tilt"] or r["is_light"])
    # 汇总
    n = len(rows)
    def cnt(key): return sum(1 for r in rows if r[key])
    summary = {
        "n_samples": n,
        "blur_thr": float(blur_thr),
        "count_blur": cnt("is_blur"),
        "count_tilt": cnt("is_tilt"),
        "count_light": cnt("is_light"),
        "count_dark": cnt("is_dark"),
        "count_bright": cnt("is_bright"),
        "count_lowc": cnt("is_lowc"),
        "count_complex": cnt("complex"),
    }
    # 输出覆盖率与失败
    def out_stat(key):
        missing = sum(1 for r in rows if r[key].get("missing"))
        blank   = sum(1 for r in rows if r[key].get("blank"))
        ok = [r[key] for r in rows if "cx_off" in r[key]]
        avg_cx = float(np.mean([o["cx_off"] for o in ok])) if ok else None
        avg_cy = float(np.mean([o["cy_off"] for o in ok])) if ok else None
        avg_fg = float(np.mean([o["fg_ratio"] for o in ok])) if ok else None
        # 触边裁切（顶或底带密度 > 0.5 视为可能裁切）
        clip = sum(1 for o in ok if o["top_band"] > 0.5 or o["bot_band"] > 0.5)
        return {"missing": missing, "blank": blank, "ok": len(ok),
                "avg_cx_off": avg_cx, "avg_cy_off": avg_cy, "avg_fg_ratio": avg_fg,
                "clip_suspect": clip}
    summary["chao"] = out_stat("chao")
    summary["aiyin"] = out_stat("aiyin")
    # 复杂样本子集的输出质量
    def sub_stat(key, filt):
        ok = [r[key] for r in rows if filt(r) and "cx_off" in r[key]]
        if not ok: return None
        clip = sum(1 for o in ok if o["top_band"] > 0.5 or o["bot_band"] > 0.5)
        return {"n": len(ok), "clip_suspect": clip,
                "avg_cx_off": float(np.mean([o["cx_off"] for o in ok])),
                "avg_fg_ratio": float(np.mean([o["fg_ratio"] for o in ok]))}
    summary["chao_complex"] = sub_stat("chao", lambda r: r["complex"])
    summary["aiyin_complex"] = sub_stat("aiyin", lambda r: r["complex"])
    summary["chao_blur"] = sub_stat("chao", lambda r: r["is_blur"])
    summary["aiyin_blur"] = sub_stat("aiyin", lambda r: r["is_blur"])

    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump({"summary": summary, "rows": rows}, fh, ensure_ascii=False, indent=2)

    # 打印
    print("=== 样本难度分布 (n=%d) ===" % n)
    print("模糊(<%.1f): %d  倾斜(>%.1f°): %d  光照异常: %d (暗%d/过亮%d/低对比%d)  复杂合计: %d"
          % (blur_thr, summary["count_blur"], tilt_thr, summary["count_tilt"],
             summary["count_light"], summary["count_dark"], summary["count_bright"],
             summary["count_lowc"], summary["count_complex"]))
    print("\n=== 输出覆盖率与构图 ===")
    for k in ("chao","aiyin"):
        s = summary[k]
        print("%-6s 缺失%d 空白%d 有效%d | 居中偏移cx=%.3f cy=%.3f fg=%.3f | 触边裁切嫌疑%d"
              % (k, s["missing"], s["blank"], s["ok"], s["avg_cx_off"], s["avg_cy_off"],
                 s["avg_fg_ratio"], s["clip_suspect"]))
    print("\n=== 复杂样本子集输出 ===")
    for k in ("chao_complex","aiyin_complex","chao_blur","aiyin_blur"):
        s = summary.get(k)
        print(k, s if s else "n/a")
    print("\nJSON ->", OUT_JSON)

if __name__ == "__main__":
    main()
