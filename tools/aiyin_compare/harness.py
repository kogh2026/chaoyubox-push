# -*- coding: utf-8 -*-
"""编排器 / CLI：把"参考(自研)"与"官方(爱印)"两条侧在身份证测试集上做像素级同屏对照。

用法：
  python tools/aiyin_compare/harness.py                    # config.json 默认（official_worker）
  python tools/aiyin_compare/harness.py --limit 10          # 每目录只取前 10 张做冒烟
  python tools/aiyin_compare/harness.py --official-adapter official_model   # 无 Node 时用 Python 移植版
  python tools/aiyin_compare/harness.py --out .tmp/aiyin_compare_full

流程：
  1) 加载 config.json（图片目录 / 参考 dump / 官方资产 / 容差 / 输出项）。
  2) 参考侧：读 bench_regress.py 落盘的 PNG 裁图（自研方案真实渲染输出）。
  3) 官方侧：把爱印 vendor worker 原文件在 Node 里原样执行（同一份 JS + 同一 FP32 权重）。
  4) 配对：按**内容指纹**（24x24 灰度归一化互相关）贪心匹配，
     避免参考 dump 缺号/官方侧页序差异导致的错配；匹配不上记为结构性差异。
  5) lib_diff 逐卡像素 diff（含 JPEG 噪声地板归因）+ 三栏并排合成；
     lib_viz 出同屏对照 HTML 图库；lib_report 写 JSON / Markdown / 日志。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import lib_diff  # noqa: E402
import lib_report  # noqa: E402
import lib_viz  # noqa: E402
import adapter_reference  # noqa: E402


def _log(lines, msg):
    lines.append(f"[{time.strftime('%H:%M:%S')}] {msg}")
    print(msg)


def load_config(path: Path) -> dict:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def _fingerprint(path: Path, size: int = 24) -> np.ndarray:
    """裁图内容指纹：24x24 灰度，去均值后 L2 归一化。用于跨序号配对。"""
    im = Image.open(path).convert("L").resize((size, size), Image.BILINEAR)
    v = np.asarray(im, dtype=np.float64).ravel()
    v -= v.mean()
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else v


def pair_by_content(ref_items, off_items, min_sim: float = 0.90):
    """贪心配对：每次取全局相似度最高的一对，低于 min_sim 视为不同卡。

    ref_items / off_items: [(idx, Path)]
    返回 (pairs, unmatched_ref, unmatched_off)
    """
    if not ref_items or not off_items:
        return [], list(ref_items), list(off_items)
    rf = [(i, p, _fingerprint(p)) for i, p in ref_items]
    of = [(i, p, _fingerprint(p)) for i, p in off_items]
    sims = []
    for ri, (ridx, rp, rv) in enumerate(rf):
        for oi, (oidx, op, ov) in enumerate(of):
            sims.append((float(np.dot(rv, ov)), ri, oi))
    sims.sort(reverse=True)
    used_r, used_o, pairs = set(), set(), []
    for s, ri, oi in sims:
        if ri in used_r or oi in used_o:
            continue
        if s < min_sim:
            break
        used_r.add(ri)
        used_o.add(oi)
        pairs.append((rf[ri][0], rf[ri][1], of[oi][0], of[oi][1], s))
    pairs.sort(key=lambda x: x[0])
    unmatched_ref = [ (i, p) for k, (i, p) in enumerate(ref_items) if k not in used_r ]
    unmatched_off = [ (i, p) for k, (i, p) in enumerate(off_items) if k not in used_o ]
    return pairs, unmatched_ref, unmatched_off


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(HERE / "config.json"))
    ap.add_argument("--limit", type=int, default=0, help="每目录最多处理多少张（0=全部）")
    ap.add_argument("--official-adapter", default=None, help="覆盖 config.official.adapter")
    ap.add_argument("--reference-adapter", default=None, help="覆盖 config.reference.adapter")
    ap.add_argument("--out", default=None, help="覆盖输出目录")
    ap.add_argument("--dirs", nargs="*", default=None, help="覆盖输入图目录")
    ap.add_argument("--min-sim", type=float, default=0.90, help="内容指纹配对相似度下限")
    ap.add_argument("--reuse-official", action="store_true",
                    help="复用输出目录已有的官方裁图（跳过 Node worker，调试比对逻辑时用）")
    ap.add_argument("--gui-css-scale", type=float, default=1.0,
                    help="official_gui 模式下画布的 CSS 缩放（1.0=1:1 显示，>1 用于验证缩放链路损失）")
    args = ap.parse_args()

    cfg = load_config(Path(args.config))
    official_adapter = args.official_adapter or cfg.get("official", {}).get("adapter", "official_worker")
    reference_adapter = args.reference_adapter or cfg.get("reference", {}).get("adapter", "reference_dumps")
    out_dir = Path(args.out or cfg.get("output", {}).get("dir", ".tmp/aiyin_compare"))
    image_dirs = args.dirs or cfg.get("images", {}).get("dirs", [])
    tol = cfg.get("tolerance", {})
    diff_thr = cfg.get("diff_threshold_per_channel", 8)
    jpeg_q = int(cfg.get("reference", {}).get("jpeg_quality", 92))

    out_dir = Path(out_dir).resolve()
    official_dir = out_dir / "official"
    sbs_dir = out_dir / "side_by_side"
    official_dir.mkdir(parents=True, exist_ok=True)
    sbs_dir.mkdir(parents=True, exist_ok=True)

    log_lines = []
    _log(log_lines, f"official_adapter={official_adapter} reference_adapter={reference_adapter}")

    # ---- 参考侧 ----
    ref = {}
    if reference_adapter == "reference_dumps":
        dumps_dir = ROOT / cfg["reference"]["dumps_dir"]
        mode = cfg["reference"].get("mode", "model")
        ref = adapter_reference.load_reference(dumps_dir, mode)
        _log(log_lines, f"参考侧：从 {dumps_dir} 加载 {len(ref)} 张裁图 (mode={mode})")
    else:
        _log(log_lines, f"未知 reference_adapter: {reference_adapter}")

    # ---- 收集图片清单 ----
    jobs = []  # (tag, orig_name, path)
    for d in image_dirs:
        dpath = Path(d)
        tag = dpath.name
        imgs = sorted([p for p in dpath.iterdir()
                       if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".bmp"}])
        if args.limit:
            imgs = imgs[:args.limit]
        _log(log_lines, f"排队目录 {tag}：{len(imgs)} 张")
        for p in imgs:
            jobs.append((tag, p.name, p))

    # ---- 官方侧（一次性批量，模型只加载一次）----
    off_map: dict[tuple[str, str], list[tuple[int, Path]]] = {}
    gui_map: dict[tuple[str, str], object] = {}      # GUI 截图保真度（仅 official_gui）
    if args.reuse_official:
        stats = {}
        for p in sorted(official_dir.glob("*__p*.png")):
            stem = p.stem
            try:
                head, pidx = stem.rsplit("__p", 1)
                page = int(pidx)
            except ValueError:
                continue
            tag, _, name = head.partition("__")
            off_map.setdefault((tag, name), []).append((page, p))
        for v in off_map.values():
            v.sort(key=lambda x: x[0])
        _log(log_lines, f"官方侧：复用 {sum(len(v) for v in off_map.values())} 张已有裁图（跳过 worker）")
    elif official_adapter == "official_worker":
        import adapter_official_worker as aow
        worker = aow.OfficialWorkerNode(
            cfg["official"]["assets"]["vendor_worker_js"],
            ROOT / cfg["official"]["assets"]["model"],
            cfg["official"].get("max_pages", 2),
            cfg["official"].get("min_area_frac", 0.04),
        )
        entries = [(f"{tag}__{name}", p) for tag, name, p in jobs]
        _log(log_lines, f"官方侧：Node 托管爱印 worker，批量 {len(entries)} 张…")
        t0 = time.time()
        res = worker.run_batch(entries, official_dir, log=lambda m: _log(log_lines, m))
        _log(log_lines, f"官方侧完成：{sum(len(v) for v in res.values())} 张卡，{time.time()-t0:.1f}s")
        for tag, name, _ in jobs:
            key = f"{tag}__{name}"
            off_map[(tag, name)] = [(x["page"], x["png"]) for x in res.get(key, [])]
        # 官方侧结构性统计（页数/passes/room）随报告输出
        stats = worker.last_stats
    elif official_adapter == "official_gui":
        # 真实浏览器路径：worker 跑在真 Web Worker 里，产出画到 canvas，既回读画布也截屏。
        # 官方侧 png 用"画布回读"（无损、权威），截图另行做保真度判定（lib_gui_diff）。
        import adapter_official_gui as aog
        import lib_gui_diff
        gui = aog.OfficialGuiAdapter(
            cfg["official"]["assets"]["vendor_worker_js"],
            ROOT / cfg["official"]["assets"]["model"],
            cfg["official"].get("max_pages", 2),
            cfg["official"].get("min_area_frac", 0.04),
            css_scale=args.gui_css_scale,
        )
        entries = [(f"{tag}__{name}", p) for tag, name, p in jobs]
        _log(log_lines, f"官方侧：Playwright 驱动 chromium 跑 worker，批量 {len(entries)} 张…")
        t0 = time.time()
        res = gui.run_batch(entries, out_dir, log=lambda m: _log(log_lines, m))
        _log(log_lines, f"官方侧(GUI)完成：{sum(len(v) for v in res.values())} 张卡，{time.time() - t0:.1f}s")
        for tag, name, _ in jobs:
            key = f"{tag}__{name}"
            lst = res.get(key, [])
            off_map[(tag, name)] = [(x["page"], x["png"]) for x in lst]
            if lst:
                gm = gui.gui_metrics.get(key, {})
                shot = gm.get("shot_png")
                if shot:
                    gd = lib_gui_diff.compare_gui(Path(shot), Path(lst[0]["png"]), None)
                    lib_gui_diff.make_gui_strip(
                        Path(shot), Path(lst[0]["png"]),
                        sbs_dir / f"{tag}__{name}__p0__gui.png",
                        title=f"{name} {gd.verdict}")
                    gui_map[(tag, name)] = (gd, Path(shot))
        stats = gui.last_stats
    elif official_adapter == "official_model":
        import adapter_official_model as aom
        model_path = ROOT / cfg["official"]["assets"]["model"]
        _log(log_lines, f"官方侧：加载 Python 移植模型 {model_path}")
        wk = aom.OfficialWorker.load(str(model_path))
        stats = {}
        for tag, name, p in jobs:
            try:
                arr = np.asarray(Image.open(p).convert("RGBA"), dtype=np.uint8)
                pages = wk.run_image(arr, cfg["official"].get("max_pages", 2),
                                     cfg["official"].get("min_area_frac", 0.04))
                lst = []
                for j, pg in enumerate(pages):
                    op = official_dir / f"{tag}__{name}__p{j}.png"
                    Image.fromarray(pg["rgb"]).save(op)
                    lst.append((j, op))
                off_map[(tag, name)] = lst
            except Exception as e:  # noqa: BLE001
                _log(log_lines, f"  官方侧失败 {name}: {e}")
                off_map[(tag, name)] = []
    else:
        stats = {}
        _log(log_lines, f"未知 official_adapter: {official_adapter}")

    report = lib_report.RunReport(meta={
        "official_adapter": official_adapter,
        "reference_adapter": reference_adapter,
        "image_dirs": [str(x) for x in image_dirs],
        "target": cfg.get("target", "worker"),
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "tolerance": tol,
        "diff_threshold": diff_thr,
        "jpeg_quality": jpeg_q,
        "gui_css_scale": args.gui_css_scale,
        "official_stats": stats,
    })

    # ---- 配对 + diff ----
    n_imgs = 0
    for tag, name, p in jobs:
        n_imgs += 1
        ref_items = adapter_reference.ref_for_dir(ref, tag, name)
        off_items = off_map.get((tag, name), [])
        pairs, un_ref, un_off = pair_by_content(ref_items, off_items, args.min_sim)

        for ridx, rp, oidx, op, sim in pairs:
            rec = lib_report.CardRecord(dir_tag=tag, orig_name=name, idx=oidx)
            diff = lib_diff.compare(Path(rp), Path(op), tol, diff_thr, jpeg_q)
            sbs = lib_diff.make_side_by_side(
                Path(rp), Path(op), diff, diff_thr,
                sbs_dir / f"{tag}__{name}__p{oidx}.png",
                crop_name=f"{name} #{oidx}")
            rec.ref_path = str(rp); rec.off_path = str(op)
            rec.verdict = diff.verdict; rec.mae = round(diff.mae, 4)
            rec.interior_mae = round(diff.interior_mae, 4)
            rec.border_mae = round(diff.border_mae, 2)
            rec.border_diff_frac = round(diff.border_diff_frac, 4)
            rec.fill_frac = round(diff.fill_frac, 4)
            rec.max_diff = diff.max_diff; rec.p95_diff = round(diff.p95_diff, 3)
            rec.changed_frac = round(diff.changed_frac, 4); rec.ssim = round(diff.ssim, 4)
            rec.struct_ssim = round(diff.struct_ssim, 5)
            rec.noise_mae = round(diff.noise_mae, 4); rec.noise_ratio = round(diff.noise_ratio, 3)
            rec.resized = diff.resized; rec.border_flag = diff.border_flag
            rec.cause = diff.cause
            rec.identical_after_reencode = diff.identical_after_reencode
            rec.reencode_mismatch_px = diff.reencode_mismatch_px
            rec.note = f"指纹相似度 {sim:.4f}; " + "; ".join(diff.notes)
            rec.side_by_side = str(sbs.relative_to(ROOT))
            gpair = gui_map.get((tag, name))
            if gpair is not None:
                gd, shot = gpair
                rec.gui_verdict = gd.verdict
                rec.gui_ratio = round(gd.noise_ratio, 3)
                rec.gui_floor_mae = round(gd.floor_mae, 4)
                rec.gui_canvas_mae = round(gd.canvas_vs_worker_mae, 4)
                rec.gui_shot = str(shot.relative_to(ROOT))
                rec.note += f"; GUI 截图保真 {gd.verdict}（floor {gd.floor_mae:.3f} / ratio {gd.noise_ratio:.2f}）"
            report.records.append(rec)

        for ridx, rp in un_ref:
            rec = lib_report.CardRecord(dir_tag=tag, orig_name=name, idx=ridx)
            rec.verdict = "n/a"; rec.ref_path = str(rp)
            rec.note = "官方侧未产出对应卡（结构性差异：自研有，爱印无）"
            report.records.append(rec)
        for oidx, op in un_off:
            rec = lib_report.CardRecord(dir_tag=tag, orig_name=name, idx=oidx)
            rec.verdict = "n/a"; rec.off_path = str(op)
            rec.note = "参考侧缺失该卡（结构性差异：爱印有，自研无/未落盘）"
            report.records.append(rec)

        _log(log_lines, f"  {name}: 参考 {len(ref_items)} / 官方 {len(off_items)} / 配对 {len(pairs)}")

    # ---- 输出 ----
    lib_report.write_json(report, out_dir / "report.json")
    lib_report.write_markdown(report, out_dir / "summary.md", "gallery.html")
    lib_viz.build_gallery(report, out_dir / "gallery.html", sbs_dir)
    lib_report.write_log(log_lines, out_dir / "run.log")

    agg = report.aggregate()
    _log(log_lines, f"完成：{n_imgs} 张图，{agg['total']} 条记录 -> {agg['counts_by_verdict']}")
    print(f"OUTPUT_DIR={out_dir}")


if __name__ == "__main__":
    main()
