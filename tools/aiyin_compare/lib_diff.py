# -*- coding: utf-8 -*-
"""像素级比对引擎：把"参考(自研)"与"官方(爱印)"两张裁图做逐像素 diff，
输出指标、并排合成图、差异热力图与高亮 bbox，并按容差分档裁决。

为什么不是"简单阈值比大小"（三个坑，都在这里处理掉）：

1) **参考侧是有损的**。自研侧裁图经 canvas `toDataURL('image/jpeg', 0.92)` 落盘，
   官方 worker 给的是无损 RGBA。即使算法完全等价，也会出现 mae≈1、max≈20 的差异。
   → 用"JPEG 噪声地板"归因：把官方图按同参数 q0.92 往返一次，得到 noise_mae，
     裁决看 mae / noise_mae（noise_ratio），而不是看绝对差。

2) **参考侧被主动降采样**。app 的 downscaleLong 把长边压到 1100，官方是原生分辨率
   （可能 2000+）。尺寸不同时只能缩放对齐，重采样会引入额外误差。
   → 记录 resized=True 并在备注里说明；同时额外算一个"结构相似度 struct_ssim"
     （两侧都缩到同一小尺寸再比），它对重采样不敏感，用来判断"内容是否一致"。

3) **越界填充口径不同（已知设计差异）**。自研 fix① 把透视越界像素填白，
   爱印官方 worker 的 J() 把越界像素填黑（alpha=255、RGB=0）。
   → 单独统计"边框环"的差异（border_mae / border_diff_frac），不混进主裁决，
     避免把这条**已知且有意**的差异误判成算法不一致。
"""
from __future__ import annotations

import io
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

BORDER_PX = 2          # 视为"边框环"的宽度（越界填充差异通常只在最外 1~2 px）


@dataclass
class DiffResult:
    verdict: str                      # exact|strict|pass|warn|fail
    mae: float                        # 全图平均绝对差（0~255，三通道均值）
    interior_mae: float               # 去掉边框环后的平均绝对差（主裁决依据）
    border_mae: float                 # 边框环平均绝对差
    border_diff_frac: float           # 边框环中差异>阈值的像素占比
    fill_frac: float                  # 越界填充口径差异（一侧纯黑/一侧纯白）占画面比例
    max_diff: int                     # 单像素单通道最大差
    p95_diff: float                   # 95 分位单像素最大通道差
    changed_frac: float               # 变化像素占比（>threshold）
    ssim: float                       # 全分辨率 SSIM（亮度）
    struct_ssim: float                # 缩到同一小尺寸后的 SSIM（抗重采样）
    noise_mae: float = 0.0            # JPEG q0.92 往返噪声地板
    noise_ratio: float = 0.0          # interior_mae / noise_mae
    resized: bool = False             # 官方侧是否缩放对齐（参考被降采样）
    border_flag: bool = False         # 是否存在"边框填充口径"差异
    cause: str = ""                   # 差异归因：bit_identical|jpeg_noise|resampler|fill_convention|content_diff
    identical_after_reencode: bool = False  # 参考图 == 官方图按 canvas 参数重编码（逐位）
    reencode_mismatch_px: int = 0     # 重编码比对后仍不同的像素数
    ref_size: tuple = (0, 0)
    off_size: tuple = (0, 0)
    notes: list = field(default_factory=list)


def _load_rgb(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.uint8)


def _box_mean(img: np.ndarray, win: int) -> np.ndarray:
    """用积分图做 win×win 均值，返回与原图同形的边缘复制填充结果（向量化，快）。"""
    h, w = img.shape[:2]
    pad = win // 2
    p = np.pad(img, ((pad, pad), (pad, pad)), mode="edge")
    ii = p.cumsum(0).cumsum(1)
    ii = np.pad(ii, ((1, 0), (1, 0)), mode="constant")
    s = ii[win:, win:] - ii[:-win, win:] - ii[win:, :-win] + ii[:-win, :-win]
    return s / (win * win)


def ssim_gray(a: np.ndarray, b: np.ndarray, win: int = 7) -> float:
    """单尺度 SSIM（亮度通道，均匀窗 + 积分图加速）。"""
    a = a.astype(np.float64)
    b = b.astype(np.float64)
    if a.shape != b.shape:
        # 防御：尺寸不一致时裁到公共区域，避免误报 1.0（等价）或崩掉
        hh = min(a.shape[0], b.shape[0])
        ww = min(a.shape[1], b.shape[1])
        a, b = a[:hh, :ww], b[:hh, :ww]
    if a.size == 0:
        return 1.0
    if min(a.shape) < win:
        ta, tb = a.ravel(), b.ravel()
        da, db = ta - ta.mean(), tb - tb.mean()
        den = math.sqrt((da ** 2).sum() * (db ** 2).sum())
        return float((da * db).sum() / den) if den > 0 else 1.0
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    mu_a, mu_b = _box_mean(a, win), _box_mean(b, win)
    va = _box_mean(a * a, win) - mu_a ** 2
    vb = _box_mean(b * b, win) - mu_b ** 2
    vab = _box_mean(a * b, win) - mu_a * mu_b
    s = ((2 * mu_a * mu_b + c1) * (2 * vab + c2)) / ((mu_a ** 2 + mu_b ** 2 + c1) * (va + vb + c2) + 1e-12)
    return float(s.mean())


