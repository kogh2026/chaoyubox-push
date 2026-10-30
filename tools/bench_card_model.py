# -*- coding: utf-8 -*-
"""卡证识别真机基准：爱印「卡证矫正 FP32」模型路径 vs 经典 CV 路径。

对 D:\\50\\身份证正面 等真实翻拍照片，在同一页面分别以
  --mode model  （增强模型开，默认）
  --mode cv     （增强模型关，回退经典 CV）
导入 N 张照片，统计用户可感知的质量指标：
  - 徽标分布（已校正 / 需检查 / 可导出）
  - 平均置信度（badge title 里的百分比）
  - 校正图长宽比与 85.6:54=1.585 的平均偏差（越接近越好）

用法：
  python tools/bench_card_model.py --n 20 --mode both
输出 BENCH_CARD_MODEL_OK；报告写 .tmp/bench-card-model/report.json。
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import socketserver
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
RES = ROOT / "resources"
OUT = ROOT / ".tmp" / "bench-card-model"
DEFAULT_PHOTOS = Path(r"D:\50\身份证正面")
EDGE = Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
TARGET_ASPECT = 85.6 / 54.0


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def translate_path(self, path):
        if path.startswith("/res/"):
            return str(RES / path[len("/res/"):].split("?")[0])
        return super().translate_path(path)


def launch_browser(p):
    tries = ([{"executable_path": str(EDGE)}] if EDGE.exists() else []) + [{"channel": "msedge"}, {}]
    for kw in tries:
        try:
            return p.chromium.launch(**kw)
        except Exception:  # noqa: BLE001
            continue
    raise RuntimeError("没有可用浏览器")


def collect_items(pg) -> list[dict]:
    return pg.evaluate(
        """() => [...document.querySelectorAll('.ph-card')].map(c => {
          const badge = c.querySelector('.ph-badge');
          const img = c.querySelector('.ph-imgbox img');
          const conf = badge && badge.title ? parseInt(badge.title.replace(/[^0-9]/g, ''), 10) : null;
          return {
            badge: badge ? badge.textContent.trim() : '',
            conf: Number.isFinite(conf) ? conf : null,
            w: img ? img.naturalWidth : 0,
            h: img ? img.naturalHeight : 0,
          };
        })"""
    )


def import_photos(pg, paths: list[Path]) -> None:
    pg.set_input_files("input[type=file]", [str(p) for p in paths])
    # 轮询进度（导入 + 处理中状态），便于诊断慢/卡
    import time
    deadline = time.time() + 900
    last = -1
    while time.time() < deadline:
        state = pg.evaluate(
            """() => ({
              n: document.querySelectorAll('.ph-card').length,
              em: (document.querySelector('.icw-cbar-info em')||{}).textContent||'',
              ocr: (document.querySelector('.ph-ocr-global')||{}).textContent||'',
            })"""
        )
        if state["n"] != last:
            print(f"    进度: {state['n']}/{len(paths)}  em={state['em'][:40]!r} ocr={state['ocr'][:24]!r}", flush=True)
            last = state["n"]
        if state["n"] >= len(paths) and not any(k in state["em"] for k in ("处理中", "增强识别中")):
            return
        time.sleep(2)
    raise TimeoutError(f"导入超时: {state}")


def run_mode(pg, paths: list[Path], mode: str) -> list[dict]:
    pg.evaluate("() => { const b=[...document.querySelectorAll('.icw-toolbar .btn')].find(x=>x.textContent==='清空'); b&&b.click(); }")
    pg.wait_for_timeout(300)
    # 增强模型开关
    chk = pg.locator(".icw-right .chk", has_text="增强模型").locator("input")
    want = "true" if mode == "model" else "false"
    if str(chk.is_checked()).lower() != want:
        chk.click()
        pg.wait_for_timeout(200)
    import_photos(pg, paths)
    pg.wait_for_timeout(500)
    return collect_items(pg)


def summarize(items: list[dict]) -> dict:
    n = len(items)
    badges = {}
    confs = [i["conf"] for i in items if i["conf"] is not None]
    asps = []
    for i in items:
        if i["w"] and i["h"]:
            a = i["w"] / i["h"]
            asps.append(min(a / TARGET_ASPECT, TARGET_ASPECT / a))  # 1.0=完美 85.6:54
    for i in items:
        badges[i["badge"]] = badges.get(i["badge"], 0) + 1
    return {
        "items": n,
        "badges": badges,
        "avgConf": round(sum(confs) / len(confs), 1) if confs else None,
        "aspectMedianDev": round(sorted(asps)[len(asps) // 2], 4) if asps else None,
        "aspectWorst": round(min(asps), 4) if asps else None,
        "aspectDeviations": [round(1 - a, 3) for a in sorted(asps)][:5],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--mode", choices=["model", "cv", "both"], default="both")
    ap.add_argument("--dir", type=str, default=str(DEFAULT_PHOTOS))
    args = ap.parse_args()

    src = Path(args.dir)
    photos = sorted([p for p in src.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".bmp"}])[: args.n]
    if not photos:
        print(f"[FAIL] 目录无照片：{src}")
        return 1
    print(f"photos: {len(photos)} 张来自 {src}")

    OUT.mkdir(parents=True, exist_ok=True)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(DIST)))
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    report: dict = {"dir": str(src), "n": len(photos), "modes": {}}
    ok = True
    with sync_playwright() as p:
        browser = launch_browser(p)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        # 注入资源根：模型/wasm 走 /res/（与打包版 appres:// 等价）
        page.add_init_script("window.electronAPI = { appResBase: '/res/' };")
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"http://127.0.0.1:{port}/", wait_until="load")
        page.get_by_role("button", name="证卡拼版助手").first.click()
        page.wait_for_selector(".icw-cards", timeout=15000)

        modes = ["model", "cv"] if args.mode == "both" else [args.mode]
        for m in modes:
            print(f"--- mode={m} 导入中（模型路径约 4-6s/张）…")
            items = run_mode(page, photos, m)
            s = summarize(items)
            report["modes"][m] = s
            print(f"mode={m}: {json.dumps(s, ensure_ascii=False)}")
            if m == "model" and s["items"] == 0:
                print("  [FAIL] 模型路径一条都没进列表")
                ok = False
            page.screenshot(path=str(OUT / f"mode-{m}.png"))

        if errors:
            print("pageerrors:", errors[:5])
            ok = False
        browser.close()

    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("report:", OUT / "report.json")
    print("BENCH_CARD_MODEL_OK" if ok else "BENCH_CARD_MODEL_FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
