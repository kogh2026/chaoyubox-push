# -*- coding: utf-8 -*-
"""最小复现：验证 set_input_files 在隐藏 input 上的行为（1 张 vs 50 张）。"""
import glob
import json
import os
import subprocess
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ELECTRON = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")
PORT = 9371
files = sorted(glob.glob(os.path.join(ROOT, ".tmp", "bench50", "*.jpg")))

env = dict(os.environ)
env.pop("ELECTRON_RUN_AS_NODE", None)
proc = subprocess.Popen([ELECTRON, ".", "--remote-debugging-port=%d" % PORT], cwd=ROOT, env=env,
                        stdout=open(os.path.join(ROOT, ".tmp", "probe.log"), "wb"), stderr=subprocess.STDOUT)
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
        pg.wait_for_selector(".toolcard", timeout=30000)
        pg.locator(".toolcard", has_text="证件照批量处理").first.click()
        pg.wait_for_selector(".idp", timeout=20000)
        print("inputs:", pg.evaluate("() => [...document.querySelectorAll('.idp input[type=file]')].map(i=>({accept:i.accept, hidden:i.hidden, cls:i.className}))"))
        for sel in ['input[type=file][accept="image/*"]', '.idp input[type=file][accept="image/*"]']:
            try:
                t = time.time()
                h = pg.query_selector(sel)
                h.set_input_files(files[:1], timeout=8000)
                print("OK 1 file via", sel, "%.1fs" % (time.time() - t), "cards=%d" % pg.locator(".idp-card").count())
                break
            except Exception as e:
                print("FAIL", sel, str(e)[:200])
        try:
            t = time.time()
            pg.query_selector('input[type=file][accept="image/*"]').set_input_files(files, timeout=60000)
            print("OK %d files %.1fs" % (len(files), time.time() - t), "cards=%d" % pg.locator(".idp-card").count())
        except Exception as e:
            print("FAIL 50 files", str(e)[:300], "cards=%d" % pg.locator(".idp-card").count())
        br.close()
finally:
    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, timeout=25)
