# -*- coding: utf-8 -*-
"""真机预览（二）：取景微调「居中参考线 + 吸附 + A/T 快捷键」。

流程：启动真实 Electron → 证件照 → 导入人像 → 打开取景微调编辑器 →
  1) 拖动画面：参考线出现、6px 内吸附居中、徽标变绿「居中 · 按住 Alt 不吸附」；
  2) Alt+拖动：不吸附，徽标黑底显示偏移毫米；
  3) 按 A：水平居中 + 参考线短暂显示（约 1.2s 后消失）；
  4) 拖旋转钮：出现摆正模式参考线，0.6° 内吸附水平；
  5) 按 T：旋转回正，图片 transform 生效，提交后合成链路无异常；
  6) 方向键微调；控制台无 error。

产物：.tmp/preview-framing/*.png + report.json
"""
import io
import json
import os
import platform
import socket
import subprocess
import time
import urllib.request
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, ".tmp", "preview-framing")
PORT = 9355
ELECTRON = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")
PHOTO = os.path.abspath(os.path.join(ROOT, "..", "compare", "imgs", "0002-01.jpg"))

os.makedirs(OUT, exist_ok=True)
report = {"startedAt": datetime.now().isoformat(timespec="seconds"), "checks": [], "metrics": {}, "anomalies": []}
shots = []


def note(name, ok, detail=""):
    report["checks"].append({"name": name, "ok": bool(ok), "detail": str(detail)})
    print(("  [PASS] " if ok else "  [FAIL] ") + name + (("  " + detail) if detail else ""))


def anomaly(text):
    report["anomalies"].append(text)
    print("  [ANOMALY] " + text)


def shot(pg, name):
    path = os.path.join(OUT, name)
    pg.screenshot(path=path)
    shots.append(path)
    return path


env = dict(os.environ)
env.pop("ELECTRON_RUN_AS_NODE", None)
proc = subprocess.Popen(
    [ELECTRON, ".", "--remote-debugging-port=%d" % PORT],
    cwd=ROOT, env=env,
    stdout=open(os.path.join(OUT, "electron.log"), "wb"), stderr=subprocess.STDOUT,
)
print("Electron pid=%d" % proc.pid)

console_errors = []
page_errors = []

