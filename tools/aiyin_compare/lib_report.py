# -*- coding: utf-8 -*-
"""报告生成：JSON 明细 + Markdown 摘要 + 运行日志。

JSON 字段（逐卡）：dir_tag, orig_name, idx, ref_path, off_path, verdict, mae, max_diff,
p95_diff, changed_frac, ssim, resized, notes, side_by_side(相对路径)。
聚合：counts(按 verdict), total, 平均指标, 最差 N 张。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import List


@dataclass
class CardRecord:
    dir_tag: str
    orig_name: str
    idx: int
    ref_path: str = ""
    off_path: str = ""
    verdict: str = "n/a"
    mae: float = 0.0
    interior_mae: float = 0.0
    border_mae: float = 0.0
    border_diff_frac: float = 0.0
    fill_frac: float = 0.0
    max_diff: int = 0
    p95_diff: float = 0.0
    changed_frac: float = 0.0
    ssim: float = 1.0
    struct_ssim: float = 1.0
    noise_mae: float = 0.0
    noise_ratio: float = 0.0
    resized: bool = False
    border_flag: bool = False
    cause: str = ""
    identical_after_reencode: bool = False
    reencode_mismatch_px: int = 0
    note: str = ""
    side_by_side: str = ""
    # ---- GUI 截图链路（仅 official_adapter=official_gui 时有值）----
    gui_verdict: str = ""          # gui_exact|gui_ok|gui_warn|gui_fail|""
    gui_ratio: float = 0.0         # 截图内容保真比 content_mae / 截图噪声地板
    gui_floor_mae: float = 0.0     # 截图链路自身噪声
    gui_canvas_mae: float = 0.0    # 画布回读 vs worker 原始
    gui_shot: str = ""             # 截图路径


@dataclass
class RunReport:
    meta: dict = field(default_factory=dict)
    records: List[CardRecord] = field(default_factory=list)

    def aggregate(self) -> dict:
        counts = {}
        causes = {}
        for r in self.records:
            counts[r.verdict] = counts.get(r.verdict, 0) + 1
            if r.cause:
                causes[r.cause] = causes.get(r.cause, 0) + 1
        n = max(1, len(self.records))
        paired = [r for r in self.records if r.verdict != "n/a"]
        np_ = max(1, len(paired))

        def avg(attr):
            return round(sum(getattr(r, attr) for r in paired) / np_, 4)

        gui = [r for r in self.records if r.gui_verdict]
        return {
            "total": len(self.records),
            "paired": len(paired),
            "counts_by_verdict": counts,
            "counts_by_cause": causes,
            "avg_mae": round(sum(r.mae for r in self.records) / n, 4),
            "avg_interior_mae": avg("interior_mae"),
            "avg_ssim": avg("ssim"),
            "avg_struct_ssim": avg("struct_ssim"),
            "avg_noise_ratio": avg("noise_ratio"),
            "bounds_white_vs_black": sum(1 for r in paired if r.border_flag),
            "identical_after_reencode": sum(1 for r in paired if r.identical_after_reencode),
            "resized_pairs": sum(1 for r in paired if r.resized),
            # GUI 截图链路（无 GUI 侧时为空）
            "gui_checked": len(gui),
            "gui_counts_by_verdict": {v: sum(1 for r in gui if r.gui_verdict == v)
                                      for v in sorted({r.gui_verdict for r in gui})},
            "gui_avg_floor_mae": round(sum(r.gui_floor_mae for r in gui) / max(1, len(gui)), 4),
            "gui_avg_canvas_mae": round(sum(r.gui_canvas_mae for r in gui) / max(1, len(gui)), 4),
            "gui_avg_ratio": round(sum(r.gui_ratio for r in gui) / max(1, len(gui)), 4),
        }

    def worst(self, k: int = 10) -> List[CardRecord]:
        order = {"fail": 0, "warn": 1, "pass": 2, "strict": 3, "exact": 4, "n/a": 5}
        return sorted(self.records, key=lambda r: (order.get(r.verdict, 9), -r.mae))[:k]


def write_json(report: RunReport, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    out = {
        "meta": report.meta,
        "aggregate": report.aggregate(),
        "worst": [asdict(r) for r in report.worst(10)],
        "records": [asdict(r) for r in report.records],
    }
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")


def write_markdown(report: RunReport, path: Path, gallery_rel: str = "gallery.html"):
    path.parent.mkdir(parents=True, exist_ok=True)
    agg = report.aggregate()
    lines = []
    lines.append("# 爱印官方 vs 自研 像素级对照报告\n")
    lines.append(f"- 对照对象：`{report.meta.get('official_adapter')}` vs 参考 `{report.meta.get('reference_adapter')}`")
    lines.append(f"- 测试图目录：`{report.meta.get('image_dirs')}`")
    lines.append(f"- 目标：{report.meta.get('target')} | 容差档：exact/strict/pass/warn/fail")
    lines.append(f"- 生成时间：{report.meta.get('timestamp')}\n")
    lines.append("## 聚合\n")
    lines.append(f"- 总记录数：{agg['total']}（可比对 {agg['paired']} 对）")
    lines.append(f"- 各档数量：{agg['counts_by_verdict']}")
    lines.append(f"- 差异归因：{agg.get('counts_by_cause')}")
    lines.append(f"- 平均 MAE（全图）：{agg['avg_mae']} /255")
    lines.append(f"- 平均 MAE（内部区域）：{agg['avg_interior_mae']} /255")
    lines.append(f"- 平均 SSIM：{agg['avg_ssim']:.4f} ｜ 平均 structSSIM：{agg['avg_struct_ssim']:.5f}")
    lines.append(f"- 平均噪声比（内部 mae / JPEG q{report.meta.get('jpeg_quality','92')} 噪声地板）：{agg['avg_noise_ratio']}")
    lines.append(f"- 参考侧被下采样（resized）的配对数：{agg['resized_pairs']}")
    lines.append(f"- 检出「越界填充口径」差异（自研白/爱印黑）的卡：{agg['bounds_white_vs_black']}")
    lines.append(f"- **参考图与官方图按 canvas 参数(q0.92/4:2:0)重编码后逐位相同**：{agg['identical_after_reencode']} / {agg['paired']}\n")
    lines.append("## 最差 10 张（按 verdict→内部 MAE）\n")
    lines.append("| dir | 原图 | idx | verdict | 内部MAE | 边框MAE | maxDiff | SSIM | structSSIM | 噪声× | 备注 |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for r in report.worst(10):
        lines.append(
            f"| {r.dir_tag} | {r.orig_name} | {r.idx} | {r.verdict} | "
            f"{r.interior_mae:.3f} | {r.border_mae:.1f} | {r.max_diff} | {r.ssim:.4f} | "
            f"{r.struct_ssim:.5f} | {r.noise_ratio:.2f} | {r.note} |"
        )
    lines.append(f"\n## 同屏对照图库\n详见 [gallery.html]({gallery_rel})（参考 | 官方 | 差异热力图 三栏并排）。")
    path.write_text("\n".join(lines), encoding="utf-8")


def write_log(lines: List[str], path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")
