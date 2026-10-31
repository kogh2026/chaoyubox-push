# -*- coding: utf-8 -*-
"""前后版本回归基准：对正面+反面合计 N 张真实证件照，分别在修改前(pre-fix)与
修改后(post-fix)构建产物上运行，导出每张校正卡的裁剪图(data URL PNG)与指标，
供像素级 diff 定位回归。

与 bench_card_model.py 的区别：
  - 支持 --dist 指定要服务的构建产物目录（便于对比 pre-fix / post-fix 两个构建）
  - 支持 --dir 多次传入（默认 正面+反面 两个目录一起）
  - 支持 --dump DIR 把每张校正卡裁剪图落盘，便于 pre/post 像素级对比

用法：
  python tools/bench_regress.py --dist dist --dir "D:/50/身份证正面" --dir "D:/50/身份证反面" --dump .tmp/regress/post
  python tools/bench_regress.py --dist .tmp/dist-prefix --dir "D:/50/身份证正面" --dir "D:/50/身份证反面" --dump .tmp/regress/pre
"""
from __future__ import annotations

import argparse
import base64
import functools
import http.server
import json
import re
import socketserver
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "resources"
OUT = ROOT / ".tmp" / "bench-regress"
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


def _safe(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]', "_", name)[:120]


def collect_items(pg, dump_dir: Path | None, tag: str) -> list[dict]:
    raw = pg.evaluate(
        """() => [...document.querySelectorAll('.ph-card')].map((c, idx) => {
          const badge = c.querySelector('.ph-badge');
          const img = c.querySelector('.ph-imgbox img');
          const conf = badge && badge.title ? parseInt(badge.title.replace(/[^0-9]/g, ''), 10) : null;
          return {
            idx,
            name: img ? (img.alt || '') : '',
            badge: badge ? badge.textContent.trim() : '',
            conf: Number.isFinite(conf) ? conf : null,
            w: img ? img.naturalWidth : 0,
            h: img ? img.naturalHeight : 0,
            src: img ? img.src : '',
          };
        })"""
    )
    items = []
    for r in raw:
        w, h = r["w"], r["h"]
        a = (w / h) if (w and h) else 0
        dev = round(1 - min(a / TARGET_ASPECT, TARGET_ASPECT / a), 4) if a else None
        it = {**r, "aspect": round(a, 4) if a else None, "dev": dev}
        items.append(it)
        if dump_dir and r["src"].startswith("data:image"):
            try:
                b64 = r["src"].split(",", 1)[1]
                data = base64.b64decode(b64)
                fn = f"{r['idx']:03d}_{_safe(r['name'])}.png"
                (dump_dir / fn).write_bytes(data)
            except Exception:  # noqa: BLE001
                pass
    return items


def import_photos(pg, paths: list[Path]) -> None:
    pg.set_input_files("input[type=file]", [str(p) for p in paths])
    import time
    deadline = time.time() + 1200
    last = -1
    while time.time() < deadline:
        state = pg.evaluate(
            """() => ({
              n: document.querySelectorAll('.ph-card').length,
              em: (document.querySelector('.icw-cbar-info em')||{}).textContent||'',
            })"""
        )
        if state["n"] != last:
            print(f"    进度: {state['n']}/{len(paths)}  em={state['em'][:40]!r}", flush=True)
            last = state["n"]
        if state["n"] >= len(paths) and not any(k in state["em"] for k in ("处理中", "增强识别中")):
            return
        time.sleep(2)
    raise TimeoutError(f"导入超时: {state}")


def run_mode(pg, paths: list[Path], mode: str, dump_base: Path | None, dir_tag: str) -> list[dict]:
    pg.evaluate("() => { const b=[...document.querySelectorAll('.icw-toolbar .btn')].find(x=>x.textContent==='清空'); b&&b.click(); }")
    pg.wait_for_timeout(300)
    chk = pg.locator(".icw-right .chk", has_text="增强模型").locator("input")
    want = "true" if mode == "model" else "false"
    if str(chk.is_checked()).lower() != want:
        chk.click()
        pg.wait_for_timeout(200)
    import_photos(pg, paths)
    pg.wait_for_timeout(500)
    dump_dir = None
    if dump_base:
        dump_dir = dump_base / f"{mode}__{dir_tag}"
        dump_dir.mkdir(parents=True, exist_ok=True)
    return collect_items(pg, dump_dir, f"{mode}__{dir_tag}")


def summarize(items: list[dict]) -> dict:
    n = len(items)
    badges: dict[str, int] = {}
    confs = [i["conf"] for i in items if i["conf"] is not None]
    devs = [i["dev"] for i in items if i["dev"] is not None]
    for i in items:
        badges[i["badge"]] = badges.get(i["badge"], 0) + 1
    return {
        "items": n,
        "badges": badges,
        "avgConf": round(sum(confs) / len(confs), 1) if confs else None,
        "aspectMedianDev": round(sorted(devs)[len(devs) // 2], 4) if devs else None,
        "aspectWorst": round(min(devs), 4) if devs else None,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", type=str, default=str(ROOT / "dist"))
    ap.add_argument("--dir", action="append", default=None)
    ap.add_argument("--n", type=int, default=9999)
    ap.add_argument("--mode", choices=["model", "cv", "both"], default="both")
    ap.add_argument("--dump", type=str, default=None)
    args = ap.parse_args()

    dist = Path(args.dist)
    if not (dist / "index.html").exists():
        print(f"[FAIL] 构建产物不存在：{dist}/index.html")
        return 1

    default_dirs = [Path(r"D:\50\身份证正面"), Path(r"D:\50\身份证反面")]
    dirs = [Path(d) for d in args.dir] if args.dir else default_dirs
    dump_base = Path(args.dump) if args.dump else None
    if dump_base:
        dump_base.mkdir(parents=True, exist_ok=True)

    photos_by_dir: list[tuple[str, list[Path]]] = []
    for d in dirs:
        ph = sorted([p for p in d.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".bmp"}])[: args.n]
        tag = d.name
        photos_by_dir.append((tag, ph))
        print(f"dir {tag}: {len(ph)} 张")

    OUT.mkdir(parents=True, exist_ok=True)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(dist)))
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    report: dict = {"dist": str(dist), "dirs": {}}
    ok = True
    with sync_playwright() as p:
        browser = launch_browser(p)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.add_init_script("window.electronAPI = { appResBase: '/res/' };")
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"http://127.0.0.1:{port}/", wait_until="load")
        page.get_by_role("button", name="证卡拼版助手").first.click()
        page.wait_for_selector(".icw-cards", timeout=15000)

        modes = ["model", "cv"] if args.mode == "both" else [args.mode]
        for m in modes:
            print(f"=== mode={m} ===")
            report["dirs"][m] = {}
            for tag, ph in photos_by_dir:
                print(f"--- dir={tag} 导入中（model 约 5s/张）…")
                items = run_mode(page, ph, m, dump_base, tag)
                s = summarize(items)
                report["dirs"][m][tag] = {"summary": s, "items": items}
                print(f"  {tag}: {json.dumps(s, ensure_ascii=False)}")
                if m == "model" and s["items"] == 0:
                    ok = False
        if errors:
            print("pageerrors:", errors[:5])
            ok = False
        browser.close()

    report_path = (dump_base / "report.json") if dump_base else (OUT / "report.json")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("report:", report_path)
    print("BENCH_REGRESS_OK" if ok else "BENCH_REGRESS_FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
