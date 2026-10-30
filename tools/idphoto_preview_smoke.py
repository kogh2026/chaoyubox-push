# -*- coding: utf-8 -*-
"""证件照「导入 → 自动抠图 → 逐张大图预览」交互冒烟（参考爱印的左右布局）。

为什么需要它：这轮把中栏从「所有结果的缩略图网格」改成了「当前照片的单张大图」，
新增了「点左栏行体切换主预览」「上一张/下一张」「原图对比」「缩放」「标尺」这些
**纯交互**，tsc / 单测 / 导出特征测试都碰不到：网格改成大图在像素层面都能"通过"，
但用户会立刻发现点缩略图没反应。

断言的都是用户能观察到的行为：
  一列缩略图 / 导入即自动抠图 / 主预览比缩略图大 / 默认选第一张 /
  点第二行切到第二张 / 上一张下一张循环 / 原图⇄成品 / 缩放 / mm·px 标尺 /
  改背景色即时反映到主预览 / 取景微调按钮接线 / 无 console error。

用法：python tools/idphoto_preview_smoke.py   （需先 npm run build）
通过输出 PREVIEW_WORKSPACE_OK；失败逐条打印 [FAIL] 并 exit 1。
环境技巧与 export_characterization.py 相同：静态服务把 /res/** 映射到 resources/**，
注入 electronAPI.appResBase 让抠图与人脸模型能加载（本机无可用 Electron 二进制）。
"""

from __future__ import annotations