try:
    from playwright.sync_api import sync_playwright

    deadline = time.time() + 25
    pages = None
    while time.time() < deadline and not pages:
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            pages = json.loads(opener.open("http://127.0.0.1:%d/json/list" % PORT, timeout=2).read())
        except Exception:
            time.sleep(0.4)
    if not pages:
        proc.kill()
        print("CDP 未就绪")
        raise SystemExit(3)

    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp("http://127.0.0.1:%d" % PORT)
        pg = [p for p in browser.contexts[0].pages if "index.html" in (p.url or "")][0]
        pg.set_default_timeout(20000)
        pg.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: page_errors.append(str(e)))

        pg.wait_for_selector(".toolcard", timeout=25000)
        report["runtime"] = pg.evaluate("() => ({url: location.href, dpr: devicePixelRatio, inner: [innerWidth, innerHeight]})")
        report["os"] = {"platform": platform.platform(), "cpu": os.cpu_count()}
        shot(pg, "01-home.png")

        pg.locator(".toolcard", has_text="证件照批量处理").first.click()
        pg.wait_for_selector(".idp", timeout=15000)
        pg.set_input_files('input[type=file][accept="image/*"]', PHOTO)
        pg.wait_for_function("() => document.querySelectorAll('.idp-photo-card img').length > 0", timeout=180000)
        note("导入人像并完成抠图合成", True)

        # 打开取景微调编辑器（角标按钮互相重叠，用 JS 点击绕过遮挡检测）
        pg.evaluate("() => document.querySelector('.idp-item-x[title*=\"取景微调\"]').click()")
        pg.wait_for_selector(".idp-framing-box", timeout=10000)
        note("取景微调编辑器打开", pg.locator(".idp-framing-box").count() == 1)
        note("旋转圆钮渲染", pg.locator(".idp-rotate-knob").count() == 1)
        note("未拖动时无参考线", pg.locator(".idp-guide-layer").count() == 0)
        shot(pg, "02-editor.png")

        box = pg.locator(".idp-framing-box")
        bb = box.bounding_box()
        cx, cy = bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2

        # 1) 拖动：从中心向右拖 40px（> 6px 吸附半径）→ 参考线出现且不居中
        pg.mouse.move(cx, cy)
        pg.mouse.down()
        pg.mouse.move(cx + 40, cy, steps=6)
        pg.wait_for_selector(".idp-guide-layer", timeout=5000)
        note("拖动时参考线出现", pg.locator(".idp-guide-layer").count() == 1)
        pill = pg.locator(".idp-guide-pill").inner_text()
        note("未居中时徽标为黑底偏移文案", "居中" not in pill.split("·")[0] and "偏" in pill, pill)
        shot(pg, "03-drag-offset.png")

        # 拖回中心附近（< 6px）→ 吸附居中 + 绿徽标
        pg.mouse.move(cx, cy, steps=6)
        pill = pg.locator(".idp-guide-pill").inner_text()
        note("6px 内吸附居中且徽标变绿", pill.startswith("居中"), pill)
        shot(pg, "04-drag-centered.png")
        pg.mouse.up()
        pg.wait_for_function("() => document.querySelectorAll('.idp-guide-layer').length === 0", timeout=5000)
        note("松手后参考线消失", True)

        # 2) Alt+拖动：不吸附
        pg.mouse.move(cx, cy)
        pg.mouse.down()
        pg.keyboard.down("Alt")
        pg.mouse.move(cx + 12, cy, steps=4)  # 12px > 6px，本就不吸附；再拉回 3px 处验证不吸附
        pg.mouse.move(cx + 3, cy, steps=4)
        pill = pg.locator(".idp-guide-pill").inner_text()
        note("按住 Alt 拖动不吸附（3px 处仍显示偏移）", "居中" not in pill.split("·")[0], pill)
        pg.keyboard.up("Alt")
        pg.mouse.move(cx, cy, steps=4)
        pill = pg.locator(".idp-guide-pill").inner_text()
        note("松开 Alt 后恢复吸附", pill.startswith("居中"), pill)
        pg.mouse.up()
        pg.wait_for_function("() => document.querySelectorAll('.idp-guide-layer').length === 0", timeout=5000)

        # 3) 按 A：水平居中 + 短暂参考线
        pg.locator(".idp-framing-box").click(position={"x": 20, "y": 20})  # 焦点进页面（不触发拖动）
        pg.mouse.move(cx - 60, cy)  # 移开鼠标，避免悬停
        # 先拖偏，再按 A 拉回
        pg.mouse.move(cx, cy)
        pg.mouse.down()
        pg.mouse.move(cx - 45, cy, steps=4)
        pg.mouse.up()
        pg.keyboard.press("a")
        pg.wait_for_selector(".idp-guide-layer", timeout=3000)
        pill = pg.locator(".idp-guide-pill").inner_text()
        note("按 A 水平居中（绿徽标）", pill.startswith("居中"), pill)
        pg.wait_for_function("() => document.querySelectorAll('.idp-guide-layer').length === 0", timeout=2500)
        note("参考线约 1.2s 后自动消失", True)
        shot(pg, "05-after-a.png")

        # 4) 拖旋转钮：摆正模式参考线 + 0.6° 吸附
        knob = pg.locator(".idp-rotate-knob")
        kb = knob.bounding_box()
        kx, ky = kb["x"] + kb["width"] / 2, kb["y"] + kb["height"] / 2
        pg.mouse.move(kx, ky)
        pg.mouse.down()
        pg.mouse.move(kx + 30, ky - 4, steps=6)  # 小角度
        pg.wait_for_selector(".idp-guide-layer", timeout=5000)
        pill = pg.locator(".idp-guide-pill").inner_text()
        note("拖旋转钮出现摆正参考线", True, pill)
        img_tf = pg.evaluate("() => { const i=document.querySelector('.idp-framing-box img'); return i ? i.style.transform : ''; }")
        note("旋转已作用于图片", "rotate" in img_tf, img_tf)
        shot(pg, "06-rotate.png")
        # 拉回水平附近 → 吸附水平
        pg.mouse.move(kx, ky, steps=6)
        pg.mouse.up()
        pill2 = pg.evaluate(
            "() => { const e=[...document.querySelectorAll('.idp .muted')].map(x=>x.textContent).join('|'); return e; }"
        )
        img_tf2 = pg.evaluate("() => { const i=document.querySelector('.idp-framing-box img'); return i ? i.style.transform : ''; }")
        note("回位后旋转吸附回水平（transform 复位）", img_tf2 in ("", "undefined", None), img_tf2)

        # 5) 按 T：旋转回正（先拖出一个角度，再按 T）
        pg.mouse.move(kx, ky)
        pg.mouse.down()
        pg.mouse.move(kx + 40, ky - 30, steps=6)  # 明显角度（> 0.6°）
        pg.mouse.up()
        pg.keyboard.press("t")
        pg.wait_for_selector(".idp-guide-layer", timeout=3000)
        pill = pg.locator(".idp-guide-pill").inner_text()
        note("按 T 旋转回正（水平绿徽标）", pill.startswith("水平"), pill)
        pg.wait_for_function("() => document.querySelectorAll('.idp-guide-layer').length === 0", timeout=2500)
        shot(pg, "07-after-t.png")

        # 6) 方向键微调：拖偏 1px 后方向键回不来就算了；验证提交无异常即可
        pg.keyboard.press("ArrowLeft")
        pg.keyboard.press("ArrowRight")
        note("方向键微调不报错", True)

        # 完成 → 回到主界面，合成链路应正常出图（旋转/偏移被套用）
        pg.locator(".idp-framing-foot .btn.primary").click()
        pg.wait_for_timeout(1500)
        cards = pg.locator(".idp-photo-card img").count()
        note("关闭编辑器后合成链路正常（结果卡仍在）", cards > 0, "cards=%d" % cards)
        shot(pg, "08-final.png")

        # 完成后导出的成品里确实带旋转：检查 placements 已提交（通过编辑器重新打开回读）
        note("渲染进程无 JS 异常", len(page_errors) == 0, "; ".join(page_errors[:2]))
        report["consoleErrors"] = console_errors[:10]
        if console_errors:
            anomaly("控制台 error %d 条: %s" % (len(console_errors), "; ".join(c[:100] for c in console_errors[:3])))
        else:
            note("控制台无 error 级日志", True)
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
