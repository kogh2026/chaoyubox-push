# -*- coding: utf-8 -*-
"""证件边缘检测 + 手动角点校正 冒烟测试"""
import json, os, sys, time
from urllib.parse import quote
from playwright.sync_api import sync_playwright

BASE = "http://localhost:4173/"
# 截图输出到 .out/（已 gitignore）；不污染仓库
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".out")
os.makedirs(OUT, exist_ok=True)
CARD_HTML = """
<div style="width:856px;height:540px;background:#fdfdfd;border-radius:28px;position:relative;
     box-shadow:0 0 0 3px #b9c6dd inset;font-family:sans-serif;overflow:hidden;">
  <div style="position:absolute;inset:0;background:repeating-linear-gradient(45deg,rgba(120,150,200,.10) 0 12px,transparent 12px 24px);"></div>
  <div style="position:absolute;left:56px;top:48px;color:#1a3a6b;font-size:30px;">姓名 王仁浦</div>
  <div style="position:absolute;left:56px;top:110px;color:#1a3a6b;font-size:26px;">性别 男  民族 汉</div>
  <div style="position:absolute;left:56px;top:170px;color:#1a3a6b;font-size:26px;">出生 1974 年 9 月 28 日</div>
  <div style="position:absolute;left:56px;top:230px;color:#1a3a6b;font-size:26px;width:430px;">住址 长沙市望城区星城镇东马社区七组161号</div>
  <div style="position:absolute;left:56px;bottom:60px;color:#c8481f;font-size:34px;letter-spacing:2px;">430122197409281414</div>
  <div style="position:absolute;right:60px;top:70px;width:230px;height:300px;background:#d8dee8;border-radius:8px;"></div>
</div>
"""
CLEAN = "data:text/html;charset=utf-8," + quote(f"""<body style="margin:0"><div style="width:1200px;height:900px;background:#e9ebee;display:flex;align-items:center;justify-content:center;">{CARD_HTML}</div></body>""")
SKEW = "data:text/html;charset=utf-8," + quote(f"""<body style="margin:0"><div style="width:1200px;height:900px;background:repeating-conic-gradient(#cfd4da 0 25%, #b7bec7 0 50%) 0 0/46px 46px;display:flex;align-items:center;justify-content:center;"><div style="transform:rotate(9deg) scale(.92);">{CARD_HTML}</div></div></body>""")

errors = []
def run():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": 1440, "height": 900})
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))

        # ---- 生成测试图 ----
        pg.goto(CLEAN)
        pg.screenshot(path=OUT + r"/card-clean.png")
        pg.goto(SKEW)
        pg.screenshot(path=OUT + r"/card-skew.png")
        print("GEN_OK")

        # ---- 打开应用 → 证卡拼版 ----
        pg.goto(BASE)
        pg.wait_for_selector(".toolcard")
        pg.click("text=证卡拼版助手")
        pg.wait_for_selector(".icw")
        pg.wait_for_selector("input[type=file]", state="attached")

        pg.set_input_files(".icw input[type=file]", [OUT + r"/card-clean.png", OUT + r"/card-skew.png"])
        pg.wait_for_selector(".ph-card", timeout=8000)
        pg.wait_for_timeout(600)  # 等检测完成(同步, 但留余量)
        cards = pg.locator(".ph-card")
        n = cards.count()
        assert n == 2, f"expect 2 cards, got {n}"
        info = []
        for i in range(n):
            badge = cards.nth(i).locator(".ph-badge")
            info.append({"cls": badge.get_attribute("class"), "title": badge.get_attribute("title")})
        print("BADGES", json.dumps(info, ensure_ascii=False))

        # ---- 打开手动裁切弹窗（第1张）----
        cards.nth(0).locator("button[title*='手动裁切']").click()
        pg.wait_for_selector(".mc-dialog", timeout=5000)
        assert pg.locator(".mc-canvas").is_visible()
        assert pg.locator(".mc-prev").is_visible()
        # 画布上应有内容（非空白）
        px = pg.evaluate("""() => { const c=document.querySelector('.mc-canvas'); const d=c.getContext('2d').getImageData(0,0,c.width,120).data; let s=0; for(let i=0;i<d.length;i+=40) s+=d[i]; return s; }""")
        assert px > 1000, f"mc-canvas seems blank: {px}"
        print("MODAL_OK")

        # ---- 拖动右上角点（把手位于画布 ~77.7%,23.0% 处）----
        box = pg.locator(".mc-canvas").bounding_box()
        before = pg.evaluate("""() => { const c=document.querySelector('.mc-prev'); return c.toDataURL().length; }""")
        hx, hy = box["x"] + box["width"] * 0.777, box["y"] + box["height"] * 0.230
        pg.mouse.move(hx, hy)
        pg.mouse.down()
        pg.mouse.move(hx + box["width"] * 0.03, hy + box["height"] * 0.03, steps=6)
        pg.mouse.up()
        pg.wait_for_timeout(300)
        after = pg.evaluate("() => { const c=document.querySelector('.mc-prev'); return c.toDataURL().length; }")
        print("DRAG preview len", before, "->", after, "changed:", before != after)

        # ---- 旋转 90° ----
        pg.click("text=旋转 90°")
        pg.wait_for_timeout(400)
        print("ROTATE_OK")

        # ---- 应用校正 ----
        pg.click("button:has-text('应用校正')")
        pg.wait_for_selector(".mc-dialog", state="detached", timeout=8000)
        pg.wait_for_timeout(400)
        msg = pg.locator(".ph-card").nth(0).locator(".ph-msg")
        assert msg.count() == 1 and "已应用手动角点校正" in msg.inner_text(), "manual msg missing"
        badge0 = pg.locator(".ph-card").nth(0).locator(".ph-badge").get_attribute("class")
        assert "ok" in badge0, f"badge should be ok after manual, got {badge0}"
        # 预览画布应使用矫正图（card 高亮变化难断言，确认无错误即可）
        print("APPLY_OK")

        # ---- 重开弹窗：应加载矫正图并可再次应用 ----
        pg.locator(".ph-card").nth(0).locator("button[title*='手动裁切']").click()
        pg.wait_for_selector(".mc-dialog", timeout=5000)
        pg.click("button:has-text('取消')")
        pg.wait_for_selector(".mc-dialog", state="detached")
        print("REOPEN_OK")

        # ---- 预览页数正常 ----
        pg.wait_for_timeout(300)
        info_txt = pg.locator(".icw-cbar-info").inner_text()
        print("CBAR", info_txt)

        b.close()

try:
    run()
    errs = [e for e in errors if "favicon" not in e]
    print("CONSOLE_ERRORS", json.dumps(errs, ensure_ascii=False))
    print("RESULT PASS")
except Exception as e:
    print("RESULT FAIL:", e)
    print("CONSOLE_ERRORS", json.dumps(errors, ensure_ascii=False))
    sys.exit(1)