def _grayscale(rgb: np.ndarray) -> np.ndarray:
    return rgb.astype(np.float64) @ np.array([0.299, 0.587, 0.114])


def struct_ssim(a: np.ndarray, b: np.ndarray, long_edge: int = 192) -> float:
    """两侧都缩到同一小尺寸再算 SSIM，抵消重采样差异，只看内容是否一致。

    先裁掉 2% 边缘：越界填充（自研白/爱印黑）只出现在卡面边界，且会被缩放放大成
    局部负相关，把整体 SSIM 拉到 0.97 这类假低值；裁边后只看卡面内容。
    """
    def _small(x):
        h, w = x.shape[:2]
        my, mx = max(2, int(h * 0.02)), max(2, int(w * 0.02))
        x = x[my:h - my, mx:w - mx]
        h, w = x.shape[:2]
        s = long_edge / max(h, w)
        return np.asarray(
            Image.fromarray(x).resize((max(8, round(w * s)), max(8, round(h * s))), Image.BILINEAR),
            dtype=np.uint8)
    return ssim_gray(_grayscale(_small(a)), _grayscale(_small(b)))


def _jpeg_roundtrip(off: np.ndarray, quality: int = 92, subsampling: int = 2) -> np.ndarray:
    """把官方图按浏览器 canvas 的实际参数重编码一次（q0.92 + 4:2:0 色度下采样）。

    必须用 4:2:0：canvas.toDataURL('image/jpeg',0.92) 走的就是 4:2:0，
    用 4:4:4 会低估噪声地板（红/蓝高饱和区域如国徽会整片漏判）。
    """
    buf = io.BytesIO()
    Image.fromarray(off, "RGB").save(buf, "JPEG", quality=quality, subsampling=subsampling)
    buf.seek(0)
    return np.asarray(Image.open(buf).convert("RGB"), dtype=np.uint8)


def _jpeg_floor(off: np.ndarray, quality: int = 92, subsampling: int = 2) -> tuple[float, int]:
    """纯编码噪声地板 + 重编码结果的差异统计。"""
    rt = _jpeg_roundtrip(off, quality=quality, subsampling=subsampling)
    d = np.abs(off.astype(np.int16) - rt.astype(np.int16))
    return float(d.mean()), int(d.max())


def _verdict(m: dict, tol: dict) -> str:
    """噪声归因式裁决。主看 interior_mae / 噪声地板 的比值 + 结构 SSIM。

    每档支持字段：struct_ssim（下限）、noise_ratio（上限）、max_diff（上限，取内部区域）、
    ssim（下限）、fill_frac（上限，越界填充差异占比）、require_native（resized 不进该档）。

    主判据是 noise_ratio（差异能否被编码噪声解释），struct_ssim 只作结构兜底：
    参考侧被 JPEG 压过，structSSIM 天然落在 0.998~0.9995，不能当精密尺子用。
    """
    for name in ("exact", "strict", "pass", "warn"):
        t = tol.get(name)
        if not t:
            continue
        if t.get("require_native") and m["resized"]:
            continue
        ok = True
        if "max_diff" in t:
            # 用内部区域最大差裁决，避免边框填充口径（白/黑）把整档拉爆
            ok = ok and m.get("interior_max_diff", m["max_diff"]) <= t["max_diff"]
        if "fill_frac" in t:
            ok = ok and m.get("fill_frac", 0.0) <= t["fill_frac"]
        if "noise_ratio" in t:
            ok = ok and m["noise_ratio"] <= t["noise_ratio"]
        if "struct_ssim" in t:
            ok = ok and m["struct_ssim"] >= t["struct_ssim"]
        if "ssim" in t:
            ok = ok and m["ssim"] >= t["ssim"]
        if ok:
            return name
    return "fail"


