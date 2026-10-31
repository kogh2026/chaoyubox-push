# -*- coding: utf-8 -*-
"""官方侧 adapter —— 爱印「卡证矫正 FP32」worker 算法的 1:1 Python 移植。

为什么是"官方输出"：本文件逐函数复刻 aiyin_decrypted_assets/vendor/id2pdf-card-correction-worker.js
的预处理(V)、解码(W)、透矫正(J)、旋转(K)、涂白(Z) 与多卡循环(yt)，并加载同一份
resources/card-model/card-correction-fp32.onnx（爱印解密权重）。因此输出在数学上等价于爱印
官方 worker 的裁图（仅推理后端从 wasm 换成 onnxruntime CPU，会引入亚像素级浮点差，由容差吸收）。

若需"字面运行官方 JS 文件"而非移植，见 adapter_official_worker_js.mjs（需 Node + onnxruntime-web）。
若需"启动官方桌面 app 截画布"，见 adapter_official_gui.py。
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

# ---- 常量（照抄 id2pdf-card-correction-worker.js）----
T = 768
K = T // 4
I = 0.3
ST = 0.1
IT = 0.25
L = 0.03
CT = 0.5
MEAN = np.array([0.408, 0.447, 0.47], dtype=np.float32)
STD = np.array([0.289, 0.274, 0.278], dtype=np.float32)
ROOM_MIN = 0.3
MAX_PAGES = 2
MIN_AREA_FRAC = 0.04

# _J 归一化坐标的像素中心补偿量。**必须为 0**：官方 J() 用纯 c/o（无补偿）。
# 仅 verify_parity.py 会临时改成 0.5 来复现历史 bug、量化修复收益；生产路径不要动。
SAMPLE_OFFSET = 0.0


# ---- 几何 ----
def _O(w, h):
    return {"centerX": w / 2.0, "centerY": h / 2.0, "scale": max(w, h)}


def _lt(coords, cx, cy) -> bool:
    pos = neg = 0
    for s in range(4):
        ix, iy = coords[s * 2], coords[s * 2 + 1]
        lx, ly = coords[(s * 2 + 2) % 8], coords[(s * 2 + 3) % 8]
        c = (lx - ix) * (cy - iy) - (ly - iy) * (cx - ix)
        if c > 0:
            pos += 1
        elif c < 0:
            neg += 1
    return pos == 4 or neg == 4


def _ut(cands, n=I):
    if len(cands) < 2:
        return cands
    out = []
    for o in range(len(cands)):
        if cands[o]["score"] < n:
            break
        a = cands[o]["coordinates"]
        ccx = (a[0] + a[2] + a[4] + a[6]) / 4.0
        ccy = (a[1] + a[3] + a[5] + a[7]) / 4.0
        contained = False
        for l in range(len(cands)):
            if o == l or cands[l]["score"] < n:
                continue
            if _lt(cands[l]["coordinates"], ccx, ccy) and cands[o]["score"] < cands[l]["score"]:
                contained = True
                break
        if not contained:
            out.append(cands[o])
    return out


def _ht(l, n):
    e = (n % 4 + 4) % 4
    return [l[e], l[(e + 1) % 4], l[(e + 2) % 4], l[(e + 3) % 4]]


def _H(t):
    n = 0.0
    for e in range(len(t)):
        o = t[e]
        a = t[(e + 1) % len(t)]
        n += o[0] * a[1] - a[0] * o[1]
    return n / 2.0


def _U(t):
    return abs(_H(t))


def _Y(t, n, e, o):
    return abs((e[0] - n[0]) * (t[1] - n[1]) - (e[1] - n[1]) * (t[0] - n[0])) / o


def _B(t, n, e):
    if n > 1e-9:
        return (e - t) / n
    if n < -1e-9:
        return -t / n
    return float("inf")


def _Q(t, n, e):
    return min(e, max(n, t))


def _X(t, n, e, o):
    a = t[0] - n[0]
    s = t[1] - n[1]
    i = o[0] - e[0]
    r = o[1] - e[1]
    l = a * r - s * i
    if abs(l) < 1e-9:
        return t
    u = ((e[0] - t[0]) * r - (e[1] - t[1]) * i) / l
    return (t[0] + a * u, t[1] + s * u)


def _dt(t, n):
    e = 1 if _H(n) >= 0 else -1
    o = list(t)
    for a in range(4):
        s = n[a]
        i = n[(a + 1) % 4]

        def r(u):
            return e * ((i[0] - s[0]) * (u[1] - s[1]) - (i[1] - s[1]) * (u[0] - s[0]))

        l = o
        o = []
        for u in range(len(l)):
            c = l[u]
            h = l[(u + len(l) - 1) % len(l)]
            fc = r(c)
            fh = r(h)
            if fc >= 0:
                if fh < 0:
                    o.append(_X(h, c, s, i))
                o.append(c)
            elif fh >= 0:
                o.append(_X(h, c, s, i))
    return abs(_H(o)) if len(o) >= 3 else 0.0


def _z(corners, W, H):
    e = (corners[0][0] + corners[1][0] + corners[2][0] + corners[3][0]) / 4.0
    o = (corners[0][1] + corners[1][1] + corners[2][1] + corners[3][1]) / 4.0
    best = 0.0
    for s in range(4):
        i0 = corners[s]
        i1 = corners[(s + 1) % 4]
        ln = ((i1[0] - i0[0]) ** 2 + (i1[1] - i0[1]) ** 2) ** 0.5
        if ln < 1:
            continue
        uu = (i1[1] - i0[1]) / ln
        cc = -(i1[0] - i0[0]) / ln
        hx = (i0[0] + i1[0]) / 2
        hy = (i0[1] + i1[1]) / 2
        if uu * (hx - e) + cc * (hy - o) < 0:
            uu = -uu
            cc = -cc
        for m in (0.0, 0.5, 1.0):
            x = _Q(i0[0] + m * (i1[0] - i0[0]), 0, W)
            y = _Q(i0[1] + m * (i1[1] - i0[1]), 0, H)
            bb = min(_B(x, uu, W), _B(y, cc, H))
            if bb < 1:
                continue
            best = max(best, bb)
    return best


def _G(a, b, c, d):
    return (((a[0] + b[0]) / 2 - (c[0] + d[0]) / 2) ** 2 +
            ((a[1] + b[1]) / 2 - (c[1] + d[1]) / 2) ** 2) ** 0.5


def _mt(n):
    return {"height": int(_G(n[0], n[1], n[2], n[3])),
            "width": int(_G(n[0], n[3], n[2], n[1]))}


def _J(src, n, sample_offset: float | None = None):
    """透视矫正：quad(n, 4 像素坐标点) -> 规整矩形 RGBA（爱印官方 worker 行为）。

    采用 id2pdf-card-correction-worker.js 的投影逆变换 F()：目标矩形 (w,g)∈[0,1]² 经
    单应 1+f*w+d*g 映射回源图 (x,y)。四角对应 (0,0)→n0,(1,0)→e,(0,1)→a,(1,1)→o，
    解出系数 f,d 与 uu/xc/bb/yc/M/P。越界像素 RGB 填 0（黑）、alpha=255 —— 与自研
    cardCorrectMl 的"越界填白"形成对照差异点。

    采样坐标口径（关键，勿改）：官方 J() 的循环是
        u = l / e            # l ∈ [0, Hh)，e = Hh
        h = a(c / o, u)      # c ∈ [0, Ww)，o = Ww
    即归一化坐标**不做 +0.5 像素中心补偿**（纯 c/o，输出像素索引直接映射到 [0,1) 区间）。
    这与 canvas/OpenCV 常见的 ((i+0.5)/n) 约定不同；写成 +0.5 会整体位移半个目标像素
    （约 0.5 * 源像素/目标像素 的源图偏移），产生 mae≈4.5、max≈115 的系统性重采样差。
    """
    Hh = _mt(n)["height"]
    Ww = _mt(n)["width"]
    if Ww < 1 or Hh < 1:
        raise ValueError("Card crop collapsed to an empty rectangle.")
    n0, e, o, a = n[0], n[1], n[2], n[3]
    A11 = e[0] - o[0]
    A12 = a[0] - o[0]
    A21 = e[1] - o[1]
    A22 = a[1] - o[1]
    R1 = (n0[0] + o[0]) - (e[0] + a[0])
    R2 = (n0[1] + o[1]) - (e[1] + a[1])
    det = A11 * A22 - A12 * A21
    if abs(det) < 1e-9:
        det = 1e-9 if det >= 0 else -1e-9
    f = (R1 * A22 - A12 * R2) / det
    d = (A11 * R2 - R1 * A21) / det
    uu = e[0] - n0[0] + f * e[0]
    xc = a[0] - n0[0] + d * a[0]
    bb = e[1] - n0[1] + f * e[1]
    yc = a[1] - n0[1] + d * a[1]
    M = n0[0]
    P = n0[1]

    out = np.zeros((Hh, Ww, 4), dtype=np.uint8)
    sh, sw = src.shape[:2]
    c_idx = np.arange(Ww, dtype=np.float64)
    l_idx = np.arange(Hh, dtype=np.float64)
    off = SAMPLE_OFFSET if sample_offset is None else sample_offset
    # 与官方 J() 逐字对齐：w = c/o、g = l/e（off=0 时**不加 0.5**，见 docstring 的采样坐标口径）
    Wmat = ((c_idx + off) / Ww)[None, :]          # (1, Ww) 沿列
    Gmat = ((l_idx + off) / Hh)[:, None]          # (Hh, 1) 沿行
    den = 1.0 + f * Wmat + d * Gmat
    den = np.where(np.abs(den) < 1e-9, np.sign(den) * 1e-9 + (den == 0) * 1e-9, den)
    x = (uu * Wmat + xc * Gmat + M) / den
    y = (bb * Wmat + yc * Gmat + P) / den
    valid = (x >= 0) & (y >= 0) & (x <= sw - 1) & (y <= sh - 1)
    dx = np.clip(np.floor(x).astype(np.int64), 0, sw - 2)
    dy = np.clip(np.floor(y).astype(np.int64), 0, sh - 2)
    bx = x - dx; by = y - dy
    dx1 = dx + 1; dy1 = dy + 1
    for p in range(3):
        ch = src[..., p].astype(np.float32)
        A0 = ch[dy, dx] * (1 - bx) + ch[dy, dx1] * bx
        B0 = ch[dy1, dx] * (1 - bx) + ch[dy1, dx1] * bx
        out[..., p] = (A0 * (1 - by) + B0 * by).astype(np.uint8)
    out[~valid, :3] = 0                            # 越界填黑（爱印官方行为）
    out[..., 3] = 255                              # alpha 恒为 255
    return out


def _K(t, n):
    """按模型预测的 90° 倍数角旋转裁图（照抄官方 K()）。

    官方循环体：
        i = s? o : a      # 输出宽度
        r = s? a : o      # 输出高度
        h = n===1 ? a-1-u : (n===2 ? a-1-c : u)
        src = ((n===1 ? c : (n===2 ? o-1-u : o-1-c)) * a + h) * 4
    逐像素等价于（已验证三档都与官方同式）：
        n=1 → data.T[::-1]   n=2 → data[::-1,::-1]   n=3 → data.T[:, ::-1]
    旧实现把扁平索引 `(dd*Ww+h)*4` 直接喂给 3D 数组（IndexError），且 n=3 分支写成了
    (o-1-u, c)（与官方的 (o-1-c, u) 互为转置）—— 仅在 angle!=0 时触发，故长期未被发现。
    """
    if n == 0:
        return t
    data = np.asarray(t["data"])
    Hh, Ww = int(t["height"]), int(t["width"])
    if n == 1:
        out = data.transpose(1, 0, 2)[::-1]
    elif n == 2:
        out = data[::-1, ::-1]
    elif n == 3:
        out = data.transpose(1, 0, 2)[:, ::-1]
    else:
        raise ValueError(f"unsupported rotation angle {n}")
    out = np.ascontiguousarray(out)
    return {"data": out, "height": out.shape[0], "width": out.shape[1]}


def _Z(working, corners):
    Hh, Ww = working.shape[:2]
    ys = [p[1] for p in corners]
    s = max(0, int(min(ys)))
    i = min(Hh - 1, int(np.ceil(max(ys))))
    for r in range(s, i + 1):
        l = r + 0.5
        xs = []
        for c in range(4):
            h = corners[c]
            f = corners[(c + 1) % 4]
            if h[1] == f[1]:
                continue
            dm = min(h[1], f[1]); mm = max(h[1], f[1])
            if l < dm or l >= mm:
                continue
            xx = (l - h[1]) / (f[1] - h[1])
            xs.append(h[0] + xx * (f[0] - h[0]))
        if len(xs) < 2:
            continue
        xs.sort()
        for c in range(0, len(xs) - 1, 2):
            a_ = max(0, int(round(xs[c])))
            b_ = min(Ww - 1, int(round(xs[c + 1])))
            for dd in range(a_, b_ + 1):
                working[r, dd, 0] = 255
                working[r, dd, 1] = 255
                working[r, dd, 2] = 255
                working[r, dd, 3] = 255


def _V(img, n=None):
    if n is None:
        n = _O(img.shape[1], img.shape[0])
    h, w = img.shape[:2]
    s = T
    l_ = s / n["scale"]
    u = s / 2
    c_idx = np.arange(s, dtype=np.float64)
    yh = (c_idx - u) / l_ + n["centerY"]          # (s,)
    xh = (c_idx - u) / l_ + n["centerX"]          # (s,)
    fy = np.floor(yh).astype(np.int64); dy = (yh - fy)[:, None]
    fx = np.floor(xh).astype(np.int64); dx = (xh - fx)[None, :]
    FY, FX = np.meshgrid(fy, fx, indexing="ij")
    DY, DX = np.meshgrid(dy, dx, indexing="ij")   # (s,s)
    valid = (FX >= 0) & (FY >= 0) & (FX <= w - 2) & (FY <= h - 2)
    FXc = np.clip(FX, 0, w - 2); FYc = np.clip(FY, 0, h - 2)
    out = np.empty((1, 3, s, s), dtype=np.float32)
    for p in range(3):
        A = 2 - p  # 读 BGR
        ch = img[..., A].astype(np.float32)
        top = ch[FYc, FXc] * (1 - DX) + ch[FYc, FXc + 1] * DX
        bot = ch[FYc + 1, FXc] * (1 - DX) + ch[FYc + 1, FXc + 1] * DX
        val = (top * (1 - DY) + bot * DY) / 255.0
        chn = (val - MEAN[p]) / STD[p]
        chn[~valid] = -MEAN[p] / STD[p]
        out[0, p] = chn
    return out


def _W(out, n, e=I):
    o = len(out["scores"])
    cands = []
    for r in range(o):
        cands.append({
            "angle": float(out["angle"][r]),
            "coordinates": out["quads"][r * 8:r * 8 + 8].tolist(),
            "ftype": float(out["ftype"][r]),
            "score": float(out["scores"][r]),
        })
    sc = K / n["scale"]
    ii = K / 2
    ded = _ut(cands, e)
    res = []
    for c in ded:
        if c["score"] <= e:
            continue
        corners = [((c["coordinates"][k * 2] - ii) / sc + n["centerX"],
                   (c["coordinates"][k * 2 + 1] - ii) / sc + n["centerY"]) for k in range(4)]
        u = (int(c["angle"]) % 4 + 4) % 4
        res.append({"angle": u, "corners": corners, "ftype": c["ftype"],
                    "score": c["score"], "uprightCorners": _ht(corners, u), "uprightTurns": (4 - u) % 4})
    return res


def _j(t, n, e):
    o = _U(n[0]) if n else 0
    for a_ in t:
        s = _U(a_["corners"])
        if s / max(1, e["frameArea"]) < e["minAreaFrac"]:
            continue
        if any(_dt(a_["corners"], rr) / s >= IT for rr in n):
            continue
        if n:
            if a_["score"] > ST:
                return a_
            if a_["score"] > L and s >= CT * o:
                return a_
        else:
            if a_["score"] > I:
                return a_
    return None


@dataclass
class OfficialWorker:
    session: ort.InferenceSession
    input_name: str

    @classmethod
    def load(cls, model_path: str, providers=("CPUExecutionProvider",)):
        so = ort.SessionOptions()
        so.intra_op_num_threads = 4
        sess = ort.InferenceSession(model_path, so, providers=list(providers))
        return cls(sess, sess.get_inputs()[0].name)

    def run_image(self, img_rgba: np.ndarray, max_pages=MAX_PAGES, min_area_frac=MIN_AREA_FRAC):
        h, w = img_rgba.shape[:2]
        n = _O(w, h)
        working = img_rgba.copy()
        frame_area = max(1, w * h)
        accepted = []
        pages = []
        room = None
        for x in range(max_pages):
            M = _V(working, n)
            out = self.session.run(["scores", "quads", "angle", "ftype"],
                                  {self.input_name: M})
            outd = {"scores": np.asarray(out[0]).ravel(),
                    "quads": np.asarray(out[1]).ravel(),
                    "angle": np.asarray(out[2]).ravel(),
                    "ftype": np.asarray(out[3]).ravel()}
            th = I if x == 0 else L
            decoded = _W(outd, n, th)
            nxt = _j(decoded, accepted, {"frameArea": frame_area, "minAreaFrac": min_area_frac})
            if not nxt:
                break
            crop = _J(working, nxt["corners"])                       # 透视矫正（越界填黑）
            crop = _K({"data": crop, "height": crop.shape[0], "width": crop.shape[1]}, nxt["angle"])
            pages.append({"angle": nxt["angle"], "corners": nxt["uprightCorners"],
                          "rgb": crop["data"][:, :, :3].copy(), "score": nxt["score"]})
            accepted.append(nxt["corners"])
            if len(pages) == 1:
                room = _z(nxt["corners"], w, h)
                if room < ROOM_MIN:
                    break
            _Z(working, nxt["corners"])
        return pages


def process_image(worker: OfficialWorker, img_path: Path, max_pages=MAX_PAGES, min_area_frac=MIN_AREA_FRAC):
    im = Image.open(img_path).convert("RGBA")
    arr = np.asarray(im, dtype=np.uint8)
    return worker.run_image(arr, max_pages, min_area_frac)


def main_demo(limit: int = 3):
    """独立跑一个最小 demo，验证移植可产出裁图。"""
    ROOT = Path(__file__).resolve().parent.parent.parent
    model = ROOT / "resources" / "card-model" / "card-correction-fp32.onnx"
    w = OfficialWorker.load(str(model))
    d = Path(r"D:/50/身份证正面")
    for i, p in enumerate(sorted(d.iterdir())):
        if i >= limit:
            break
        pages = process_image(w, p)
        print(p.name, "pages=", len(pages))
        for j, pg in enumerate(pages):
            print(f"  p{j} {pg['rgb'].shape} score={pg['score']:.3f}")


if __name__ == "__main__":
    main_demo()
