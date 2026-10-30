# -*- coding: utf-8 -*-
"""界面冒烟：多尺寸导出 + 下半身判定面板。

不依赖 Electron（本机 electron 二进制为替身，GUI 起不来），改用静态服务 + 真实 Chromium
加载 vite 构建产物，验证：
  1) 证件照模块能正常渲染，无 console error / pageerror；
  2) 右栏「同时导出尺寸」区渲染 7 个规格，默认只勾当前规格；
  3) 勾第二个规格后，底部文案变为「N 规格 × M 张」；
  4) 人像构图面板出现「下方判定 / 放大填满」两行读数。

产物：.tmp/preview-multisize/*.png + report.json
"""
import json
import os
import threading
import functools
import http.server
import socketserver
from datetime import datetime

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
OUT = os.path.join(ROOT, ".tmp", "preview-multisize")
os.makedirs(OUT, exist_ok=True)

report = {"startedAt": datetime.now().isoformat(timespec="seconds"), "checks": [], "anomalies": []}


def note(name, ok, detail=""):
    report["checks"].append({"name": name, "ok": bool(ok), "detail": str(detail)})
    print(("  [PASS] " if ok else "  [FAIL] ") + name + (("  " + detail) if detail else ""))


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve(directory):
    handler = functools.partial(Quiet, directory=directory)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    httpd.allow_reuse_address = True
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


httpd, port = serve(DIST)
print("serving dist on %d" % port)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("pageerror: %s" % e))
        page.goto("http://127.0.0.1:%d/index.html" % port, wait_until="load")
        page.wait_for_timeout(1500)

        title = page.title()
        note("页面标题", "超誉" in title, title)

        # 进入「证件照批量处理」
        entry = page.get_by_text("证件照批量处理", exact=False).first
        entry.click()
        page.wait_for_timeout(1200)
        page.screenshot(path=os.path.join(OUT, "01-idphoto.png"))

        # 1) 多尺寸区渲染
        sizes = page.locator(".idp-size")
        note("同时导出尺寸区渲染", sizes.count() >= 7, "count=%d" % sizes.count())
        checked = page.locator(".idp-size input:checked")
        note("默认只勾当前规格", checked.count() == 1, "checked=%d" % checked.count())

        # 2) 勾第二个规格 → 底部文案变化
        boxes = page.locator(".idp-size input")
        boxes.nth(1).check()
        page.wait_for_timeout(300)
        footer = page.locator(".idp-bottom-l").inner_text()
        note("底部显示多规格数量", "规格" in footer, footer.replace("\n", " | ")[:120])
        page.screenshot(path=os.path.join(OUT, "02-multisize.png"), clip=None)

        # 3) 构图面板的「下方判定 / 放大填满」
        panel = page.locator(".idp-right").inner_text()
        note("面板含下方判定", "下方判定" in panel)
        note("面板含放大填满", "放大填满" in panel)

        # 4) 连续取消，保证至少留一个
        for _ in range(3):
            cur = page.locator(".idp-size input:checked")
            if cur.count() == 0:
                break
            try:
                cur.first.uncheck()
            except Exception:
                break
            page.wait_for_timeout(150)
        still = page.locator(".idp-size input:checked").count()
        note("至少保留一个规格", still >= 1, "checked=%d" % still)

        note("控制台无错误", len(errors) == 0, "; ".join(errors[:3]))
        page.screenshot(path=os.path.join(OUT, "03-final.png"))
        browser.close()
except Exception as exc:  # 任何异常都落报告，便于定位
    note("脚本执行", False, repr(exc))
finally:
    httpd.shutdown()

ok = all(c["ok"] for c in report["checks"])
report["ok"] = ok
with open(os.path.join(OUT, "report.json"), "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print("\n%s" % ("PREVIEW_OK" if ok else "PREVIEW_FAILED"))
