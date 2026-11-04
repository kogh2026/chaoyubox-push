#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对 174 张素材跑「MODNet 抠图 + 边缘精修」，输出逐张「精修前后发色偏移」量化表。

完全移植 aiyinbox-clone 的真实链路：
  - 预处理：src/lib/matting.worker.ts 的 modnetSize + (x/255*2-1) 归一化 + NCHW[1,3,h,w]
  - 边缘精修：src/lib/edgeRefine.ts 的 estimateBackgroundFromAlpha + refineEdgePixels
    （默认 strength=0.8, kappa=0.35, smooth=True，逐行对齐 TS 实现）
在本机用 onnxruntime(CPU) 离线跑，确保可量化、可追溯。
"""
from __future__ import annotations

import argparse
import csv
import statistics
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

MODEL = Path(r"D:/Downloads/2026-10-23-08-38-11/aiyinbox-clone/resources/matting-model/modnet/modnet.onnx")
DARK_DIR = Path(r"D:/50/学员寸照_头发样本/dark_hair")
WHITE_DIR = Path(r"D:/50/学员寸照_头发样本/white_gray_user")
OUT_CSV = Path(r"D:/50/edge_refine_validation.csv")

STRENGTH = 0.8
KAPPA = 0.35
SMOOTH = True


# ───────────────────────── MODNet 推理（对齐 matting.worker.ts） ─────────────────────────
def modnet_size(iw: int, ih: int):
    scale = 512 / min(iw, ih)
    w = max(32, round(iw * scale))
    h = max(32, round(ih * scale))
    w = w - (w % 32) or 32
    h = h - (h % 32) or 32
    return w, h


def run_modnet(sess, rgb: np.ndarray):
    """rgb: uint8 HxWx3。返回 aFull: float HxW (0..1) 原始分辨率 alpha 蒙版。"""
    ih, iw = rgb.shape[:2]
    w, h = modnet_size(iw, ih)
    img = Image.fromarray(rgb).resize((w, h), Image.LANCZOS)
    px = w * h
    arr = np.asarray(img, dtype=np.float32).reshape(-1, 3)
    data = np.empty(3 * px, dtype=np.float32)
    data[0:px] = arr[:, 0] / 255 * 2 - 1
    data[px:2 * px] = arr[:, 1] / 255 * 2 - 1
    data[2 * px:3 * px] = arr[:, 2] / 255 * 2 - 1
    feeds = {"input": data.reshape(1, 3, h, w).astype(np.float32)}
    out = sess.run(["output"], feeds)[0].reshape(h, w)  # 已 sigmoid 0..1
    # 上采样回原尺寸（对齐 TS 的 floor 映射）
    scale_x, scale_y = iw / w, ih / h
    ys = np.minimum(h - 1, (np.arange(ih) / scale_y).astype(np.int64))
    xs = np.minimum(w - 1, (np.arange(iw) / scale_x).astype(np.int64))
    a_full = out[np.ix_(ys, xs)]
    return a_full.astype(np.float32)


# ───────────────────────── 边缘精修（对齐 edgeRefine.ts） ─────────────────────────
def estimate_background_from_alpha(rgb: np.ndarray, alpha: np.ndarray):
    n = alpha.size
    step = max(1, n // 60000)
    rs, gs, bs = [], [], []
    for p in range(0, n, step):
        if alpha.flat[p] > 0.004:
            continue
        rs.append(int(rgb.reshape(-1, 3)[p, 0]))
        gs.append(int(rgb.reshape(-1, 3)[p, 1]))
        bs.append(int(rgb.reshape(-1, 3)[p, 2]))
    if len(rs) < 200:
        return None
    return (int(np.median(rs)), int(np.median(gs)), int(np.median(bs)))


def refine_edge_pixels(rgb: np.ndarray, alpha: np.ndarray):
    """rgb: uint8 HxWx3（原地修改 RGB）；alpha: float HxW。返回 (after_rgb, bg)。"""
    h, w = alpha.shape
    n = h * w
    a_flat = alpha.reshape(-1)
    br, bg2, bb = None, None, None
    # 估底色
    est = estimate_background_from_alpha(rgb, alpha)
    if est is None:
        return rgb.copy(), None
    br, bg2, bb = est
    # 边缘像素
    idx = np.where((a_flat > 0.004) & (a_flat < 0.996))[0]
    if idx.size == 0:
        return rgb.copy(), (br, bg2, bb)
    a_idx = a_flat[idx]
    r = rgb.reshape(-1, 3)[:, 0].astype(np.float32)
    g = rgb.reshape(-1, 3)[:, 1].astype(np.float32)
    b = rgb.reshape(-1, 3)[:, 2].astype(np.float32)
    inv = 1.0 / np.maximum(a_idx, 1e-3)
    fr = (r[idx] - (1 - a_idx) * br) * inv
    fg = (g[idx] - (1 - a_idx) * bg2) * inv
    fb = (b[idx] - (1 - a_idx) * bb) * inv
    limR = np.maximum(24, np.abs(r[idx] - br) * 2.5)
    limG = np.maximum(24, np.abs(g[idx] - bg2) * 2.5)
    limB = np.maximum(24, np.abs(b[idx] - bb) * 2.5)
    fr = np.clip(fr, r[idx] - limR, r[idx] + limR)
    fg = np.clip(fg, g[idx] - limG, g[idx] + limG)
    fb = np.clip(fb, b[idx] - limB, b[idx] + limB)
    dR = np.zeros(n, dtype=np.float32); dG = np.zeros(n, dtype=np.float32); dB = np.zeros(n, dtype=np.float32)
    dR[idx] = fr - r[idx]; dG[idx] = fg - g[idx]; dB[idx] = fb - b[idx]
    src = [dR, dG, dB]
    out = [dR.copy(), dG.copy(), dB.copy()]
    if SMOOTH:
        in_edge = np.zeros(n, dtype=np.uint8); in_edge[idx] = 1
        for ch in range(3):
            s = src[ch]
            for p in idx:
                x = p % w; y = p // w
                acc = 0.0; cnt = 0
                for dy in (-1, 0, 1):
                    ny = y + dy
                    if ny < 0 or ny >= h:
                        continue
                    for dx in (-1, 0, 1):
                        nx = x + dx
                        if nx < 0 or nx >= w:
                            continue
                        q = ny * w + nx
                        if in_edge[q]:
                            acc += s[q]; cnt += 1
                if cnt > 0:
                    out[ch][p] = acc / cnt
    pw = 1 / max(0.05, KAPPA)
    after = rgb.reshape(-1, 3).astype(np.float32).copy()
    for k, p in enumerate(idx):
        a = a_idx[k]
        w_base = 1 - (1 - a) ** pw
        wt = min(1.0, max(0.35, STRENGTH * w_base))
        after[p, 0] = min(255, max(0, after[p, 0] + out[0][p] * wt))
        after[p, 1] = min(255, max(0, after[p, 1] + out[1][p] * wt))
        after[p, 2] = min(255, max(0, after[p, 2] + out[2][p] * wt))
    return after.reshape(h, w, 3).astype(np.uint8), (br, bg2, bb)


# ───────────────────────── 量化指标 ─────────────────────────
def lum(r, g, b):
    return 0.299 * r + 0.587 * g + 0.114 * b


def region_metrics(before_rgb, after_rgb, alpha, region_mask, bg):
    edge = (alpha > 0.004) & (alpha < 0.996) & region_mask
    if edge.sum() < 200:
        return None
    b = before_rgb[edge].astype(np.float32)
    a = after_rgb[edge].astype(np.float32)
    bm = b.mean(axis=0); am = a.mean(axis=0)
    Lb = lum(*bm); La = lum(*am)
    chb = bm.max() - bm.min(); cha = am.max() - am.min()
    # 染色：after-before 是否朝向底色方向移动
    d = am - bm
    g = np.array(bg) - bm if (bg is not None) else np.zeros(3)
    nd = np.linalg.norm(d); ng = np.linalg.norm(g)
    tint = float(np.dot(d, g) / (nd * ng + 1e-6)) if nd > 0 and ng > 0 else 0.0
    max_ch_delta = float(np.abs(am - bm).max())
    # 细节：亮度梯度（高频代理）精修前后比值
    Lb_img = lum(*before_rgb.transpose(2, 0, 1)); La_img = lum(*after_rgb.transpose(2, 0, 1))
    gy_b, gx_b = np.gradient(Lb_img); gy_a, gx_a = np.gradient(La_img)
    hf_b = float(np.mean(np.sqrt(gx_b[edge] ** 2 + gy_b[edge] ** 2)))
    hf_a = float(np.mean(np.sqrt(gx_a[edge] ** 2 + gy_a[edge] ** 2)))
    detail_ratio = hf_a / hf_b if hf_b > 1e-6 else 1.0
    return dict(n=int(edge.sum()), bR=bm[0], bG=bm[1], bB=bm[2], aR=am[0], aG=am[1], aB=am[2],
                Lb=Lb, La=La, dL=La - Lb, chb=chb, cha=cha, dChroma=cha - chb,
                maxChDelta=max_ch_delta, tint=tint, detail_ratio=detail_ratio)


def conclude_dark(m):
    """深色头发判定：边缘精修的正确效果是「去除底色晕染 → 发色变暗、不再带底色色调」。
    真正的风险信号是 Δ亮度显著为正（解混把头发推亮/推向底色 = 推灰/推亮）。
    注意：色度下降在饱和底色(红/蓝)上是正常现象(去掉了底色染色)，不作缺陷判定。"""
    if m is None:
        return "样本不足(边缘像素<200)"
    if m["dL"] > 8:
        return "⚠️ 发色变亮(推灰风险)"
    if m["dL"] > 0:
        return "轻微变亮(观察)"
    return "正常(发色加深/稳定)"


def conclude_white(m):
    if m is None:
        return "样本不足(边缘像素<200)"
    flags = []
    if m["tint"] > 0.6 and m["maxChDelta"] > 8:
        flags.append("染背景色")
    if m["detail_ratio"] < 0.8:
        flags.append("细节受损")
    if not flags:
        return "正常(发色提亮/稳定)"
    return "⚠️ " + "+".join(flags)


def process(sess, paths, category, writer, summary):
    for p in paths:
        try:
            rgb = np.asarray(Image.open(p).convert("RGB"), dtype=np.uint8)
        except Exception as e:
            writer.writerow([p.name, category, "ERROR", str(e)])
            continue
        ih, iw = rgb.shape[:2]
        alpha = run_modnet(sess, rgb)
        after, bg = refine_edge_pixels(rgb, alpha)
        bg = bg or (0, 0, 0)
        # 上半部发色区
        upper = np.zeros((ih, iw), dtype=bool); upper[: ih // 2, :] = True
        m_hair = region_metrics(rgb, after, alpha, upper, bg)
        m_full = region_metrics(rgb, after, alpha, np.ones((ih, iw), dtype=bool), bg)
        row = [p.name, category, bg[0], bg[1], bg[2],
               (m_full["n"] if m_full else 0), (m_hair["n"] if m_hair else 0)]
        if m_hair:
            row += [f'{m_hair["bR"]:.1f}', f'{m_hair["bG"]:.1f}', f'{m_hair["bB"]:.1f}',
                    f'{m_hair["Lb"]:.1f}', f'{m_hair["chb"]:.1f}',
                    f'{m_hair["aR"]:.1f}', f'{m_hair["aG"]:.1f}', f'{m_hair["aB"]:.1f}',
                    f'{m_hair["La"]:.1f}', f'{m_hair["cha"]:.1f}',
                    f'{m_hair["dL"]:+.1f}', f'{m_hair["dChroma"]:+.1f}',
                    f'{m_hair["maxChDelta"]:.1f}', f'{m_hair["tint"]:.2f}',
                    f'{m_hair["detail_ratio"]:.2f}',
                    conclude_dark(m_hair) if category == "dark" else conclude_white(m_hair)]
        else:
            row += [""] * 16
        if m_full:
            row += [f'{m_full["dL"]:+.1f}', f'{m_full["dChroma"]:+.1f}',
                    conclude_dark(m_full) if category == "dark" else conclude_white(m_full)]
        else:
            row += ["", "", ""]
        writer.writerow(row)
        # 汇总
        key = category + ("_hair" if m_hair else "_na")
        summary[key]["n"] += 1
        if m_hair and ("⚠️" in (conclude_dark(m_hair) if category == "dark" else conclude_white(m_hair))):
            summary[key]["warn"] += 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="每类只处理前 N 张（冒烟测试）")
    args = ap.parse_args()
    sess = ort.InferenceSession(str(MODEL), ort.SessionOptions(), providers=["CPUExecutionProvider"])
    dark = sorted(p for p in DARK_DIR.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    white = sorted(p for p in WHITE_DIR.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    if args.limit:
        dark = dark[:args.limit]; white = white[:args.limit]
    header = ["图片编号", "类别", "底色R", "底色G", "底色B", "边缘像素_全图", "边缘像素_发色区",
              "精修前R", "精修前G", "精修前B", "精修前亮度L", "精修前色度",
              "精修后R", "精修后G", "精修后B", "精修后亮度L", "精修后色度",
              "Δ亮度", "Δ色度", "最大通道偏移", "染色分(tint)", "细节比(detail)", "发色区结论",
              "全图Δ亮度", "全图Δ色度", "全图结论"]
    summary = {k: {"n": 0, "warn": 0} for k in ("dark_hair", "dark_na", "white_hair", "white_na")}
    with open(OUT_CSV, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f); w.writerow(header)
        print(f"深色 {len(dark)} 张 / 白发 {len(white)} 张，开始处理 ...")
        process(sess, dark, "dark", w, summary)
        process(sess, white, "white", w, summary)
    print("已写出", OUT_CSV)
    print("汇总:", summary)


if __name__ == "__main__":
    main()