import functools
import http.server
import os
import socketserver
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
RES = ROOT / "resources"
OUT = ROOT / ".tmp" / "preview-workspace"
OUT.mkdir(parents=True, exist_ok=True)


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
    try:
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

            # 演示照片一次导入 2 张（走与真实导入完全相同的链路）
            page.get_by_text("演示照片", exact=True).first.click()
            page.wait_for_selector(".idp-photo-card", timeout=240000)
            page.wait_for_function(
                "() => document.querySelectorAll('.idp-card .idp-badge.done').length >= 2",
                timeout=240000,
            )
            page.wait_for_timeout(1500)
            page.screenshot(path=str(OUT / "01-workspace.png"))

            # 1) 左栏是一列缩略图（不是网格）：两行卡片左边界相同
            cards = page.locator(".idp-photos .idp-card")
            n = cards.count()
            check("左栏列出全部导入照片", n == 2, "rows=%d" % n)
            b0, b1 = cards.nth(0).bounding_box(), cards.nth(1).bounding_box()
            check(
                "左栏为单列列表（两行左边界对齐、纵向堆叠）",
                bool(b0 and b1) and abs(b0["x"] - b1["x"]) < 1 and b1["y"] > b0["y"] + b0["height"] * 0.5,
                "x0=%.1f x1=%.1f y0=%.1f y1=%.1f" % (b0["x"], b1["x"], b0["y"], b1["y"]),
            )

            # 2) 每行缩略图都是**成品**（换底后的），不是原图
            thumbs = page.evaluate(
                "() => [...document.querySelectorAll('.idp-photos .idp-card-img img')]"
                ".map(i => i.getAttribute('data-done'))"
            )
            check("两行缩略图都已显示成品（data-done）", thumbs == ["1", "1"], repr(thumbs))

            # 3) 中栏只有一张大图，且明显大于左栏缩略图
            big = page.locator(".idp-photo-card")
            check("中栏只渲染一张主预览", big.count() == 1, "count=%d" % big.count())
            bb = big.bounding_box()
            tw = b0 and page.locator(".idp-photos .idp-card-img").first.bounding_box()
            check(
                "主预览尺寸远大于左栏缩略图（放大查看）",
                bool(bb and tw) and bb["width"] > tw["width"] * 3,
                "big=%.0fx%.0f thumb=%.0fx%.0f"
                % (bb["width"], bb["height"], tw["width"], tw["height"]),
            )
            # 纵横比跟随规格（一寸 25×35mm）
            ar = bb["width"] / bb["height"] if bb else 0
            check("主预览纵横比≈一寸规格 25/35", abs(ar - 25 / 35) < 0.02, "ar=%.3f" % ar)

            # 4) 默认选中第一张
            counter = page.locator(".idp-pv-count")
            check("默认选中第 1 张", counter.inner_text().strip() == "1 / 2", counter.inner_text())
            first_src = page.eval_on_selector(".idp-photo-card img", "i => i.src")
            check("主预览显示的是成品（blob URL）", first_src.startswith("blob:"), first_src[:24])

            # 5) 点左栏第二行 → 主预览切到第二张，且第一行高亮转移
            cards.nth(1).click()
            page.wait_for_timeout(600)
            check("点缩略图切换主预览（计数 2 / 2）", counter.inner_text().strip() == "2 / 2", counter.inner_text())
            second_src = page.eval_on_selector(".idp-photo-card img", "i => i.src")
            check("主预览换成了另一张的成品", second_src != first_src, "%s..." % second_src[:20])
            act = page.evaluate(
                "() => [...document.querySelectorAll('.idp-photos .idp-card')]"
                ".map(c => c.classList.contains('act'))"
            )
            check("高亮行跟着切换（act 只在第 2 行）", act == [False, True], repr(act))
            page.screenshot(path=str(OUT / "02-second-photo.png"))

            # 6) 下一张 / 上一张循环
            page.locator('[aria-label="下一张"]').click()
            page.wait_for_timeout(400)
            check("「下一张」循环回第 1 张", counter.inner_text().strip() == "1 / 2", counter.inner_text())
            page.locator('[aria-label="上一张"]').click()
            page.wait_for_timeout(400)
            check("「上一张」循环到第 2 张", counter.inner_text().strip() == "2 / 2", counter.inner_text())

            # 7) 原图 ⇄ 成品对比
            page.get_by_text("原图", exact=True).first.click()
            page.wait_for_timeout(400)
            orig_src = page.eval_on_selector(".idp-photo-card img", "i => i.src")
            check("切「原图」后主预览换成导入原图", orig_src != second_src and orig_src.startswith("blob:"), orig_src[:20])
            check("原图态有角标", page.locator(".idp-pv-tag").count() == 1)
            page.get_by_text("成品", exact=True).first.click()
            page.wait_for_timeout(400)
            check(
                "切回成品",
                page.eval_on_selector(".idp-photo-card img", "i => i.src") == second_src,
            )

            # 8) 缩放：+ 一档后容器 zoom 变化、读数同步
            z0 = page.evaluate("() => getComputedStyle(document.querySelector('.idp-pv-inner')).zoom")
            page.locator(".idp-zi").nth(1).click()  # 第 2 个是「+」
            page.wait_for_timeout(300)
            z1 = page.evaluate("() => getComputedStyle(document.querySelector('.idp-pv-inner')).zoom")
            check("点「+」放大主预览", z0 != z1, "%s -> %s" % (z0, z1))
            check("缩放读数同步", page.locator(".idp-pv-zoom").inner_text().strip() == "125%",
                  page.locator(".idp-pv-zoom").inner_text())
            page.get_by_text("适应", exact=True).first.click()
            page.wait_for_timeout(300)
            check("点「适应」回到 100%", page.locator(".idp-pv-zoom").inner_text().strip() == "100%")

            # 9) 尺寸标尺（左 mm / 右 px / 下 px）
            ruler = page.locator(".idp-ruler").first.inner_text().strip()
            check("照片下方有尺寸标尺", page.locator(".idp-ruler").count() == 1, ruler)
            check(
                "标尺同时给出毫米与像素",
                "mm" in ruler and "px" in ruler and "25" in ruler and "295" in ruler,
                ruler,
            )

            # 10) 改右栏参数 → 主预览即时更新（换成红底，取背景像素验证）
            before = page.eval_on_selector(".idp-photo-card img", "i => i.src")
            page.locator('.idp-swatch[title="红底"]').click()
            page.wait_for_function(
                "([s]) => { const i = document.querySelector('.idp-photo-card img');"
                " return !!i && i.src !== s; }",
                arg=[before],
                timeout=30000,
            )
            page.wait_for_timeout(500)
            rgb = page.evaluate(
                """() => {
                  const i = document.querySelector('.idp-photo-card img');
                  const c = document.createElement('canvas');
                  c.width = i.naturalWidth; c.height = i.naturalHeight;
                  const x = c.getContext('2d');
                  x.drawImage(i, 0, 0);
                  // 左上角是背景区（人脸居中），红底时 R 明显高于 B
                  const d = x.getImageData(Math.round(c.width * 0.06), Math.round(c.height * 0.05), 1, 1).data;
                  return [d[0], d[1], d[2]];
                }"""
            )
            check("换红底即时反映到主预览", rgb[0] > rgb[2] + 40, "rgb=%s" % (rgb,))
            page.screenshot(path=str(OUT / "03-red-bg.png"))

            # 10.5) 排版照页签：整版 canvas 出得来，切回证件照主预览还在
            page.get_by_text("排版照", exact=True).first.click()
            page.wait_for_timeout(1200)
            check("切到排版照显示整版预览", page.locator(".sheet-canvas").count() == 1)
            page.get_by_text("证件照", exact=True).first.click()
            page.wait_for_timeout(800)
            check("切回证件照主预览仍在", page.locator(".idp-photo-card img").count() == 1)

            # 11) 取景微调按钮接线（编辑器能开、能关）
            page.locator(".idp-act-view").first.click(force=True)
            page.wait_for_selector(".idp-framing-mask", timeout=15000)
            check("「取景微调」能打开编辑器", page.locator(".idp-framing-box").count() == 1)
            page.get_by_text("完成", exact=True).first.click()
            page.wait_for_timeout(600)
            check("关闭编辑器回到大图", page.locator(".idp-framing-mask").count() == 0)

            # 12) 版面必须填满可视高度：旧版把顶部猜成 120px 写死，实际只有 .main 的 24px padding，
            #     底部因此常年拖出一条与内容无关的空白。这里用「窗口底部 - 工作台底部」量，
            #     并且换一个窗口尺寸再量一遍 —— 高度必须是算出来的，不能是某个窗口的巧合。
            def layout_gap() -> dict:
                return page.evaluate(
                    """() => {
                      const idp = document.querySelector('.idp').getBoundingClientRect();
                      const bar = document.querySelector('.idp-bottom').getBoundingClientRect();
                      const left = document.querySelector('.idp-left').getBoundingClientRect();
                      const right = document.querySelector('.idp-right').getBoundingClientRect();
                      return {
                        gap: Math.round(innerHeight - idp.bottom),
                        barB: Math.round(innerHeight - bar.bottom),
                        align: Math.round(Math.max(Math.abs(left.top - right.top),
                                                   Math.abs(left.bottom - right.bottom))),
                      };
                    }"""
                )

            m = layout_gap()
            check("工作台填满可视高度（底部只留 .main 的 24px 内边距）", m["gap"] <= 32, repr(m))
            check("底部状态栏贴着视口底部", m["barB"] <= 34, repr(m))
            check("左右两栏顶/底对齐", m["align"] <= 1, repr(m))

            page.set_viewport_size({"width": 1000, "height": 700})
            page.wait_for_timeout(700)
            m2 = layout_gap()
            check("换窗口尺寸后依然填满（高度是算出来的）", m2["gap"] <= 32, repr(m2))
            page.set_viewport_size({"width": 1440, "height": 900})
            page.wait_for_timeout(700)

            # 13) 左栏留白收口 + 底栏三段
            check("照片少时列表末尾有追加提示", page.locator(".idp-list-end").count() == 1)
            check(
                "底部状态栏分概览 / 开关 / 动作三段",
                all(page.locator(sel).count() == 1 for sel in (".idp-bottom-l", ".idp-bottom-m", ".idp-bottom-r")),
            )

            # 14) 左栏列表本身就是投放区（新增交互，别只靠肉眼看）：拖入照片直接追加到当前批次。
            #     用已导入那张的 blob 造一个 File，避免额外测试素材。
            n_before = page.locator(".idp-photos .idp-card").count()
            page.evaluate(
                """async () => {
                  const src = document.querySelector('.idp-photos .idp-card-img img').src;
                  const blob = await (await fetch(src)).blob();
                  const dt = new DataTransfer();
                  dt.items.add(new File([blob], '拖入测试.jpg', { type: 'image/jpeg' }));
                  window.__dt = dt;
                  document.querySelector('.idp-photos').dispatchEvent(
                    new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })
                  );
                }"""
            )
            page.wait_for_timeout(250)
            check("拖到列表上会高亮投放区", page.locator(".idp-photos.over").count() == 1)
            page.evaluate(
                """() => document.querySelector('.idp-photos').dispatchEvent(
                     new DragEvent('drop', { dataTransfer: window.__dt, bubbles: true, cancelable: true }))"""
            )
            page.wait_for_timeout(1500)
            check(
                "拖入后照片追加到批次",
                page.locator(".idp-photos .idp-card").count() == n_before + 1,
                "%d -> %d" % (n_before, page.locator(".idp-photos .idp-card").count()),
            )
            check("投放后高亮复位", page.locator(".idp-photos.over").count() == 0)

            check("控制台无错误", len(errors) == 0, "; ".join(errors[:3]))
            browser.close()
    finally:
        httpd.shutdown()

    print("\nPREVIEW_WORKSPACE_OK" if ok else "\nPREVIEW_WORKSPACE_FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
