# -*- coding: utf-8 -*-
"""打包版设置落盘冒烟：直接运行 dist-pkg-current/win-unpacked 里的 exe，
验证「设置项持久化 + 恢复默认」在**安装形态**（file:// 协议 + Electron userData）下真的生效。

为什么需要它：`tools/options_persist_smoke.py` 跑的是 http://127.0.0.1 静态服务 + Chromium，
localStorage 的 origin 是 http。Electron 打包版是 file:// 协议，存储后端是 userData 目录 ——
两者不是同一套。这条链路只有直接跑 exe 才验得到。

用法：python tools/packaged_options_persist.py   （需先 npm run pack）
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tmproot import mkdtemp  # noqa: E402

OUT = os.path.join(ROOT, ".tmp", "packaged-persist")
PORT = 9367
APP = os.path.join(ROOT, "dist-pkg-current", "win-unpacked", "超誉工作台.exe")
KEY = "chaoyu.idphoto.options.v1"

os.makedirs(OUT, exist_ok=True)
report = {"startedAt": datetime.now().isoformat(timespec="seconds"), "checks": []}


def note(name, ok, detail=""):
    detail = str(detail)
    report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
    print(("  [PASS] " if ok else "  [FAIL] ") + name + (("  " + detail) if detail else ""))


def shot(pg, name):
    pg.screenshot(path=os.path.join(OUT, name))


# 独立 userData：不污染用户真实设置，同时保证「首次无存档」；放仓库 .tmp 不占 C 盘
userdata = str(mkdtemp("chaoyu-persist-"))
env = dict(os.environ)
env.pop("ELECTRON_RUN_AS_NODE", None)
proc = subprocess.Popen(
    [APP, "--remote-debugging-port=%d" % PORT, "--user-data-dir=%s" % userdata],
    cwd=os.path.dirname(APP), env=env,
    stdout=open(os.path.join(OUT, "packaged.log"), "wb"), stderr=subprocess.STDOUT,
)
print("打包版已启动 pid=%d userData=%s" % (proc.pid, userdata))

errors = []


def read_store(page):
    raw = page.evaluate("(k) => localStorage.getItem(k)", KEY)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return {"__unparsable__": raw[:120]}


def open_idphoto(page):
    """首页 → 证件照（打包版是 state 路由，reload 后要重新点）"""
    page.wait_for_selector(".toolcard", timeout=30000)
    page.locator(".toolcard", has_text="证件照批量处理").first.click()
    page.wait_for_selector(".idp-right", timeout=20000)
    page.wait_for_timeout(500)


def check_controls(page):
    """把四类控件的当前读数一次性取出（省往返）"""
    return page.evaluate(
        """() => ({
             preset: document.querySelector('.idp-right select').value,
             blue: (document.querySelector('.idp-swatch[title="蓝底"]').className || '').includes('on'),
             blueTitle: document.querySelector('.idp-swatch[title="蓝底"]').title,
             white: (document.querySelector('.idp-swatch[title="白底"]').className || '').includes('on'),
             fastActive: [...document.querySelectorAll('.seg-btn')]
                          .some(b => b.textContent.trim() === '快速' && (b.className || '').includes('active')),
             defringe: [...document.querySelectorAll('.seg-btn')]
                          .some(b => b.textContent.trim() === '去除边缘' && (b.className || '').includes('active')),
             mono: [...document.querySelectorAll('label')]
                     .filter(l => l.textContent.includes('黑白照片'))
                     .map(l => l.querySelector('input').checked)[0],
             sizeChecked: document.querySelectorAll('.idp-size input:checked').length,
           })"""
    )


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
        raise SystemExit("CDP 未就绪（打包版启动失败？见 %s）" % os.path.join(OUT, "packaged.log"))

    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp("http://127.0.0.1:%d" % PORT)
        pg = [p for p in browser.contexts[0].pages if "index.html" in (p.url or "")][0]
        pg.set_default_timeout(25000)
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append("pageerror: %s" % e))

        print("页面 URL：%s" % pg.url)
        open_idphoto(pg)

        # 1) 首次进入：无存档 + 出厂默认
        note("打包版首次进入无存档", read_store(pg) is None, str(read_store(pg)))
        note(
            "顶部提示「设置会自动保留」",
            "设置会自动保留" in pg.locator(".idp-right").inner_text(),
        )
        note("默认档下「恢复默认」按钮不可点", pg.locator(".idp-right-h button").is_disabled())
        shot(pg, "01-default.png")

        # 2) 改 4 个字段：规格 / 底色 / 引擎 / 黑白
        pg.locator(".idp-right select").first.select_option("2cun")
        pg.locator('.idp-swatch[title="蓝底"]').click()
        # 默认已是「快速」，要切成「精细」才算改动过（2026-10-29 默认值调整）
        pg.locator(".seg-btn", has_text="精细").click()
        pg.locator("label", has_text="黑白照片").locator("input").check()
        pg.wait_for_timeout(600)
        shot(pg, "02-changed.png")

        store = read_store(pg) or {}
        note("改动后存档已写入（app:// 协议下 localStorage 可用）", bool(store), "keys=%s" % sorted(store.keys())[:6])
        note("存档 presetId=2cun", store.get("presetId") == "2cun", store.get("presetId"))
        note("存档 bgId=blue", store.get("bgId") == "blue", store.get("bgId"))
        note("存档 engine=isnet", store.get("engine") == "isnet", store.get("engine"))
        note("存档 monoOn=true", store.get("monoOn") is True, store.get("monoOn"))
        note("存档带 schemaVersion=2", store.get("schemaVersion") == 2, store.get("schemaVersion"))
        note("存档不含 exportSizeIds", "exportSizeIds" not in store)

        # 3) reload → 四字段全部还原
        pg.reload(wait_until="load")
        open_idphoto(pg)
        c = check_controls(pg)
        note("重启后规格仍为 2 寸", c["preset"] == "2cun", c["preset"])
        note("重启后底色仍为蓝底", c["blue"], c["blueTitle"])
        note("重启后引擎仍为精细", c["fastActive"] is False, "fastActive=%s" % c["fastActive"])
        note("重启后黑白照片仍勾选", c["mono"] is True, "mono=%s" % c["mono"])
        note("重启后导出尺寸仍只勾当前规格", c["sizeChecked"] == 1, "checked=%d" % c["sizeChecked"])
        shot(pg, "03-after-reload.png")

        # 4) 恢复默认：两段式确认
        reset_btn = pg.locator(".idp-right-h button")
        note("非默认时按钮可点", reset_btn.is_enabled())
        reset_btn.click()
        pg.wait_for_timeout(250)
        label = pg.locator(".idp-right-h button").inner_text()
        note("首次点击进入确认态（不直接生效）", "确认" in label, label)
        note("确认态下设置尚未改变", check_controls(pg)["preset"] == "2cun")
        pg.locator(".idp-right-h button").click()
        pg.wait_for_timeout(600)

        # 5) 恢复后：回默认 + 存档清空 + 按钮变灰
        c = check_controls(pg)
        note("恢复后规格回 1 寸", c["preset"] == "1cun", c["preset"])
        note("恢复后底色回白底", c["white"] and not c["blue"], "white=%s blue=%s" % (c["white"], c["blue"]))
        note("恢复后引擎回快速（新默认）", c["fastActive"] is True, "fastActive=%s" % c["fastActive"])
        note("恢复后黑白照片取消勾选", c["mono"] is False, "mono=%s" % c["mono"])
        note("恢复后存档被清空", read_store(pg) is None, str(read_store(pg)))
        note("恢复后按钮重新变灰", pg.locator(".idp-right-h button").is_disabled())
        shot(pg, "04-after-reset.png")

        # 6) 再 reload 仍是默认（证明默认值没被写回存档）
        pg.reload(wait_until="load")
        open_idphoto(pg)
        c = check_controls(pg)
        note(
            "恢复默认后重启仍是默认（存档未被写回）",
            c["preset"] == "1cun" and read_store(pg) is None,
            "preset=%s store=%s" % (c["preset"], read_store(pg)),
        )
        shot(pg, "05-final.png")

        # 7) v1 旧存档迁移 —— 用户机器的真实状态：老存档里 engine=isnet / defringeOn=false，
        #    不迁移的话「新默认值」在装上新版后完全不生效（面板还是精细、去边缘还是关）
        pg.evaluate(
            """(k) => localStorage.setItem(k, JSON.stringify({
                 schemaVersion: 1,
                 presetId: '2cun',
                 engine: 'isnet',
                 defringeOn: false,
               }))""",
            KEY,
        )
        pg.reload(wait_until="load")
        open_idphoto(pg)
        c = check_controls(pg)
        note("旧存档(v1)迁移后引擎回「快速」", c["fastActive"] is True, "fastActive=%s" % c["fastActive"])
        note("旧存档(v1)迁移后「去除边缘」恢复开启", c["defringe"] is True, "defringe=%s" % c["defringe"])
        note("迁移只动这两项：规格仍保留 2 寸", c["preset"] == "2cun", c["preset"])
        st = read_store(pg) or {}
        note("迁移结果已写回（schemaVersion=2）", st.get("schemaVersion") == 2, st.get("schemaVersion"))
        note("迁移后存档 engine=modnet", st.get("engine") == "modnet", st.get("engine"))
        note("迁移后存档 defringeOn=true", st.get("defringeOn") is True, st.get("defringeOn"))
        shot(pg, "06-migrated.png")

        report["consoleErrors"] = errors[:10]
        note("控制台无 error", len(errors) == 0, "; ".join(errors[:2]))
        browser.close()
except Exception as exc:
    note("脚本异常", False, repr(exc))
finally:
    try:
        proc.kill()
        proc.wait(timeout=10)
    except Exception:
        pass
    shutil.rmtree(userdata, ignore_errors=True)

    passed = sum(1 for c in report["checks"] if c["ok"])
    total = len(report["checks"])
    print("\n检查项：%d/%d 通过" % (passed, total))
    with open(os.path.join(OUT, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print("PACKAGED_PERSIST_OK" if passed == total else "PACKAGED_PERSIST_FAIL")
    raise SystemExit(0 if passed == total else 1)
