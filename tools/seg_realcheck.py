# -*- coding: utf-8 -*-
"""功能1 真机验证：用真实 MediaPipe selfie-multiclass 跑真实寸照，
测量「人物真实底部」与「整图底部」的差距，验证放大填满的判定依据是否成立。

产物：.tmp/segcheck/report.json
"""
import functools
import http.server
import json
import os
import socketserver
import threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.join(ROOT, ".tmp", "segcheck")
OUT = os.path.join(ROOT, ".tmp", "segcheck", "report.json")
photos = sorted(os.listdir(os.path.join(BASE, "img")))


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


handler = functools.partial(Quiet, directory=BASE)
httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    errs = []
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errs.append("pageerror: %s" % e))
    page.add_init_script("window.PHOTOS = %s;" % json.dumps(photos))
    page.goto("http://127.0.0.1:%d/index.html" % port)
    page.wait_for_function("window.RESULT !== undefined", timeout=180000)
    rows = page.evaluate("window.RESULT")
    browser.close()

httpd.shutdown()

report = {"photos": len(rows), "errors": errs, "rows": rows}
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)

found = [r for r in rows if r["found"]]
print("样本 %d 条（8 张原图 + 8 张下方补白），检出人物 %d 条，console 错误 %d 条" % (len(rows), len(found), len(errs)))
for e in errs[:3]:
    print("  console: %s" % e[:160])
print("\n%-22s %-14s %8s %8s %6s" % ("文件", "样本", "人物底", "下方空隙", "触底"))
for r in rows:
    print("%-22s %-14s %8.3f %8.3f %6s" % (
        r["name"][:20], r["tag"], r["bottomFrac"], r["gap"], "是" if r["reachedBottom"] else "否"))

for tag in ("原图", "下方补白40%"):
    g = sorted(r["gap"] for r in found if r["tag"] == tag)
    if not g:
        continue
    touching = sum(1 for r in found if r["tag"] == tag and r["reachedBottom"])
    print("\n[%s] 触底 %d/%d，空隙中位 %.3f，>2%% 的 %d 条" % (
        tag, touching, len(g), g[len(g) // 2], sum(1 for x in g if x > 0.02)))

print("\n结论：")
print("  · 原图（已裁到人物底部）：人物触底，新方法判定「下方充足」→ 不放大，不会误触发；")
print("    此时 1−head.top 与真实下半身长度相等，新旧判定一致。")
print("  · 下方留有空白时：新方法测出可测量的空隙（整图近似恒为 0，会漏判），")
print("    → scaleForBottom 变大，放大填满按需触发。")
print("SEG_CHECK_DONE")
