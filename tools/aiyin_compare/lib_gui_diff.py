# -*- coding: utf-8 -*-
"""GUI 截图专用比对：判断"屏幕上看到的东西"是否忠实反映官方 worker 的产出。

为什么不能直接套用 lib_diff 的绝对阈值
------------------------------------
截图必然经过「canvas 光栅 → 合成器 → 显示器色彩管理 → PNG 编码」，
即使像素内容完全一样也不可能逐位相同。所以这里用**自指噪声地板**：

    floor_mae   = |截图 − 同一块画布的回读|        ← 只含"截图/上屏"这一段引入的噪声
    content_mae = |截图 − worker 原始 RGBA(对齐后)|  ← 用户看到 vs 算法产出
    ratio       = content_mae / floor_mae

ratio ≤ 1 意味着「截图相对 worker 的偏差，不比截图本身引入的噪声更大」——
即截图链路没有额外篡改内容。这是把"不可能相等"变成可判定命题的关键。

三张图各是什么
--------------
- `canvas_native`：`canvas.toDataURL('image/png')`。画布里到底有什么（无损、权威）。
- `shot`：`locator.screenshot()`。真实屏幕像素（含缩放/色彩管理/抗锯齿）。
- `worker`：Node 路径下 worker 返回的裸 RGBA（算法真正的产出）。

三个差值的含义
--------------
| 差值 | 为 0 说明 |
|---|---|
| canvas_vs_worker | canvas 2D（含 alpha 预乘、色彩管理）没有改动像素 |
| floor (shot−canvas) | 上屏链路完全无噪声（DPR=1 且 1:1 显示时常见） |
| content (shot−worker) | 用户看到的就是算法算出的 |
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from lib_diff import _grayscale, ssim_gray, struct_ssim

# 默认位图字体不含中文字形，标签会变成方块；优先用系统雅黑/黑体
_FONT_CANDIDATES = (
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\msyhl.ttc",
)


def _font(size: int = 13):
    for p in _FONT_CANDIDATES:
        try:
            return ImageFont.truetype(p, size)
        except Exception:  # noqa: BLE001
            continue
    return ImageFont.load_default()

# 分档：GUI 侧只看"截图是否忠实"，不看"与自研是否一致"（后者是 lib_diff 的活）
DEFAULT_TOL: dict = {
    "gui_exact": {"floor_mae": 0.5, "canvas_vs_worker_mae": 0.5, "struct_ssim": 0.9995,
                  "require_native_geom": True},
    "gui_ok": {"noise_ratio": 1.5, "struct_ssim": 0.995},
    "gui_warn": {"noise_ratio": 3.0, "struct_ssim": 0.98},
}


@dataclass
class GuiDiff:
    verdict: str                          # gui_exact|gui_ok|gui_warn|gui_fail
    shot_size: tuple = (0, 0)
    canvas_size: tuple = (0, 0)
    worker_size: tuple = (0, 0)
    canvas_vs_worker_mae: float = 0.0     # 画布回读 vs worker 原始（应≈0）
    canvas_vs_worker_max: int = 0
    floor_mae: float = 0.0                # 截图 vs 画布（截图噪声地板）
    floor_max: int = 0
    content_mae: float = 0.0              # 截图 vs worker（内容保真）
    content_max: int = 0
    noise_ratio: float = 0.0              # content_mae / floor_mae
    struct_ssim: float = 1.0
    resampled: bool = False               # 截图尺寸 != 画布尺寸
    notes: list = field(default_factory=list)


def _load_rgb(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.uint8)


def _abs_stats(a: np.ndarray, b: np.ndarray) -> tuple[float, float, int]:
    """返回 (mae, 亮度通道 mae 的标准化值, max)。a/b 必须同形。"""
    d = np.abs(a.astype(np.int16) - b.astype(np.int16))
    return float(d.mean()), float(d.max(axis=2).mean()), int(d.max())


def _pair(a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray, bool]:
    """把 b 对齐到 a 的尺寸（LANCZOS）。返回 (a, b', resized)。"""
    if a.shape == b.shape:
        return a, b, False
    b2 = np.asarray(Image.fromarray(b).resize((a.shape[1], a.shape[0]), Image.LANCZOS), dtype=np.uint8)
    return a, b2, True


def compare_gui(shot: Path, canvas_native: Path, worker: Path | None = None,
                tol: dict | None = None) -> GuiDiff:
    """比对一张 GUI 截图是否忠实反映官方产出。

    Args:
        shot: 屏幕截图（element screenshot / 真实 app 截图）。
        canvas_native: 同一块 canvas 的 toDataURL 回读（无损）。
        worker: 官方 worker 裸输出（可选；缺省时只做 shot vs canvas）。
        tol: 容差档，默认 DEFAULT_TOL。

    Returns:
        GuiDiff（含 verdict 与可读 notes）。

    Raises:
        FileNotFoundError: 任一必需文件缺失。
    """
    tol = tol or DEFAULT_TOL
    if not Path(shot).exists():
        raise FileNotFoundError(shot)
    if not Path(canvas_native).exists():
        raise FileNotFoundError(canvas_native)

    s = _load_rgb(Path(shot))
    c = _load_rgb(Path(canvas_native))
    notes: list[str] = []
    resampled = False
    if s.shape != c.shape:
        c, s2, _ = _pair(c, s)      # 以 canvas 为基准对齐截图
        s = s2
        resampled = True
        notes.append(f"截图尺寸与画布不一致（shot {s.shape[1]}x{s.shape[0]} / canvas {c.shape[1]}x{c.shape[0]}），已缩放对齐")

    floor_mae, _, floor_max = _abs_stats(s, c)
    g = GuiDiff(verdict="gui_fail", shot_size=(s.shape[1], s.shape[0]),
                canvas_size=(c.shape[1], c.shape[0]),
                floor_mae=floor_mae, floor_max=floor_max, resampled=resampled)

    if worker is not None and Path(worker).exists():
        w = _load_rgb(Path(worker))
        g.worker_size = (w.shape[1], w.shape[0])
        # 画布 vs worker：两者都是无损像素，应逐位相同；不同说明 canvas 2D 改动了像素
        cc, ww, rz1 = _pair(c, w)
        cw_mae, _, cw_max = _abs_stats(cc, ww)
        g.canvas_vs_worker_mae, g.canvas_vs_worker_max = cw_mae, cw_max
        if rz1:
            notes.append(f"worker 输出 {w.shape[1]}x{w.shape[0]} 与画布尺寸不同，已缩放（理论上不应发生）")
        # 截图 vs worker
        ss, ww2, _ = _pair(s, w)
        g.content_mae, _, g.content_max = _abs_stats(ss, ww2)
        g.struct_ssim = struct_ssim(ss, ww2)
        g.noise_ratio = float(g.content_mae / max(g.floor_mae, 1e-6))
    else:
        notes.append("未提供 worker 基准，只做『截图 vs 画布』保真度判定")
        g.content_mae = floor_mae
        g.content_max = floor_max
        g.struct_ssim = struct_ssim(s, c)
        g.noise_ratio = 1.0 if floor_mae < 1e-6 else float(g.content_mae / max(g.floor_mae, 1e-6))

    # ---- 分档 ----
    geom_native = (not resampled)
    t_ex = tol.get("gui_exact", {})
    if (geom_native
            and g.floor_mae <= t_ex.get("floor_mae", 0.5)
            and g.canvas_vs_worker_mae <= t_ex.get("canvas_vs_worker_mae", 0.5)
            and g.struct_ssim >= t_ex.get("struct_ssim", 0.9995)):
        g.verdict = "gui_exact"
    else:
        g.verdict = "gui_fail"
        for name in ("gui_ok", "gui_warn"):
            t = tol.get(name, {})
            if (g.noise_ratio <= t.get("noise_ratio", 1e9)
                    and g.struct_ssim >= t.get("struct_ssim", 0.0)):
                g.verdict = name
                break

    # ---- 归因备注 ----
    if g.floor_mae < 0.05 and g.canvas_vs_worker_mae < 0.05:
        notes.append(f"截图与画布逐位等价（floor_mae={g.floor_mae:.4f}）：DPR=1 且 1:1 显示时上屏链路零损失")
    else:
        notes.append(f"截图链路噪声 floor_mae={g.floor_mae:.3f}（max {g.floor_max}）：来自合成器/色彩管理/缩放")
    if g.canvas_vs_worker_mae >= 0.5:
        notes.append(f"画布回读与 worker 原始不同（mae={g.canvas_vs_worker_mae:.3f} max={g.canvas_vs_worker_max}）："
                     "canvas 2D 改动过像素（alpha 预乘或色彩管理）")
    else:
        notes.append(f"画布回读 == worker 原始（mae={g.canvas_vs_worker_mae:.4f} max={g.canvas_vs_worker_max}）")
    if g.noise_ratio:
        notes.append(f"内容保真 noise_ratio={g.noise_ratio:.2f}（content {g.content_mae:.3f} / floor {g.floor_mae:.3f}），"
                     f"structSSIM={g.struct_ssim:.5f}")
    if g.verdict == "gui_fail":
        notes.append("截图相对 worker 的偏差超出截图噪声可解释范围，需人工复核差异条")
    return g


def make_gui_strip(shot: Path, canvas_native: Path, out_path: Path,
                   worker: Path | None = None, diff_threshold: int = 8,
                   title: str = "") -> Path:
    """四栏对照条：画布回读 | 屏幕截图 | 截图−画布(噪声) | 截图−worker(差异)。"""
    c = _load_rgb(Path(canvas_native))
    s = _load_rgb(Path(shot))
    if c.shape != s.shape:
        c = np.asarray(Image.fromarray(c).resize((s.shape[1], s.shape[0]), Image.LANCZOS), dtype=np.uint8)
    h, w = s.shape[:2]

    def _heat(a: np.ndarray, b: np.ndarray) -> np.ndarray:
        d = np.abs(a.astype(np.int16) - b.astype(np.int16)).max(axis=2)
        img = np.full((h, w, 3), 60, dtype=np.uint8)
        m = d > diff_threshold
        amp = np.clip(d.astype(np.int16) * 6, 0, 255).astype(np.uint8)
        img[m, 0] = amp[m]
        img[m, 1] = (amp[m] * 0.6).astype(np.uint8)
        img[m, 2] = 0
        return img

    noise = _heat(c, s)                       # 截图噪声
    if worker is not None and Path(worker).exists():
        wparr = _load_rgb(Path(worker))
        wparr = np.asarray(Image.fromarray(wparr).resize((w, h), Image.LANCZOS), dtype=np.uint8) \
            if wparr.shape != s.shape else wparr
        content = _heat(wparr, s)
        panels = [(c, "画布回读 (canvas)"), (s, "屏幕截图 (screenshot)"),
                  (noise, "截图−画布 噪声"), (content, "截图−worker 差异")]
    else:
        panels = [(c, "画布回读"), (s, "屏幕截图"), (noise, "截图−画布 噪声")]

    bar = 30
    canvas = Image.new("RGB", (w * len(panels), h + bar), (18, 18, 18))
    d = ImageDraw.Draw(canvas)
    f = _font(14)
    for i, (arr, label) in enumerate(panels):
        canvas.paste(Image.fromarray(arr), (i * w, bar))
        d.text((i * w + 8, 7), label, fill=(230, 230, 230), font=f)
    if title:
        d.text((len(panels) * w - 260, 7), title[:30], fill=(150, 190, 255), font=f)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path)
    return out_path
