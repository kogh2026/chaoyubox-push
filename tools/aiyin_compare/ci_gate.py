# -*- coding: utf-8 -*-
"""CI 回归门禁：把 harness 的像素级对照结果变成**可阻断合并**的判定。

三种模式
--------
    report     消费已有 report.json，只做策略判定（零依赖，最快）
    full       先跑 bench_regress? → harness → 判定（全链路）
    selfcheck  只跑引擎自测（lib_diff / lib_gui_diff / 移植版等价性），不碰测试图

判定不是"看一眼 counts 里有没有 fail"，而是四层：
    1. 绝对策略：fail 必须为 0；warn 不得超预算；配对覆盖率不得掉
    2. 相对基线：平均内部 MAE / structSSIM / exact 占比 相对 baseline 的漂移上限
    3. 逐卡回退：任何一张卡相对 baseline 的裁决档下降都算回退（warn→fail、pass→warn）
    4. GUI 保真（若跑过 GUI 侧）：gui_fail 必须为 0，覆盖率达标

为什么要有 2/3：只看 fail==0 会漏掉"整体悄悄变差"——比如某个改动让 20 张卡从
exact 掉到 pass，fail 仍然是 0，但质量确实退化了。

退出码（CI 用它阻断合并）
--------
    0  通过
    1  门禁不通过（**阻断合并**）
    2  运行错误（缺少 report/基线、harness 崩溃等）

用法
----
    python tools/aiyin_compare/ci_gate.py --mode report --report .tmp/aiyin_compare/report.json
    python tools/aiyin_compare/ci_gate.py --mode selfcheck
    python tools/aiyin_compare/ci_gate.py --mode full --limit 20 --out .tmp/aiyin_gate
    python tools/aiyin_compare/ci_gate.py --write-baseline --report .tmp/aiyin_compare/report.json
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))

POLICY_PATH = HERE / "gate_policy.json"
BASELINE_PATH = HERE / "baseline.json"

# 裁决档排序：数值越大越好；n/a 视为"未参与"（不参与逐卡回退判定）
RANK = {"fail": 0, "warn": 1, "pass": 2, "strict": 3, "exact": 4, "n/a": -1}


@dataclass
class Check:
    name: str
    ok: bool
    detail: str
    skipped: bool = False
    failures: list = field(default_factory=list)


# ---------------------------------------------------------------- 策略加载
def load_policy(path: Path = POLICY_PATH) -> dict:
    if not path.exists():
        raise FileNotFoundError(f"缺少门禁策略 {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def load_baseline(path: Path = BASELINE_PATH) -> dict | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _card_key(rec: dict) -> str:
    return f"{rec['dir_tag']}|{rec['orig_name']}|{rec['idx']}"


# ---------------------------------------------------------------- 判定
def evaluate(report: dict, policy: dict, baseline: dict | None,
             partial: bool = False) -> list[Check]:
    """按策略判定。partial=True（冒烟/--limit 跑法）时跳过基线相关检查——
    子集必然"缺卡"，拿它比基线只会得到假 FAIL。"""
    agg = report["aggregate"]
    records = report["records"]
    g = policy["gate"]
    checks: list[Check] = []

    paired = agg["paired"]
    counts = agg["counts_by_verdict"]
    n_fail = counts.get("fail", 0)
    n_warn = counts.get("warn", 0)
    paired_safe = max(1, paired)

    # 1) 绝对策略
    checks.append(Check(
        "no_fail", n_fail == 0,
        f"fail={n_fail}（要求 {g['max_fail']}）" if n_fail > g["max_fail"] else f"fail={n_fail} ≤ {g['max_fail']}",
        failures=[_card_key(r) for r in records if r["verdict"] == "fail"],
    ))

    warn_ratio = n_warn / paired_safe
    checks.append(Check(
        "warn_budget", warn_ratio <= g["max_warn_ratio"],
        f"warn {n_warn}/{paired} = {warn_ratio:.1%}（上限 {g['max_warn_ratio']:.0%}）",
        failures=[_card_key(r) for r in records if r["verdict"] == "warn"],
    ))

    coverage = paired / max(1, agg["total"])
    checks.append(Check(
        "pairing_coverage", coverage >= g["min_paired_ratio"],
        f"配对 {paired}/{agg['total']} = {coverage:.1%}（下限 {g['min_paired_ratio']:.0%}）",
        failures=[_card_key(r) for r in records if r["verdict"] == "n/a"],
    ))

    # 2) 相对基线漂移
    drift = g.get("drift", {})
    if partial:
        checks.append(Check("baseline_drift", True, "冒烟跑法（--partial/--limit）：跳过基线漂移判定", skipped=True))
    elif baseline is None:
        checks.append(Check("baseline_drift", True,
                            "无 baseline.json，跳过相对漂移判定（仅用绝对策略）", skipped=True))
    else:
        b = baseline["aggregate"]
        b_rec_all = baseline["_records"]
        problems = []
        d_mae = (agg["avg_interior_mae"] / max(1e-6, b["avg_interior_mae"]))
        lim = drift.get("avg_interior_mae_max_mult", 1.25)
        if d_mae > lim:
            problems.append(f"平均内部 MAE {agg['avg_interior_mae']} 是基线的 {d_mae:.2f}×（上限 {lim}×）")
        d_ssim = agg["avg_struct_ssim"] - b["avg_struct_ssim"]
        lim2 = drift.get("avg_struct_ssim_min_delta", -0.002)
        if d_ssim < lim2:
            problems.append(f"平均 structSSIM 下降 {abs(d_ssim):.5f}（下限 {lim2}）")
        b_exact = sum(1 for r in b_rec_all.values() if r["verdict"] in ("exact", "strict")) \
            / max(1, b.get("paired", 1))
        c_exact = sum(1 for r in records if r["verdict"] in ("exact", "strict")) / paired_safe
        lim3 = drift.get("exact_ratio_min_delta", -0.05)
        if (c_exact - b_exact) < lim3:
            problems.append(f"exact+strict 占比 {c_exact:.1%} 相对基线 {b_exact:.1%} 下降超限（{lim3:+.0%}）")
        checks.append(Check(
            "baseline_drift", not problems,
            "; ".join(problems) if problems else
            f"MAE {d_mae:.2f}× ｜ structSSIM {d_ssim:+.5f} ｜ exact+strict {c_exact:.1%}（基线 {b_exact:.1%}）",
        ))

        # 3) 逐卡回退：任何一张卡的裁决档下降都算回退（pass→warn、warn→fail 同样拦）
        b_rec = baseline["_records"]
        regressed = []
        for r in records:
            k = _card_key(r)
            old = b_rec.get(k)
            if not old or r["verdict"] == "n/a" or old["verdict"] == "n/a":
                continue
            if RANK.get(r["verdict"], 0) < RANK.get(old["verdict"], 0):
                regressed.append(f"{k}: {old['verdict']} → {r['verdict']} "
                                 f"(interior mae {old['interior_mae']:.3f}→{r['interior_mae']:.3f})")
        limit_reg = policy["gate"].get("max_regressed_cards", 0)
        checks.append(Check(
            "per_card_regression", len(regressed) <= limit_reg,
            f"{len(regressed)} 张卡相对基线降档（上限 {limit_reg}）" if regressed else "无逐卡降档",
            failures=regressed,
        ))

        # 一致性：这轮是否漏掉了基线里的卡（测试集被悄悄缩减）
        missing = [k for k in b_rec if k not in {_card_key(r) for r in records}]
        lim4 = policy["gate"].get("max_missing_cards", 0)
        checks.append(Check(
            "no_missing_baseline_cards", len(missing) <= lim4,
            f"本轮缺失基线中的 {len(missing)} 张卡（上限 {lim4}）" if len(missing) > lim4 else "基线卡全部覆盖",
            failures=missing[:50],
        ))

    # 4) GUI 保真
    gc = policy["gate"].get("gui", {})
    gui_checked = agg.get("gui_checked", 0)
    if gc.get("enabled") and gui_checked:
        gcounts = agg.get("gui_counts_by_verdict", {})
        bad = gcounts.get("gui_fail", 0)
        gwarn = gcounts.get("gui_warn", 0)
        checks.append(Check(
            "gui_no_fail", bad <= gc.get("max_gui_fail", 0),
            f"gui_fail={bad}（上限 {gc.get('max_gui_fail', 0)}）",
            failures=[_card_key(r) for r in records if r.get("gui_verdict") == "gui_fail"],
        ))
        gr = gwarn / max(1, gui_checked)
        checks.append(Check(
            "gui_warn_budget", gr <= gc.get("max_gui_warn_ratio", 0.1),
            f"gui_warn {gwarn}/{gui_checked} = {gr:.1%}（上限 {gc.get('max_gui_warn_ratio', 0.1):.0%}）",
        ))
        cov = gui_checked / paired_safe
        checks.append(Check(
            "gui_coverage", cov >= gc.get("min_gui_coverage_ratio", 0.95),
            f"GUI 侧覆盖 {gui_checked}/{paired} = {cov:.1%}（下限 {gc.get('min_gui_coverage_ratio', 0.95):.0%}）",
        ))
    else:
        checks.append(Check("gui_checks", True, "本轮未跑 GUI 侧（official_adapter != official_gui），跳过", skipped=True))

    return checks


# ---------------------------------------------------------------- 输出
def write_gate_result(checks: list[Check], out_dir: Path, meta: dict) -> bool:
    ok = all(c.ok or c.skipped for c in checks)
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "passed": ok,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "meta": meta,
        "checks": [
            {"name": c.name, "ok": c.ok, "skipped": c.skipped, "detail": c.detail,
             "failures": c.failures[:100]}
            for c in checks
        ],
    }
    (out_dir / "gate_result.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = ["# 像素回归门禁", "",
             f"- 结论：**{'PASS' if ok else 'FAIL'}**",
             f"- 时间：{payload['timestamp']}",
             f"- 报告：`{meta.get('report', '-')}` ｜ 基线：`{meta.get('baseline', '-')}`", "",
             "| 检查项 | 结果 | 明细 |", "|---|---|---|"]
    for c in checks:
        mark = "SKIP" if c.skipped else ("PASS" if c.ok else "**FAIL**")
        lines.append(f"| {c.name} | {mark} | {c.detail} |")
    bad = [c for c in checks if not c.ok and not c.skipped]
    if bad:
        lines.append("\n## 失败明细\n")
        for c in bad:
            lines.append(f"### {c.name}")
            for f in c.failures[:20]:
                lines.append(f"- `{f}`")
            lines.append("")
    (out_dir / "gate_summary.md").write_text("\n".join(lines), encoding="utf-8")

    # JUnit：CI 直接当测试报告渲染
    suite = ET.Element("testsuite", name="aiyin-pixel-gate", tests=str(len(checks)),
                       failures=str(len(bad)), skipped=str(sum(1 for c in checks if c.skipped)))
    for c in checks:
        tc = ET.SubElement(suite, "testcase", classname="aiyin_compare.gate", name=c.name,
                           time="0")
        if c.skipped:
            ET.SubElement(tc, "skipped", message=c.detail)
        elif not c.ok:
            el = ET.SubElement(tc, "failure", message=c.detail)
            el.text = "\n".join(str(x) for x in c.failures[:50])
    ET.ElementTree(suite).write(out_dir / "junit.xml", encoding="utf-8", xml_declaration=True)

    # GitHub Actions 注解（PR 里直接显示成错误行）
    for c in bad:
        print(f"::error title=像素门禁 {c.name}::{c.detail}")
        for f in c.failures[:10]:
            print(f"::error title={c.name}::{f}")
    if ok:
        print("::notice title=像素门禁::全部检查通过")
    return ok


def write_baseline(report_path: Path, out: Path = BASELINE_PATH) -> None:
    rep = json.loads(Path(report_path).read_text(encoding="utf-8"))
    payload = {
        "created": time.strftime("%Y-%m-%d %H:%M:%S"),
        "aggregate": rep["aggregate"],
        "_records": {_card_key(r): {"verdict": r["verdict"], "mae": r["mae"],
                                    "interior_mae": r["interior_mae"],
                                    "struct_ssim": r["struct_ssim"]}
                     for r in rep["records"]},
        "meta": rep.get("meta", {}),
    }
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"已写入基线：{out}（{len(payload['_records'])} 张卡）")


# ---------------------------------------------------------------- 模式
def run_selfcheck(out_dir: Path, policy: dict) -> list[Check]:
    """引擎自测：不依赖测试图，秒级，适合每次提交都跑。"""
    checks: list[Check] = []
    py = sys.executable

    def _run(name: str, args: list[str], timeout: int = 900) -> Check:
        t0 = time.time()
        p = subprocess.run([py] + args, capture_output=True, text=True, cwd=str(ROOT),
                           timeout=timeout, encoding="utf-8", errors="replace")
        tail = ((p.stdout or "") + (p.stderr or "")).strip().splitlines()[-3:]
        return Check(name, p.returncode == 0,
                     f"exit={p.returncode} {int(time.time() - t0)}s ｜ " + " / ".join(tail))

    checks.append(_run("unit_lib_diff", [str(HERE / "test_lib_diff.py")]))
    checks.append(_run("unit_lib_gui_diff", [str(HERE / "test_lib_gui_diff.py")]))

    # 移植版等价性：需要 Node + vendor JS + FP32 模型；缺任一则 skip（生产 CI 里应装齐）
    vendor = Path(r"D:/Downloads/2026-10-23-08-38-11/aiyin_decrypted_assets/vendor/id2pdf-card-correction-worker.js")
    model = ROOT / "resources" / "card-model" / "card-correction-fp32.onnx"
    if vendor.exists() and model.exists():
        lim = policy.get("selfcheck", {}).get("parity_limit", 2)
        checks.append(_run("parity_official_model",
                           [str(HERE / "verify_parity.py"), "--limit", str(lim),
                            "--out", str(out_dir / "parity")]))
    else:
        checks.append(Check("parity_official_model", True,
                            f"跳过：vendor worker 或模型缺失（{vendor.exists()=} / {model.exists()=}）",
                            skipped=True))
    return checks


def run_full(args, out_dir: Path) -> Path:
    """跑 harness（可选先重生成参考侧 dump），返回 report.json 路径。"""
    py = sys.executable
    if args.regenerate_reference:
        cmd = [py, str(ROOT / "tools" / "bench_regress.py"), "--dist", args.dist or "dist",
               "--dump", str(ROOT / ".tmp" / "regress" / "post")]
        for d in args.dirs or []:
            cmd += ["--dir", d]
        print("→ 重生成参考侧 dump:", " ".join(cmd))
        subprocess.run(cmd, cwd=str(ROOT), check=True)
    cmd = [py, str(HERE / "harness.py"), "--out", str(out_dir)]
    if args.limit:
        cmd += ["--limit", str(args.limit)]
    if args.official_adapter:
        cmd += ["--official-adapter", args.official_adapter]
    if args.dirs:
        cmd += ["--dirs"] + list(args.dirs)
    if args.gui_css_scale:
        cmd += ["--gui-css-scale", str(args.gui_css_scale)]
    print("→ 跑 harness:", " ".join(cmd))
    subprocess.run(cmd, cwd=str(ROOT), check=True)
    return out_dir / "report.json"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["report", "full", "selfcheck"], default="report")
    ap.add_argument("--report", default=None, help="report.json 路径（mode=report）")
    ap.add_argument("--out", default=".tmp/aiyin_gate", help="门禁产出目录")
    ap.add_argument("--policy", default=str(POLICY_PATH))
    ap.add_argument("--baseline", default=str(BASELINE_PATH))
    ap.add_argument("--write-baseline", action="store_true", help="把本轮的 report 写成新基线")
    ap.add_argument("--require-baseline", action="store_true",
                    help="CI 用：缺基线直接判失败，而不是降级为只查绝对策略")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dirs", nargs="*", default=None)
    ap.add_argument("--official-adapter", default=None)
    ap.add_argument("--gui-css-scale", type=float, default=0.0)
    ap.add_argument("--regenerate-reference", action="store_true")
    ap.add_argument("--dist", default=None)
    ap.add_argument("--partial", action="store_true",
                    help="冒烟跑法：跳过基线漂移/逐卡回退/缺卡检查（子集必然缺卡，比基线只会假 FAIL）")
    args = ap.parse_args()

    out_dir = (ROOT / args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        policy = load_policy(Path(args.policy))
    except FileNotFoundError as e:
        print(f"[ERROR] {e}")
        return 2

    if args.mode == "selfcheck":
        checks = run_selfcheck(out_dir, policy)
        ok = write_gate_result(checks, out_dir, {"mode": "selfcheck"})
        print(f"\n自测门禁：{'PASS' if ok else 'FAIL'} → {out_dir}")
        return 0 if ok else 1

    report_path = Path(args.report) if args.report else None
    if args.mode == "full":
        try:
            report_path = run_full(args, out_dir)
        except subprocess.CalledProcessError as e:
            print(f"[ERROR] harness 失败：{e}")
            return 2
    if report_path is None:
        report_path = out_dir / "report.json"
    if not Path(report_path).exists():
        print(f"[ERROR] 找不到 report.json：{report_path}（先跑 harness 或改 --report）")
        return 2

    if args.write_baseline:
        write_baseline(Path(report_path), Path(args.baseline))
        return 0

    report = json.loads(Path(report_path).read_text(encoding="utf-8"))
    baseline = load_baseline(Path(args.baseline))
    partial = bool(args.partial or (args.mode == "full" and args.limit > 0))
    if baseline is None and args.require_baseline and not partial:
        print(f"[ERROR] 缺基线 {args.baseline}（--require-baseline 要求必须有基线才能判漂移）")
        return 2

    checks = evaluate(report, policy, baseline, partial=partial)
    ok = write_gate_result(checks, out_dir, {
        "mode": args.mode, "report": str(report_path),
        "baseline": str(args.baseline) if baseline else None,
        "partial": partial,
        "adapter": report.get("meta", {}).get("official_adapter"),
    })
    agg = report["aggregate"]
    print(f"\n门禁结论：{'PASS' if ok else 'FAIL'}")
    print(f"  verdict: {agg['counts_by_verdict']} ｜ paired {agg['paired']}/{agg['total']}")
    print(f"  avg interior MAE {agg['avg_interior_mae']} ｜ structSSIM {agg['avg_struct_ssim']}")
    print(f"  产出：{out_dir}/gate_summary.md, gate_result.json, junit.xml")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
