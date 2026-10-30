#!/usr/bin/env python3
"""把 BlazeFace(MediaPipe face_detection_front) 的 tflite 转成桌面端可用的 ONNX + anchors.json。

产物（resources/face/，打包后位于安装目录 resources/res/face/）：
  face_detection_front.onnx   input[1,3,128,128] → regressors[1,896,16] / classificators[1,896]
  anchors.json                896×4，[cx, cy, w, h]；cx/cy 归一化，w/h 恒为 1
                              （MediaPipe SsdAnchorsCalculator 的 fixed_anchor_size 约定，
                                与 src/lib/faceDetect.ts 的 decodeFaces 解码公式一一对应）

依赖：pip install tflite2onnx onnx numpy
运行：python tools/build-face-model.py
"""
import io
import json
import os
import sys
import tarfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.path.join(ROOT, ".tmp", "bf")
SRC_DIR = os.path.join(TMP, "alifesoftware-blazeface-cd6528e")
OUT = os.path.join(ROOT, "resources", "face")
TARBALL = "https://api.github.com/repos/alifesoftware/blazeface/tarball/master"


def fetch_src():
    """github.com / raw.githubusercontent 在本机被代理拦掉，只有 api.github.com 通。"""
    if os.path.exists(os.path.join(SRC_DIR, "face_detection_front.tflite")) and os.path.exists(
        os.path.join(SRC_DIR, "anchors.npy")
    ):
        return
    os.makedirs(TMP, exist_ok=True)
    print("下载 blazeface 源仓库 ...")
    req = urllib.request.Request(TARBALL, headers={"User-Agent": "curl", "Accept": "application/vnd.github+json"})
    data = urllib.request.urlopen(req, timeout=180).read()
    with tarfile.open(fileobj=io.BytesIO(data)) as tf:
        for m in tf.getmembers():
            name = m.name.split("/", 1)[1] if "/" in m.name else m.name
            if not name or name.startswith(".."):
                continue
            tf.extract(m, TMP)
    print("  解压完成")


def main():
    import numpy as np
    import onnx
    import tflite2onnx

    fetch_src()
    os.makedirs(OUT, exist_ok=True)

    # 1) tflite → onnx
    src = os.path.join(SRC_DIR, "face_detection_front.tflite")
    dst = os.path.join(OUT, "face_detection_front.onnx")
    tflite2onnx.convert(src, dst)
    model = onnx.load(dst)
    ins = [(i.name, [d.dim_value or d.dim_param for d in i.type.tensor_type.shape.dim]) for i in model.graph.input]
    outs = [(o.name, [d.dim_value or d.dim_param for d in o.type.tensor_type.shape.dim]) for o in model.graph.output]
    print("  onnx  %.1fKB" % (os.path.getsize(dst) / 1024))
    print("  in    %s" % (ins,))
    print("  out   %s" % (outs,))
    names = {n for n, _ in outs}
    if not {"regressors", "classificators"} <= names:
        sys.exit("输出名不符合预期（需要 regressors / classificators），实际：%s" % (outs,))

    # 2) anchors.npy → anchors.json
    a = np.load(os.path.join(SRC_DIR, "anchors.npy"))
    if a.shape != (896, 4):
        sys.exit("anchors 形状异常：%s（期望 896×4）" % (a.shape,))
    with open(os.path.join(OUT, "anchors.json"), "w", encoding="utf-8") as f:
        json.dump([[float(v) for v in row] for row in a], f, separators=(",", ":"))
    print("  anchors.json  %s  w/h 取值 %s" % (a.shape, sorted(set(a[:, 2].round(4).tolist()))[:3]))

    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print("resources/face 就绪：%.0fKB" % (total / 1024))


if __name__ == "__main__":
    main()
