# -*- coding: utf-8 -*-
"""可视化：生成"同屏对照" HTML 图库。

每张卡一行三栏：参考(自研) | 官方(爱印) | 差异热力图，并标注 verdict 与指标。
顶部汇总 + 按 verdict 过滤（前端 JS）。这是"在同一视图中并排呈现"的落地形式。
"""
from __future__ import annotations

import os
from pathlib import Path

from lib_report import RunReport, CardRecord

_VERDICT_COLOR = {
    "exact": "#2e7d32", "strict": "#388e3c", "pass": "#1976d2",
    "warn": "#f9a825", "fail": "#c62828", "n/a": "#757575",
}


def build_gallery(report: RunReport, out_path: Path, side_by_side_dir: Path):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    base = out_path.parent
    cards_html = []
    for r in report.records:
        if not r.side_by_side:
            continue
        col = _VERDICT_COLOR.get(r.verdict, "#757575")
        # gallery.html 与 side_by_side/ 同级，用相对路径才能在预览面板里正常显示
        try:
            rel = Path(os.path.relpath(Path(r.side_by_side).resolve(), base)).as_posix()
        except Exception:  # noqa: BLE001
            rel = Path(r.side_by_side).as_posix()
        cards_html.append(f"""
    <div class="card" data-verdict="{r.verdict}">
      <div class="head">
        <span class="badge" style="background:{col}">{r.verdict}</span>
        <span class="meta">{r.dir_tag} / {r.orig_name} #{r.idx}</span>
        <span class="metric">内MAE {r.interior_mae:.2f} · 边{r.border_mae:.0f} · max {r.max_diff} · structSSIM {r.struct_ssim:.5f} · 噪声×{r.noise_ratio:.2f}</span>
      </div>
      <img src="{rel}" loading="lazy" />
      <div class="note">{r.note}</div>
    </div>""")

    filters = "".join(
        f'<button onclick="filterV(\'{k}\')">{k}</button>' for k in
        ["all", "exact", "strict", "pass", "warn", "fail"]
    )

    html = f"""<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>爱印官方 vs 自研 像素级同屏对照</title>
<style>
  body {{ font-family: system-ui, "Microsoft YaHei", sans-serif; background:#111; color:#eee; margin:0; padding:16px; }}
  h1 {{ font-size:18px; }} 
  .toolbar {{ margin:12px 0; }}
  .toolbar button {{ background:#222; color:#eee; border:1px solid #444; padding:6px 12px; margin-right:6px; cursor:pointer; border-radius:4px; }}
  .summary {{ font-size:13px; color:#aaa; margin-bottom:8px; }}
  .card {{ background:#1a1a1a; border:1px solid #333; border-radius:8px; margin:12px 0; overflow:hidden; }}
  .card .head {{ padding:8px 12px; display:flex; align-items:center; gap:12px; flex-wrap:wrap; font-size:13px; }}
  .badge {{ color:#fff; padding:2px 8px; border-radius:10px; font-size:12px; font-weight:600; }}
  .metric {{ color:#9ad; margin-left:auto; font-family:monospace; font-size:12px; }}
  .note {{ padding:4px 12px 10px; color:#f99; font-size:12px; }}
  .card img {{ width:100%; display:block; }}
</style>
</head>
<body>
<h1>爱印官方(爱印) vs 自研(CardLayout/cardCorrectMl) 像素级同屏对照</h1>
<div class="summary" id="summary"></div>
<div class="toolbar">{filters}</div>
<div id="cards">{''.join(cards_html)}</div>
<script>
  function refreshSummary() {{
    const cards = [...document.querySelectorAll('.card')];
    const vis = cards.filter(c => c.style.display !== 'none');
    const byV = {{}};
    vis.forEach(c => {{ const v=c.dataset.verdict; byV[v]=(byV[v]||0)+1; }});
    document.getElementById('summary').textContent =
      `显示 ${{vis.length}} / ${{cards.length}} 张 · ` + Object.entries(byV).map(([k,n])=>`${{k}}:${{n}}`).join('  ');
  }}
  function filterV(v) {{
    document.querySelectorAll('.card').forEach(c => {{
      c.style.display = (v==='all' || c.dataset.verdict===v) ? '' : 'none';
    }});
    refreshSummary();
  }}
  refreshSummary();
</script>
</body>
</html>"""
    out_path.write_text(html, encoding="utf-8")
    return out_path
