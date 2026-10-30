# -*- coding: utf-8 -*-
"""诊断：打包版（win-unpacked）里居中参考线是否可用，以及它在什么条件下会“消失”。

对多张照片逐一走：导入 → 抠图 → 打开取景微调 → 拖动 → 检查 .idp-guide-layer 是否出现。
同时探测打包环境里的 appResBase / face 资源可达性 / ORT wasm 可达性。

用法：python tools/diag_guides_packaged.py [dist-pkg-xxx]
"""
import io
import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG = sys.argv[1] if len(sys.argv) > 1 else "dist-pkg-p6"
OUT = os.path.join(ROOT, ".tmp", "diag-guides")
PORT = 9377
APP = os.path.join(ROOT, PKG, "win-unpacked", "超誉工作台.exe")
IMGS = os.path.abspath(os.path.join(ROOT, "..", "compare", "imgs"))
PHOTOS = ["0002-01.jpg", "girl.png", "0003.jpg"]

os.makedirs(OUT, exist_ok=True)
report = {"startedAt": datetime.now().isoformat(timespec="seconds"), "pkg": PKG, "probe": {}, "photos": []}


def fetch_state(pg):
    return pg.evaluate(
        """() => {
      const api = window.electronAPI || {};
      return {
        appResBase: api.appResBase || null,
        hasElectronAPI: !!window.electronAPI,
        ua: navigator.userAgent,
        href: location.href,
        crossOriginIsolated: window.crossOriginIsolated,
      };
    }"""
    )


env = dict(os.environ)
env.pop("ELECTRON_RUN_AS_NODE", None)
proc = subprocess.Popen(
    [APP, "--remote-debugging-port=%d" % PORT],
    cwd=os.path.dirname(APP), env=env,
    stdout=open(os.path.join(OUT, "app.log"), "wb"), stderr=subprocess.STDOUT,
)
print("启动打包版 pid=%d (%s)" % (proc.pid, APP))

console_msgs = []
page_errors = []
try:
    from playwright.sync_api import sync_playwright

    deadline = time.time() + 40
    pages = None
    while time.time() < deadline and not pages:
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            pages = json.loads(opener.open("http://127.0.0.1:%d/json/list" % PORT, timeout=2).read())
        except Exception:
            time.sleep(0.4)
    if not pages:
        raise SystemExit("CDP 未就绪")

    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp("http://127.0.0.1:%d" % PORT)
        pg = [p for p in browser.contexts[0].pages if "index.html" in (p.url or "")][0]
        pg.set_default_timeout(30000)
        pg.on("console", lambda m: console_msgs.append("%s: %s" % (m.type, m.text)))
        pg.on("pageerror", lambda e: page_errors.append(str(e)))

        pg.wait_for_selector(".toolcard")
        report["probe"]["env"] = fetch_state(pg)

        # 资源可达性：直接 fetch 打包内文件（走 appres:// 协议）
        report["probe"]["assets"] = pg.evaluate(
            """async () => {
      const base = (window.electronAPI && window.electronAPI.appResBase) || '';
      const out = {};
      for (const p of ['face/anchors.json', 'face/face_detection_front.onnx', 'ort/ort-wasm-simd-threaded.jsep.wasm', 'matting-model/']) {
        try {
          const r = await fetch(base + p, { method: 'GET' });
          out[p] = r.status + ' ' + (r.headers.get('content-length') || '?');
        } catch (e) { out[p] = 'ERR ' + e.message; }
      }
      return out;
    }"""
        )

        pg.locator(".toolcard", has_text="证件照批量处理").first.click()
        pg.wait_for_selector(".idp")

        for idx, name in enumerate(PHOTOS):
            entry = {"file": name, "steps": []}
            path = os.path.join(IMGS, name)
            if not os.path.exists(path):
                entry["steps"].append({"step": "文件存在", "ok": False})
                report["photos"].append(entry)
                continue
            pg.set_input_files('input[type=file][accept="image/*"]', path)
            pg.wait_for_function(
                "() => document.querySelectorAll('.idp-photo-card img').length > 0", timeout=240000
            )
            pg.wait_for_timeout(1500)
            # 打开取景微调（取最后一张卡 = 刚导入的照片）
            pg.evaluate(
                "() => { const xs = document.querySelectorAll('.idp-item-x[title*=\"取景微调\"]'); xs[xs.length - 1].click(); }"
            )
            pg.wait_for_selector(".idp-framing-box", timeout=15000)
            pg.wait_for_timeout(2500)  # 等 BlazeFace 会话跑完
            onopen = pg.evaluate("() => document.querySelectorAll('.idp-guide-layer').length")
            entry["steps"].append({"step": "打开时无参考线（预期 0）", "value": onopen})

            box = pg.locator(".idp-framing-box")
            bb = box.bounding_box()
            cx, cy = bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2
            pg.mouse.move(cx, cy)
            pg.mouse.down()
            pg.mouse.move(cx + 40, cy, steps=6)
            pg.wait_for_timeout(400)
            drag = pg.evaluate(
                """() => {
          const l = document.querySelector('.idp-guide-layer');
          const pill = document.querySelector('.idp-guide-pill');
          const lines = document.querySelectorAll('.idp-guide-svg line').length;
          return { layer: !!l, lines, pill: pill ? pill.textContent : null };
        }"""
            )
            entry["steps"].append({"step": "拖动中出现参考线", **drag})
            pg.screenshot(path=os.path.join(OUT, "%d-%s-drag.png" % (idx + 1, name.split(".")[0])))
            pg.mouse.up()
            pg.wait_for_timeout(300)

            # 松手后应消失
            after = pg.evaluate("() => document.querySelectorAll('.idp-guide-layer').length")
            entry["steps"].append({"step": "松手后消失（预期 0）", "value": after})

            # 关掉编辑器，回到列表
            pg.locator(".idp-framing-foot .btn.primary").click()
            pg.wait_for_timeout(1200)
            report["photos"].append(entry)
            print(json.dumps(entry, ensure_ascii=False))

        report["consoleErrors"] = [m for m in console_msgs if m.startswith("error")]
        report["consoleWarns"] = [m for m in console_msgs if m.startswith("warning")][:10]
        report["pageErrors"] = page_errors[:5]
        browser.close()
finally:
    try:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, timeout=20)
    except Exception:
        proc.kill()

report["finishedAt"] = datetime.now().isoformat(timespec="seconds")
with io.open(os.path.join(OUT, "report.json"), "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print("\nprobe:", json.dumps(report["probe"], ensure_ascii=False, indent=1))
print("console errors:", report["consoleErrors"][:5])
