# -*- coding: utf-8 -*-
"""真机探针：设置项跨会话保留 + 恢复默认（可选项 2）。

为什么单独写一个：`verify:export` / `preview_multisize.py` 都用 `chromium.launch()`
（全新临时 profile，localStorage 恒空），所以它们**只能**验证「无存档 → 默认」这一条分支。
本脚本在同一 context 里 reload，才走得到「有存档 → 读回」与「恢复默认 → 清盘」两条路径。

覆盖：
  1) 首次进入：无存档，界面为出厂默认；
  2) 改 4 个字段（规格 / 底色 / 引擎 / 黑白）→ 存档出现，字段与界面一致；
  3) 存档里**没有** exportSizeIds（上次的多选不被继承）；
  4) reload 后 4 个字段全部还原，且「同时导出尺寸」仍只勾 1 个；
  5) 点「恢复默认」→ 先变成「确认恢复？」（两段式），确认后 4 个字段回默认；
  6) 恢复后存档被清空、按钮变灰；
  7) 全程无 console error / pageerror。

产物：.tmp/options-persist/*.png + report.json
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
OUT = os.path.join(ROOT, ".tmp", "options-persist")
os.makedirs(OUT, exist_ok=True)

KEY = "chaoyu.idphoto.options.v1"
report = {"startedAt": datetime.now().isoformat(timespec="seconds"), "checks": []}


def note(name, ok, detail=""):
    report["checks"].append({"name": name, "ok": bool(ok), "detail": str(detail)})
    text = "" if detail == "" else "  " + str(detail)
    print(("  [PASS] " if ok else "  [FAIL] ") + name + text)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    # 「快速」引擎按钮只在 modnet 模型 URL 可用时才渲染（matteEngineUsable）。
    # 无 Electron 时把 /res/** 映射到 resources/**，再注入 electronAPI.appResBase，
    # 面板才会出现两个引擎按钮（与 verify:export 的配方一致）。
    def translate_path(self, path):
        p = path.split("?", 1)[0]
        if p.startswith("/res/"):
            rel = [seg for seg in p[len("/res/"):].split("/") if seg and seg not in (".", "..")]
            return os.path.join(ROOT, "resources", *rel)
        return super().translate_path(path)


def serve(directory):
    handler = functools.partial(Quiet, directory=directory)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    httpd.allow_reuse_address = True
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


def read_store(page):
    raw = page.evaluate("(k) => localStorage.getItem(k)", KEY)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return {"__unparsable__": raw}


def open_idphoto(page, url):
    page.goto(url, wait_until="load")
    page.wait_for_timeout(900)
    page.get_by_text("证件照批量处理", exact=False).first.click()
    page.wait_for_timeout(900)


httpd, port = serve(DIST)
URL = "http://127.0.0.1:%d/index.html" % port
print("serving dist on %d" % port)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        ctx.add_init_script(
            "window.electronAPI = { appResBase: 'http://127.0.0.1:%d/res/' };" % port
        )
        page = ctx.new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("pageerror: %s" % e))

        open_idphoto(page, URL)

        # 1) 首次进入：无存档 + 出厂默认
        note("首次进入无存档", read_store(page) is None)
        preset_sel = page.locator(".idp-right select").first
        note("初始规格为 1 寸", preset_sel.input_value() == "1cun", preset_sel.input_value())
        note(
            "顶部提示「设置会自动保留」",
            "设置会自动保留" in page.locator(".idp-right").inner_text(),
        )
        reset_btn = page.locator(".idp-right-h button")
        note("默认档下「恢复默认」按钮不可点", reset_btn.is_disabled())

        # 2) 改 4 个字段：规格 / 底色 / 引擎 / 黑白
        preset_sel.select_option("2cun")
        page.locator('.idp-swatch[title="蓝底"]').click()
        page.locator(".seg-btn", has_text="精细").click()  # 默认已是快速，改精细才算「改动过」
        page.locator("label", has_text="黑白照片").locator("input").check()
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(OUT, "01-changed.png"))

        store = read_store(page) or {}
        note("改动后存档已写入", bool(store), "keys=%s" % sorted(store.keys())[:6])
        note("存档 presetId=2cun", store.get("presetId") == "2cun", store.get("presetId"))
        note("存档 bgId=blue", store.get("bgId") == "blue", store.get("bgId"))
        note("存档 engine=isnet", store.get("engine") == "isnet", store.get("engine"))
        note("存档 monoOn=true", store.get("monoOn") is True, store.get("monoOn"))
        note("存档带 schemaVersion", store.get("schemaVersion") == 2, store.get("schemaVersion"))

        # 3) 不落盘字段
        note("存档不含 exportSizeIds", "exportSizeIds" not in store, str("exportSizeIds" in store))

        # 4) reload（同一 context，localStorage 保留）→ 4 个字段应全部还原
        open_idphoto(page, URL)
        preset_sel = page.locator(".idp-right select").first
        note("重启后规格仍为 2 寸", preset_sel.input_value() == "2cun", preset_sel.input_value())
        note(
            "重启后底色仍为蓝底",
            "on" in (page.locator('.idp-swatch[title="蓝底"]').get_attribute("class") or ""),
            page.locator('.idp-swatch[title="蓝底"]').get_attribute("class"),
        )
        note(
            "重启后引擎仍为精细",
            "active" in (page.locator(".seg-btn", has_text="精细").get_attribute("class") or ""),
            page.locator(".seg-btn", has_text="精细").get_attribute("class"),
        )
        note(
            "重启后黑白照片仍勾选",
            page.locator("label", has_text="黑白照片").locator("input").is_checked(),
        )
        note(
            "重启后导出尺寸仍只勾当前规格",
            page.locator(".idp-size input:checked").count() == 1,
            "checked=%d" % page.locator(".idp-size input:checked").count(),
        )
        page.screenshot(path=os.path.join(OUT, "02-after-reload.png"))

        # 5) 恢复默认：两段式确认
        reset_btn = page.locator(".idp-right-h button")
        note("非默认时按钮可点", reset_btn.is_enabled())
        reset_btn.click()
        page.wait_for_timeout(200)
        label = page.locator(".idp-right-h button").inner_text()
        note("首次点击进入确认态（不直接生效）", "确认" in label, label)
        note("确认态下设置尚未改变", preset_sel.input_value() == "2cun", preset_sel.input_value())
        page.locator(".idp-right-h button").click()
        page.wait_for_timeout(500)
        page.screenshot(path=os.path.join(OUT, "03-after-reset.png"))

        # 6) 恢复后：字段回默认 + 存档清空 + 按钮变灰
        note("恢复后规格回 1 寸", preset_sel.input_value() == "1cun", preset_sel.input_value())
        note(
            "恢复后底色回白底",
            "on" in (page.locator('.idp-swatch[title="白底"]').get_attribute("class") or ""),
            page.locator('.idp-swatch[title="白底"]').get_attribute("class"),
        )
        note(
            "恢复后引擎回快速（新默认）",
            "active" in (page.locator(".seg-btn", has_text="快速").get_attribute("class") or ""),
            page.locator(".seg-btn", has_text="快速").get_attribute("class"),
        )
        note(
            "恢复后黑白照片取消勾选",
            not page.locator("label", has_text="黑白照片").locator("input").is_checked(),
        )
        note("恢复后存档被清空", read_store(page) is None, str(read_store(page)))
        note("恢复后按钮重新变灰", page.locator(".idp-right-h button").is_disabled())

        # 7) 恢复默认后 reload 仍是默认（存档确实没被默认值写回）
        open_idphoto(page, URL)
        note(
            "恢复默认后重启仍是默认（存档未被写回）",
            page.locator(".idp-right select").first.input_value() == "1cun"
            and read_store(page) is None,
            str(read_store(page)),
        )

        note("控制台无错误", len(errors) == 0, "; ".join(errors[:3]))
        browser.close()
except Exception as exc:
    note("脚本执行", False, repr(exc))
finally:
    httpd.shutdown()

ok = all(c["ok"] for c in report["checks"])
report["ok"] = ok
with open(os.path.join(OUT, "report.json"), "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print("\n%s" % ("OPTIONS_PERSIST_OK" if ok else "OPTIONS_PERSIST_FAILED"))
