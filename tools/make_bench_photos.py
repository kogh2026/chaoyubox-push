# -*- coding: utf-8 -*-
"""生成批量性能测试照片：50 张「手机原图级」一寸照源片（3024×4032，约 12MP）。

用真实人像 0002-01.jpg 放大 + 轻微裁剪/亮度偏移，保证 50 张内容各异但统计特征一致，
避免缓存去重干扰计时（每张是独立 File，抠图 WeakMap 不会命中）。
"""
import os
import sys
from PIL import Image, ImageEnhance

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "..", "compare", "imgs", "0002-01.jpg")
OUT = os.path.join(ROOT, ".tmp", "bench50")
W, H = 3024, 4032


def main(n=50):
    os.makedirs(OUT, exist_ok=True)
    base = Image.open(SRC).convert("RGB")
    # 先把短边放大到 3024 的 1.25 倍，便于后续按不同偏移裁切
    scale = (W * 1.25) / base.width
    big = base.resize((int(base.width * scale), int(base.height * scale)), Image.LANCZOS)
    paths = []
    for i in range(n):
        dx = (i % 5) * 40
        dy = (i % 7) * 30
        left = min(max(0, dx), big.width - W)
        top = min(max(0, dy), big.height - H)
        crop = big.crop((left, top, left + W, top + H))
        crop = ImageEnhance.Brightness(crop).enhance(0.94 + (i % 9) * 0.015)
        p = os.path.join(OUT, "batch_%02d.jpg" % (i + 1))
        crop.save(p, "JPEG", quality=88, optimize=False)
        paths.append(p)
    print("generated %d files in %s" % (len(paths), OUT))
    print("sample size: %.2f MB" % (os.path.getsize(paths[0]) / 1024 / 1024))
    return paths


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 50)
