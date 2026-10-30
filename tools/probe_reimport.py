# -*- coding: utf-8 -*-
"""最小探针：模型导入→清空→关开关→再次 set_input_files，change 是否触发？
区分「应用真 bug」与「harness 伪影」。输出 PROBE 结论。"""
from __future__ import annotations

import functools
import http.server
import socketserver
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
RES = ROOT / "resources"
PHOTOS = sorted(Path(r"D:\50\身份证正面").glob("*.jpg"))[:2]
EDGE = Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def translate_path(self, path):
        if path.startswith("/res/"):
            return str(RES / path[len("/res/"):].split("?")[0])
        return super().translate_path(path)


def main() -> int:
    httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(DIST)))
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=str(EDGE))
        pg = browser.new_page(viewport={"width": 1440, "height": 900})
        logs: list[str] = []
        pg.on("console", lambda m: logs.append(m.text))
        pg.on("pageerror", lambda e: logs.append("PAGEERROR " + str(e)))
        pg.add_init_script("window.electronAPI = { appResBase: '/res/' };")
        pg.goto(f"http://127.0.0.1:{port}/", wait_until="load")
        pg.get_by_role("button", name="证卡拼版助手").first.click()
        pg.wait_for_selector(".icw-cards", timeout=15000)

        # 给 input 挂 change 侦听
        pg.evaluate(
            "() => { const i = document.querySelector('input[type=file]');"
            " window.__inp = i;"
            " i.addEventListener('change', () => { window.__change = (window.__change||0)+1;"
            "  console.log('CHANGE fired, files=' + i.files.length); }); }"
        )

        def set_files():
            pg.set_input_files("input[type=file]", [str(x) for x in PHOTOS])
            pg.wait_for_timeout(400)

        # 1) 第一次导入（模型默认开）
        set_files()
        pg.wait_for_function("() => document.querySelectorAll('.ph-card').length >= 2", timeout=120_000)
        print("第一次导入 OK，items=2, __change =", pg.evaluate("() => window.__change||0"))

        # 2) 清空 + 关开关
        pg.evaluate("() => { [...document.querySelectorAll('.icw-toolbar .btn')].find(x=>x.textContent==='清空').click(); }")
        pg.wait_for_timeout(300)
        pg.locator(".icw-right .chk", has_text="增强模型").locator("input").click()
        pg.wait_for_timeout(300)
        print("清空+关开关后: __change =", pg.evaluate("() => window.__change||0"),
              "checked =", pg.evaluate("() => document.querySelector('.icw-right .chk input').checked"))

        # 3) 再次 set_input_files
        set_files()
        pg.wait_for_timeout(3000)
        n = pg.evaluate("() => document.querySelectorAll('.ph-card').length")
        ch = pg.evaluate("() => window.__change||0")
        print("第二次导入后: items =", n, "__change =", ch)
        print("console 尾部:", logs[-6:])
        browser.close()
        print("PROBE_RESULT items=%d change=%d" % (n, ch))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
