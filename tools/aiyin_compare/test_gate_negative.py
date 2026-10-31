# -*- coding: utf-8 -*-
"""门禁自身的反向自测：确认它**真的会拦**，而不是永远 PASS。

为什么需要：门禁脚本最容易出的事故是"判断写反了/阈值读错了"，此时 CI 一路绿灯，
比没有门禁更危险。这里用构造出来的假报告逐条验证每个检查项都能翻成 FAIL。

跑法：python tools/aiyin_compare/test_gate_negative.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))  # tools/ —— 取 tmproot

import ci_gate  # noqa: E402
from tmproot import scratch  # noqa: E402


def _rec(i: int, verdict: str = "exact", mae: float = 1.0, interior: float = 1.0) -> dict:
    return {"dir_tag": "身份证正面", "orig_name": f"{i:03d}.jpg", "idx": 0,
            "verdict": verdict, "mae": mae, "interior_mae": interior,
            "struct_ssim": 0.999, "gui_verdict": "", "gui_ratio": 0.0,
            "gui_floor_mae": 0.0, "gui_canvas_mae": 0.0}


def _report(recs: list[dict]) -> dict:
    counts: dict[str, int] = {}
    for r in recs:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
    paired = sum(v for k, v in counts.items() if k != "n/a")
    n = max(1, len(recs))
    npair = max(1, paired)
    return {
        "meta": {"official_adapter": "official_model"},
        "aggregate": {
            "total": len(recs), "paired": paired, "counts_by_verdict": counts,
            "counts_by_cause": {},
            "avg_mae": sum(r["mae"] for r in recs) / n,
            "avg_interior_mae": sum(r["interior_mae"] for r in recs[:npair]) / npair,
            "avg_ssim": 0.999, "avg_struct_ssim": 0.9986, "avg_noise_ratio": 1.0,
            "bounds_white_vs_black": 0, "identical_after_reencode": 0, "resized_pairs": 0,
            "gui_checked": 0, "gui_counts_by_verdict": {}, "gui_avg_floor_mae": 0,
            "gui_avg_canvas_mae": 0, "gui_avg_ratio": 0,
        },
        "records": recs,
    }


def _baseline(recs: list[dict]) -> dict:
    return {
        "aggregate": _report(recs)["aggregate"],
        "_records": {ci_gate._card_key(r): {"verdict": r["verdict"], "mae": r["mae"],
                                            "interior_mae": r["interior_mae"],
                                            "struct_ssim": r["struct_ssim"]}
                     for r in recs},
    }


def _names(checks) -> dict:
    return {c.name: c for c in checks}


def main() -> int:
    policy = ci_gate.load_policy()
    bad = 0

    def expect(label: str, checks, name: str, want_ok: bool):
        nonlocal bad
        c = _names(checks).get(name)
        if c is None:
            print(f"  FAIL  {label}: 缺少检查项 {name}")
            bad += 1
            return
        ok = c.ok is want_ok
        if not ok:
            bad += 1
        print(f"  {'PASS' if ok else 'FAIL'}  {label:<38} {name}={c.ok} (want {want_ok}) ｜ {c.detail[:80]}")

    good = [_rec(i) for i in range(20)]
    base = _baseline(good)

    # 1) 全绿报告必须通过
    checks = ci_gate.evaluate(_report(good), policy, base)
    if not all(c.ok or c.skipped for c in checks):
        bad += 1
        print("  FAIL  t_all_green: 全绿报告被判失败")
    else:
        print("  PASS  t_all_green                            全绿 → PASS")

    # 2) 出现 1 张 fail
    recs = [_rec(i) for i in range(19)] + [_rec(19, "fail", 30, 30)]
    expect("t_one_fail", ci_gate.evaluate(_report(recs), policy, base), "no_fail", False)

    # 3) warn 超预算（50% > 8%）
    recs = [_rec(i) for i in range(10)] + [_rec(i, "warn", 20, 20) for i in range(10, 20)]
    expect("t_warn_budget", ci_gate.evaluate(_report(recs), policy, base), "warn_budget", False)

    # 4) 逐卡降档（pass → warn），fail 仍是 0 —— 只有逐卡判定能抓
    base_pw = _baseline([_rec(i, "pass") for i in range(20)])
    recs = [_rec(i, "pass") for i in range(19)] + [_rec(19, "warn", 20, 20)]
    checks = ci_gate.evaluate(_report(recs), policy, base_pw)
    expect("t_per_card_downgrade", checks, "per_card_regression", False)
    expect("t_per_card_downgrade_fail0", checks, "no_fail", True)

    # 5) 整体悄悄变差：全部 exact→pass，MAE 翻 3 倍
    recs = [_rec(i, "pass", 6.0, 6.0) for i in range(20)]
    expect("t_global_drift", ci_gate.evaluate(_report(recs), policy, base), "baseline_drift", False)

    # 6) 测试集缩水（基线里的卡本轮缺失）
    recs = [_rec(i) for i in range(10)]
    expect("t_missing_cards", ci_gate.evaluate(_report(recs), policy, base),
           "no_missing_baseline_cards", False)

    # 7) 配对覆盖率崩（一半 n/a）
    recs = [_rec(i) for i in range(10)] + [_rec(i, "n/a") for i in range(10, 20)]
    expect("t_coverage", ci_gate.evaluate(_report(recs), policy, base), "pairing_coverage", False)

    # 8) GUI 侧出现 gui_fail
    recs = [_rec(i) for i in range(19)] + [_rec(19)]
    recs[19]["gui_verdict"] = "gui_fail"
    rep = _report(recs)
    rep["aggregate"]["gui_checked"] = 20
    rep["aggregate"]["gui_counts_by_verdict"] = {"gui_exact": 19, "gui_fail": 1}
    expect("t_gui_fail", ci_gate.evaluate(rep, policy, base), "gui_no_fail", False)

    # 9) 产物：JUnit / JSON / 汇总都要落地，且失败项进 failure
    tmp = scratch("gate_neg")
    recs = [_rec(i) for i in range(19)] + [_rec(19, "fail", 99, 99)]
    checks = ci_gate.evaluate(_report(recs), policy, base)
    ok = ci_gate.write_gate_result(checks, tmp, {"report": "fake", "baseline": "fake"})
    files_ok = all((tmp / f).exists() for f in ("gate_result.json", "gate_summary.md", "junit.xml"))
    junit_ok = "failure" in (tmp / "junit.xml").read_text(encoding="utf-8")
    payload_ok = json.loads((tmp / "gate_result.json").read_text(encoding="utf-8"))["passed"] is False
    good_artifacts = files_ok and junit_ok and payload_ok and ok is False
    if not good_artifacts:
        bad += 1
    print(f"  {'PASS' if good_artifacts else 'FAIL'}  t_artifacts                          "
          f"files={files_ok} junit_has_failure={junit_ok} passed=False={payload_ok}")

    print(f"\n{'全部反向用例通过（门禁确实会拦）' if bad == 0 else f'{bad} 条反向用例失败'}")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
