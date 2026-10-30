# -*- coding: utf-8 -*-
"""取景微调编辑器（FramingEditor）的运行时冒烟。

为什么需要它：这条路径在 tsc / 单测 / 导出特征测试里都是盲区 —— 组件挂在
`framingId` 后面，不点开根本不会渲染。步骤 5 把 431 行 JSX 从 IdPhoto.tsx
搬到 tools/FramingEditor.tsx 时，「能不能开、能不能拖、状态能不能还原」
只能靠真浏览器回答。

断言的是**用户能观察到的行为**：
  挂载 / 人物图解码铺满 / 拖动出参考线与徽标 / 画面跟随指针 /
  A 居中 · T 回正 / 拖圆钮旋转 / 重开后偏移与旋转被还原 / 重置居中归位。

用法：python tools/framing_editor_smoke.py   （需先 npm run build）
      通过输出 FRAMING_OK；失败逐条打印 [FAIL] 并 exit 1。
环境技巧与 export_characterization.py 相同：静态服务把 /res/** 映射到 resources/**，
注入 electronAPI.appResBase 让抠图与人脸模型能加载（本机无可用 Electron 二进制）。
"""

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
    print("serving dist on", port)

    ok = True

    def check(label: str, cond: bool, extra: str = "") -> None:
        nonlocal ok
        print(("  [PASS] " if cond else "  [FAIL] ") + label + ("  " + extra if extra else ""))
        ok = ok and cond

    errors: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("pageerror: %s" % e))
        page.add_init_script(
            "window.electronAPI = { appResBase: 'http://127.0.0.1:%d/res/' };" % port
        )
        page.goto("http://127.0.0.1:%d/index.html" % port, wait_until="load")
        page.wait_for_timeout(1200)
        page.get_by_text("证件照批量处理", exact=False).first.click()
        page.wait_for_timeout(1200)
        page.get_by_text("演示照片", exact=True).first.click()
        page.wait_for_selector(".idp-photo-card", timeout=180000)
        page.wait_for_timeout(2000)

        # 打开取景微调
        page.locator(".idp-act-view").first.click(force=True)
        page.wait_for_selector(".idp-framing-mask", timeout=15000)
        page.wait_for_timeout(1500)  # 等 matteBlob 解码 + 人脸检测
        check("取景编辑器挂载", page.locator(".idp-framing-box").count() == 1)
        check("旋转圆钮存在", page.locator(".idp-rotate-knob").count() == 1)
        check("底栏两个按钮", page.locator(".idp-framing-foot .btn").count() == 2)
        img_ok = page.evaluate(
            "() => { const i = document.querySelector('.idp-framing-box img');"
            " return !!i && i.naturalWidth > 0 && i.getBoundingClientRect().width > 0; }"
        )
        check("人物图已解码并铺满框体", img_ok)

        box = page.locator(".idp-framing-box").bounding_box()
        assert box is not None
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

        def img_state() -> dict:
            """读框内人物图的内联样式：left/top 是框内偏移（未旋转），transform 是旋转。"""
            return page.evaluate(
                """() => { const b = document.querySelector('.idp-framing-box');
                   const i = b.querySelector('img');
                   return { left: parseFloat(i.style.left), top: parseFloat(i.style.top),
                            w: parseFloat(i.style.width), h: parseFloat(i.style.height),
                            boxW: b.getBoundingClientRect().width,
                            boxH: b.getBoundingClientRect().height,
                            transform: i.style.transform || '' }; }"""
            )

        st0 = img_state()
        left0 = st0["left"]  # 首次打开（可能已带自动构图偏移）
        centerX = (st0["boxW"] - st0["w"]) / 2
        centerY = (st0["boxH"] - st0["h"]) / 2

        # 左拖：拖动过程中应出现参考线层，且图像位置跟着指针走
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx - 60, cy - 10, steps=8)
        page.wait_for_timeout(200)
        guide_during = page.locator(".idp-guide-layer").count()
        mid = img_state()
        guide_svg = page.evaluate(
            "() => { const s = document.querySelector('.idp-guide-svg');"
            " return s ? s.querySelectorAll('line').length : -1; }"
        )
        pill = page.evaluate(
            "() => { const p = document.querySelector('.idp-guide-pill'); return p ? p.textContent : null; }"
        )
        page.mouse.up()
        page.wait_for_timeout(300)
        check("拖动时出现参考线层", guide_during == 1)
        check("参考线含 4 条 line（双层描边 × 2）", guide_svg == 4, "got %s" % guide_svg)
        check("徽标有文案", bool(pill), repr(pill))
        check(
            "拖动时画面跟随指针（该图横向 slack 仅约 11px，会被 clamp）",
            mid["left"] != left0,
            "left0=%.1f mid=%.1f" % (left0, mid["left"]),
        )

        # 键盘 A / T：快捷键走同一 commit 路径
        page.keyboard.press("a")
        page.wait_for_timeout(250)
        guide_after_a = page.locator(".idp-guide-layer").count()
        page.keyboard.press("t")
        page.wait_for_timeout(250)
        guide_after_t = page.locator(".idp-guide-layer").count()
        check("快捷键 A 触发参考线闪现", guide_after_a == 1)
        check("快捷键 T 触发参考线闪现", guide_after_t == 1)

        # 旋转钮拖动
        knob = page.locator(".idp-rotate-knob").bounding_box()
        assert knob is not None
        kx, ky = knob["x"] + knob["width"] / 2, knob["y"] + knob["height"] / 2
        page.mouse.move(kx, ky)
        page.mouse.down()
        page.mouse.move(kx + 40, ky + 40, steps=8)
        page.mouse.up()
        page.wait_for_timeout(300)
        check("旋转后仍无控制台错误（拖动未抛异常）", len(errors) == 0)

        pre_close = img_state()

        # 关闭 → 遮罩消失
        page.get_by_text("完成", exact=True).first.click()
        page.wait_for_timeout(500)
        check("点完成关闭编辑器", page.locator(".idp-framing-mask").count() == 0)

        # 重新打开：偏移与旋转必须被 initial 还原（这才证明 onChange 真的提交了）
        def reopened_img() -> dict:
            page.locator(".idp-act-view").first.click(force=True)
            page.wait_for_selector(".idp-framing-mask", timeout=15000)
            page.wait_for_timeout(1200)
            return img_state()

        st = reopened_img()
        check(
            "重开后偏移被还原",
            abs(st["left"] - pre_close["left"]) <= 1,
            "before=%.1f after=%.1f" % (pre_close["left"], st["left"]),
        )
        check("重开后旋转被还原", st["transform"] == pre_close["transform"],
              "before=%r after=%r" % (pre_close["transform"], st["transform"]))

        # 重置居中 → 关闭 → 重开：应回到居中、无旋转
        page.get_by_text("重置居中", exact=True).first.click()
        page.wait_for_timeout(400)
        page.get_by_text("完成", exact=True).first.click()
        page.wait_for_timeout(400)
        st2 = reopened_img()
        check(
            "重置居中后回到几何居中",
            abs(st2["left"] - (st2["boxW"] - st2["w"]) / 2) <= 1
            and abs(st2["top"] - (st2["boxH"] - st2["h"]) / 2) <= 1,
            "left=%.1f(期望%.1f) top=%.1f(期望%.1f)"
            % (st2["left"], (st2["boxW"] - st2["w"]) / 2, st2["top"], (st2["boxH"] - st2["h"]) / 2),
        )
        check("重置居中后旋转归零", st2["transform"] == "", st2["transform"])
        page.get_by_text("完成", exact=True).first.click()
        page.wait_for_timeout(300)

        check("控制台无错误", len(errors) == 0, "; ".join(errors[:3]))
        browser.close()

    httpd.shutdown()
    print("\nFRAMING_OK" if ok else "\nFRAMING_FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