def compare(ref_path: Path, off_path: Path, tol: dict,
            diff_threshold: int = 8, jpeg_quality: int = 92) -> DiffResult:
    ref = _load_rgb(ref_path)
    off = _load_rgb(off_path)
    ref_size = (ref.shape[1], ref.shape[0])
    off_size = (off.shape[1], off.shape[0])
    resized = False
    if ref.shape != off.shape:
        off = np.asarray(
            Image.fromarray(off).resize((ref.shape[1], ref.shape[0]), Image.LANCZOS),
            dtype=np.uint8,
        )
        resized = True

    ref_i = ref.astype(np.int16)
    off_i = off.astype(np.int16)
    absd = np.abs(ref_i - off_i)
    max_ch = absd.max(axis=2)

    # 越界填充口径差异：一侧近黑(<=10) 且另一侧近白(>=245)。
    # 自研 fix① 越界填白、爱印 J() 越界填黑；当 quad 越出照片边界时会形成大片纯色块，
    # 面积可能远超“边框环”，必须按内容识别出来，否则会把这条已知设计差异误判成算法不一致。
    ref_black = (ref_i <= 10).all(axis=2)
    ref_white = (ref_i >= 245).all(axis=2)
    off_black = (off_i <= 10).all(axis=2)
    off_white = (off_i >= 245).all(axis=2)
    fill_mask = (ref_white & off_black) | (ref_black & off_white)
    fill_frac = float(fill_mask.mean())

    h, w = max_ch.shape
    # 边框环宽度自适应：越界填充带可能有几像素宽（尤其降采样后），固定 2px 盖不住，
    # 会让 255 的填充差漏进"内部"把 max_diff 顶爆。取 min(维度) 的 0.6%，至少 2px。
    bp = min(max(BORDER_PX, int(round(min(h, w) * 0.006))), max(0, min(h, w) // 4))
    valid = ~fill_mask
    if bp > 0:
        valid[:bp, :] = False
        valid[h - bp:, :] = False
        valid[:, :bp] = False
        valid[:, w - bp:] = False
    if valid.sum() == 0:
        valid = ~fill_mask
    interior_mae = float(absd[valid].mean()) if valid.any() else 0.0
    interior_max = int(max_ch[valid].max()) if valid.any() else 0

    # 边框环单独统计（去掉填充差异像素后）
    border_mask = np.zeros_like(max_ch, dtype=bool)
    if bp > 0:
        border_mask[:bp, :] = True
        border_mask[h - bp:, :] = True
        border_mask[:, :bp] = True
        border_mask[:, w - bp:] = True
    border_mask &= ~fill_mask
    border_vals = max_ch[border_mask]
    border_mae = float(border_vals.mean()) if border_vals.size else 0.0
    border_diff_frac = float((border_vals > diff_threshold).mean()) if border_vals.size else 0.0
    border_hot = int((border_vals > 100).sum()) if border_vals.size else 0

    mae = float(absd.mean())
    max_diff = int(max_ch.max())
    p95 = float(np.percentile(max_ch, 95))
    changed_frac = float((max_ch > diff_threshold).mean())

    ssim = ssim_gray(_grayscale(ref), _grayscale(off))
    s_struct = struct_ssim(ref, off)

    noise_mae, noise_max = _jpeg_floor(off, quality=jpeg_quality)
    noise_ratio = float(interior_mae / max(noise_mae, 1e-6))

    # 硬判据：参考图是否**逐位等于**官方图按 canvas 参数重编码的结果。
    # 若相等，说明两条链路除一次 JPEG 编码外完全一致（可比 "算法等价" 更强的结论）。
    rt = _jpeg_roundtrip(off, quality=jpeg_quality)
    identical_reenc = bool(np.array_equal(ref, rt))
    reenc_mismatch = int((ref != rt).any(axis=2).sum())

    metrics = {
        "mae": mae, "interior_mae": interior_mae, "border_mae": border_mae,
        "max_diff": max_diff, "interior_max_diff": interior_max,
        "changed_frac": changed_frac, "fill_frac": fill_frac,
        "ssim": ssim, "struct_ssim": s_struct,
        "noise_mae": noise_mae, "noise_ratio": noise_ratio, "resized": resized,
    }
    verdict = _verdict(metrics, tol)
    if identical_reenc and not resized:
        verdict = "exact"   # 参考图 == 官方图按 canvas 参数(q0.92/4:2:0)重编码，逐位相同

    notes = [f"JPEG 噪声地板(q{jpeg_quality}/4:2:0) mae={noise_mae:.2f}/max={noise_max}；内部区域 mae 为其 {noise_ratio:.2f}×（内部最大差 {interior_max}）"]
    if identical_reenc:
        notes.append("参考图与官方图按 canvas 参数重编码后**逐位相同**（两条链路只差一次 JPEG 编码）")
    elif reenc_mismatch:
        notes.append(f"重编码比对仍有 {reenc_mismatch} 个像素不同（占 {reenc_mismatch/max(1,ref.shape[0]*ref.shape[1])*100:.4f}%）")
    if resized:
        notes.append(f"参考侧被 app 降到 1100 长边（{ref_size[0]}x{ref_size[1]}），官方原生 {off_size[0]}x{off_size[1]}；已缩放对齐，structSSIM={s_struct:.5f}")
    # 差异归因（给报告用，回答"为什么不一样"）
    if identical_reenc and not resized:
        cause = "bit_identical"
    elif noise_ratio <= 1.20 and not resized:
        cause = "jpeg_noise"
    elif fill_frac > 0.002 and interior_mae <= max(noise_mae * 1.5, 2.0):
        cause = "fill_convention"
    elif resized and noise_ratio <= 2.6:
        cause = "resampler"
    else:
        cause = "content_diff"

    border_flag = fill_frac > 0.002 or border_hot >= 20
    if border_flag:
        notes.append(f"越界填充口径差异：自研填白 / 爱印填黑，占画面 {fill_frac*100:.2f}%（已知设计差异，已从主裁决剔除）")
    if border_hot:
        notes.append(f"边框环另有 {border_hot} 个强差异像素（>100）")
    if verdict in ("warn", "fail"):
        notes.append("内部区域差异超出编码噪声可解释范围，需人工复核")
    elif verdict in ("strict", "pass"):
        notes.append("内部区域差异可由编码噪声完全解释（算法等价）")

    return DiffResult(
        verdict=verdict, mae=mae, interior_mae=interior_mae, border_mae=border_mae,
        border_diff_frac=border_diff_frac, fill_frac=fill_frac,
        max_diff=max_diff, p95_diff=p95,
        changed_frac=changed_frac, ssim=ssim, struct_ssim=s_struct,
        noise_mae=noise_mae, noise_ratio=noise_ratio, resized=resized,
        border_flag=border_flag, cause=cause, identical_after_reencode=identical_reenc,
        reencode_mismatch_px=reenc_mismatch,
        ref_size=ref_size, off_size=off_size, notes=notes,
    )


def make_side_by_side(ref_path: Path, off_path: Path, diff: DiffResult,
                      diff_threshold: int, out_path: Path,
                      label_ref: str = "参考(自研)", label_off: str = "官方(爱印)",
                      crop_name: str = "") -> Path:
    """生成 参考 | 官方 | 差异热力图 三栏并排合成图，并在差异图上高亮变化区域 bbox。"""
    ref = _load_rgb(ref_path)
    off = _load_rgb(off_path)
    if ref.shape != off.shape:
        off = np.asarray(Image.fromarray(off).resize((ref.shape[1], ref.shape[0]), Image.LANCZOS), dtype=np.uint8)
    h, w = ref.shape[:2]

    absd = np.abs(ref.astype(np.int16) - off.astype(np.int16)).astype(np.uint8)
    max_ch = absd.max(axis=2)
    ri, oi = ref.astype(np.int16), off.astype(np.int16)
    fill_mask = ((ri >= 245).all(axis=2) & (oi <= 10).all(axis=2)) | \
                ((ri <= 10).all(axis=2) & (oi >= 245).all(axis=2))

    heat = np.full((h, w, 3), 60, dtype=np.uint8)
    mask = (max_ch > diff_threshold) & ~fill_mask
    amp = np.clip(max_ch.astype(np.int16) * 6, 0, 255).astype(np.uint8)
    heat[mask, 0] = amp[mask]
    heat[mask, 1] = (amp[mask] * 0.6).astype(np.uint8)
    heat[mask, 2] = 0
    # 填充口径差异单独用蓝色标注（蓝=越界填充白/黑，红黄=内容差异）
    heat[fill_mask, 0] = 40
    heat[fill_mask, 1] = 120
    heat[fill_mask, 2] = 230
    ys, xs = np.where(mask)
    if ys.size:
        himg = Image.fromarray(heat)
        d = ImageDraw.Draw(himg)
        d.rectangle([int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())],
                    outline=(255, 255, 0), width=2)
        heat = np.asarray(himg, dtype=np.uint8)

    bar = 28
    canvas = Image.new("RGB", (w * 3, h + bar), (18, 18, 18))
    canvas.paste(Image.fromarray(ref), (0, bar))
    canvas.paste(Image.fromarray(off), (w, bar))
    canvas.paste(Image.fromarray(heat), (w * 2, bar))
    d = ImageDraw.Draw(canvas)
    d.text((6, 7), f"{label_ref} | {crop_name}", fill=(225, 225, 225))
    d.text((w + 6, 7), label_off, fill=(225, 225, 225))
    d.text((w * 2 + 6, 7), f"diff (>{diff_threshold}) verdict={diff.verdict}", fill=(225, 225, 225))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path)
    return out_path
