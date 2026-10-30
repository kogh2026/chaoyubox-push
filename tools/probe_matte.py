# -*- coding: utf-8 -*-
"""单张抠图诊断：实时打印渲染进程 console / 页面异常，定位抠图链路卡在哪一步。"""
import glob
import json
import os
import subprocess
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ELECTRON = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")
PORT = 9381
files = sorted(glob.glob(os.path.join(ROOT, ".tmp", "bench50", "*.jpg")))[:1]

env = dict(os.environ)
env.pop("ELECTRON_RUN_AS_NODE", None)
proc = subprocess.Popen([ELECTRON, ".", "--remote-debugging-port=%d" % PORT], cwd=ROOT, env=env,
                        stdout=open(os.path.join(ROOT, ".tmp", "probe2.log"), "wb"), stderr=subprocess.STDOUT)
try:
    from playwright.sync_api import sync_playwright
    deadline = time.time() + 40
    while time.time() < deadline:
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            if json.loads(opener.open("http://127.0.0.1:%d/json/list" % PORT, timeout=2).read()):
                break
        except Exception:
            time.sleep(0.4)
    with sync_playwright() as pw:
        br = pw.chromium.connect_over_cdp("http://127.0.0.1:%d" % PORT)
        pg = [p for p in br.contexts[0].pages if "index.html" in (p.url or "")][0]
        pg.on("console", lambda m: print("[console.%s] %s" % (m.type, m.text[:400]), flush=True))
        pg.on("pageerror", lambda e: print("[pageerror] %s" % str(e)[:600], flush=True))
        pg.on("worker", lambda w: print("[worker created] %s" % w.url, flush=True))
        pg.wait_for_selector(".toolcard", timeout=30000)
        pg.locator(".toolcard", has_text="证件照批量处理").first.click()
        pg.wait_for_selector(".idp", timeout=20000)
        t0 = time.time()
        pg.query_selector('input[type=file][accept="image/*"]').set_input_files(files, timeout=120000)
        for _ in range(60):
            st = pg.evaluate("() => ({cards: document.querySelectorAll('.idp-card').length, done: document.querySelectorAll('.idp-badge.done').length, err: document.querySelectorAll('.idp-badge.err').length, imgs: document.querySelectorAll('.idp-left img[data-done="1"]').length, prog: (document.querySelector('.progress-text')||{}).textContent || ''})")
            print("%5.1fs %s" % (time.time() - t0, st), flush=True)
            if st["imgs"] > 0 or st["err"] > 0:
                break
            time.sleep(2)
        pg.screenshot(path=os.path.join(ROOT, ".tmp", "probe2.png"))
        br.close()
finally:
    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, timeout=25)
