# -*- coding: utf-8 -*-
"""打包产物冒烟：直接运行 win-unpacked/超誉工作台.exe（打包版，app.asar 内为最新 dist），
验证居中参考线 + A/T 快捷键在安装形态下工作正常。

用法：python tools/packaged_smoke_framing.py
"""
import io
import json
import os
import subprocess
import time
import urllib.request
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, ".tmp", "preview-packaged")
PORT = 9366
APP = os.path.join(ROOT, "dist-pkg-current", "win-unpacked", "超誉工作台.exe")
PHOTO = os.path.abspath(os.path.join(ROOT, "..", "compare", "imgs", "0002-01.jpg"))

os.makedirs(OUT, exist_ok=True)
report = {"startedAt": datetime.now().isoformat(timespec="seconds"), "checks": [], "anomalies": []}
shots = []


def note(name, ok, detail=""):
    report["checks"].append({"name": name, "ok": bool(ok), "detail": str(detail)})
    print(("  [PASS] " if ok else "  [FAIL] ") + name + (("  " + detail) if detail else ""))


def shot(pg, name):
    path = os.path.join(OUT, name)
    pg.screenshot(path=path)
    shots.append(path)


env = dict(os.environ)
env.pop("ELECTRON_RUN_AS_NODE", None)
proc = subprocess.Popen(
    [APP, "--remote-debugging-port=%d" % PORT],
    cwd=os.path.dirname(APP), env=env,
    stdout=open(os.path.join(OUT, "packaged.log"), "wb"), stderr=subprocess.STDOUT,
)
print("打包版已启动 pid=%d" % proc.pid)

console_errors = []
page_errors = []
try:
    from playwright.sync_api import sync_playwright

    deadline = time.time() + 30
    pages = None
    while time.time() < deadline and not pages:
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            pages = json.loads(opener.open("http://127.0.0.1:%d/json/list" % PORT, timeout=2).read())
        except Exception:
            time.sleep(0.4)
    if not pages:
        proc.kill()
        raise SystemExit("CDP 未就绪（打包版启动失败？）")

    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp("http://127.0.0.1:%d" % PORT)
        pg = [p for p in browser.contexts[0].pages if "index.html" in (p.url or "")][0]
        pg.set_default_timeout(20000)
        pg.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: page_errors.append(str(e)))

        pg.wait_for_selector(".toolcard", timeout=30000)
        note("打包版应用启动，首页渲染", True)
        shot(pg, "01-packaged-home.png")

        pg.locator(".toolcard", has_text="证件照批量处理").first.click()
        pg.wait_for_selector(".idp", timeout=15000)
        pg.set_input_files('input[type=file][accept="image/*"]', PHOTO)
        pg.wait_for_function("() => document.querySelectorAll('.idp-photo-card img').length > 0", timeout=180000)
        note("抠图+合成（离线资源 resources/res）", True)

        pg.evaluate("() => document.querySelector('.idp-item-x[title*=\"取景微调\"]').click()")
        pg.wait_for_selector(".idp-framing-box", timeout=10000)
        note("取景微调编辑器打开", True)

        box = pg.locator(".idp-framing-box")
        bb = box.bounding_box()
        cx, cy = bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2
        pg.mouse.move(cx, cy)
        pg.mouse.down()
        pg.mouse.move(cx + 30, cy, steps=5)
        pg.wait_for_selector(".idp-guide-layer", timeout=5000)
        pill = pg.locator(".idp-guide-pill").inner_text()
        note("拖动出现参考线与徽标", True, pill)
        shot(pg, "02-packaged-guide.png")
        pg.mouse.move(cx, cy, steps=5)
        pill = pg.locator(".idp-guide-pill").inner_text()
        note("吸附居中 + 绿徽标", pill.startswith("居中"), pill)
        pg.mouse.up()

        pg.keyboard.press("a")
        pg.wait_for_selector(".idp-guide-layer", timeout=3000)
        note("A 键居中（参考线闪现）", True)
        pg.wait_for_function("() => document.querySelectorAll('.idp-guide-layer').length === 0", timeout=2500)

        pg.keyboard.press("t")
        pg.wait_for_selector(".idp-guide-layer", timeout=3000)
        pill = pg.locator(".idp-guide-pill").inner_text()
        note("T 键回正（水平绿徽标）", pill.startswith("水平"), pill)
        shot(pg, "03-packaged-level.png")

        pg.locator(".idp-framing-foot .btn.primary").click()
        pg.wait_for_timeout(1200)
        note("关闭编辑器出图正常", pg.locator(".idp-photo-card img").count() > 0)
        shot(pg, "04-packaged-final.png")

        note("打包版无 JS 异常", len(page_errors) == 0, "; ".join(page_errors[:2]))
        report["consoleErrors"] = console_errors[:10]
        note("打包版控制台无 error", len(console_errors) == 0, "; ".join(console_errors[:2]))
        browser.close()
finally:
    try:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, timeout=20)
    except Exception:
        proc.kill()

report["finishedAt"] = datetime.now().isoformat(timespec="seconds")
report["screenshots"] = shots
with io.open(os.path.join(OUT, "report.json"), "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
ok = sum(1 for c in report["checks"] if c["ok"])
print("\n检查项：%d/%d 通过；异常 %d 条" % (ok, len(report["checks"]), len(report["anomalies"])))
