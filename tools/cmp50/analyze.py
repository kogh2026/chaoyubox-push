# -*- coding: utf-8 -*-
"""对成批证件照输出做统一质量度量。用法：python analyze.py <目录> [--json out.json]"""
import glob, json, os, sys
import numpy as np
from PIL import Image

def analyze_dir(d):
    ps = sorted(glob.glob(os.path.join(d, "**", "*.jpg"), recursive=True))
    if not ps:
        return {"dir": d, "n": 0}
    sizes, kb, red_ratio, top_std, sharp, w,h = {}, [], [], [], [], None, None
    for p in ps:
        im = Image.open(p).convert("RGB")
        sizes[str(im.size)] = sizes.get(str(im.size), 0) + 1
        kb.append(round(os.path.getsize(p) / 1024, 1))
        a = np.asarray(im, dtype=np.uint8)
        H, W, _ = a.shape
        # 背景纯度：接近 #FF0000 的像素占比（R>180, G<70, B<70）
        red = ((a[:, :, 0] > 180) & (a[:, :, 1] < 70) & (a[:, :, 2] < 70)).mean()
        red_ratio.append(float(red))
        # 上部左右角背景带（避开居中人脸/衣服）：y 0..8%，x 两侧 0..20% 与 80..100%
        band = np.concatenate([a[: int(H*0.08), : int(W*0.2)].reshape(-1, 3),
                               a[: int(H*0.08), int(W*0.8):].reshape(-1, 3)])
        top_std.append([round(float(x), 1) for x in band.std(0)])
        # 清晰度
        g = np.asarray(im.convert("L").resize((128, 180)))
        lap = np.abs(4*g[1:-1,1:-1] - g[:-2,1:-1] - g[2:,1:-1] - g[1:-1,:-2] - g[1:-1,2:])
        sharp.append(round(float(lap.mean()), 2))
    kb_arr, rr = np.array(kb), np.array(red_ratio)
    ts, sh = np.array(top_std), np.array(sharp)
    return {
        "dir": d, "n": len(ps), "sizes": sizes,
        "kb_avg": round(float(kb_arr.mean()), 1), "kb_min": float(kb_arr.min()), "kb_max": float(kb_arr.max()),
        "red_bg_ratio_avg": round(float(rr.mean()), 4), "red_bg_ratio_min": round(float(rr.min()), 4),
        "top_band_std_avg": ts.mean(0).round(1).tolist(), "top_band_std_max_R": round(float(ts[:,0].max()), 1),
        "sharp_min_med_max": [float(sh.min()), float(sorted(sh)[len(sh)//2]), float(sh.max())],
        "files": [os.path.basename(p) for p in ps],
    }

if __name__ == "__main__":
    out = {}
    for d in sys.argv[1:]:
        if d == "--json":
            continue
    dirs = [a for a in sys.argv[1:] if not a.startswith("--")]
    ji = sys.argv.index("--json") + 1 if "--json" in sys.argv else None
    for d in dirs:
        r = analyze_dir(d)
        out[d] = r
        print(json.dumps(r, ensure_ascii=False, indent=1))
    if ji:
        with open(ji, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
