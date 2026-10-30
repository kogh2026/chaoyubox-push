# -*- coding: utf-8 -*-
"""UI 整体预览截图：首页 / 主要工具页 / PDF 工具箱多状态 / 响应式 / 深色主题
产物输出到 build-out/ui-previews/，供直观检查最终视觉效果。
前置：vite preview 已在 4173 端口运行（npm run build 之后）。
"""
import os
from playwright.sync_api import sync_playwright

BASE = "http://localhost:4173/"
HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures") + os.sep
OUT = os.path.join(os.path.dirname(os.path.dirname(HERE)), "build-out", "ui-previews") + os.sep
os.makedirs(OUT, exist_ok=True)

BP = FIX + "test-bp.pdf"  # 多页文档
A5 = FIX + "test-a5.pdf"


def preset(pg, theme="light"):
    """预置 localStorage：跳过首页向导、指定主题（loadSettings 与默认值合并）"""
    pg.add_init_script(
        "localStorage.setItem('chaoyu.settings.v1', "
        "JSON.stringify({wizardDone:true, theme:'%s'}))" % theme
    )


def shot(pg, name, full=False):
    pg.wait_for_timeout(600)
    pg.screenshot(path=OUT + name, full_page=full)
    print("saved", name)


def open_tool(pg, card_text, cat, tool, files=None, settle=900):
    # 已在工具箱内则不再从首页进入（连续切换工具时首页已卸载）
    if pg.locator(".toolcard").count() > 0:
        pg.locator(".toolcard", has_text=card_text).first.click()
        pg.wait_for_selector(".pdfx", timeout=8000)
    pg.locator(".pdfx-cat-b", has_text=cat).first.click()
    pg.wait_for_timeout(250)
    pg.locator(".pdfx-tool", has_text=tool).first.click()
    pg.wait_for_timeout(400)
    if files:
        pg.set_input_files(".pdfx-main input[type=file]", files)
        pg.wait_for_selector(".pp-file", timeout=8000)
        pg.wait_for_timeout(settle)


def check_date(pg):
    """强校验：首页日期/星期必须与系统时间实时一致（严禁硬编码）"""
    import datetime

    d = datetime.datetime.now()
    week = "日一二三四五六"[d.isoweekday() % 7]  # 周一→一 … 周日→日
    expect = f"{d.month}月{d.day}日 星期{week}"
    got = pg.locator(".home-greet small").inner_text().strip()
    print(f"date check: expect={expect!r} got={got!r} -> {'OK' if got == expect else 'MISMATCH'}")
    assert got == expect, f"日期/星期不匹配: {got!r} != {expect!r}"


with sync_playwright() as pw:
    b = pw.chromium.launch()

    # ---------- 1. 首页 · 桌面 1440 · 浅色 ----------
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    pg = ctx.new_page()
    preset(pg, "light")
    pg.goto(BASE)
    pg.wait_for_selector(".toolcard")
    check_date(pg)
    pg.locator(".home-greet").screenshot(path=OUT + "13-greeting-date.png")
    pg.locator(".sidebar").screenshot(path=OUT + "12-sidebar-desktop.png")
    print("saved 12-sidebar-desktop.png")
    print("saved 13-greeting-date.png")
    shot(pg, "01-home-desktop-light.png")
    shot(pg, "02-home-desktop-light-full.png", full=True)
    ctx.close()

    # ---------- 2. 首页 · 桌面 · 深色 ----------
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    pg = ctx.new_page()
    preset(pg, "dark")
    pg.goto(BASE)
    pg.wait_for_selector(".toolcard")
    shot(pg, "03-home-desktop-dark.png")
    ctx.close()

    # ---------- 3. PDF 工具箱 · 桌面 · 浅色（三个关键状态） ----------
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    pg = ctx.new_page()
    preset(pg, "light")
    pg.goto(BASE)
    pg.wait_for_selector(".toolcard")

    # 3a. 合并文档：文件输入 + 文件列表 + 参数 + 主按钮
    open_tool(pg, "PDF 工具箱", "页面管理", "合并文档", files=[BP, A5])
    shot(pg, "04-pdfx-merge-desktop.png")

    # 3b. 整理页序：自定义面板（页序拖拽 + 插白页）
    open_tool(pg, "PDF 工具箱", "页面管理", "整理页序", files=[BP], settle=1400)
    shot(pg, "05-pdfx-reorder-desktop.png")

    # 3c. 加密文档：口令 + 权限参数组
    open_tool(pg, "PDF 工具箱", "安全信息", "加密文档", files=[BP])
    shot(pg, "06-pdfx-encrypt-desktop.png")
    ctx.close()

    # ---------- 4. PDF 工具箱 · 桌面 · 深色 ----------
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    pg = ctx.new_page()
    preset(pg, "dark")
    pg.goto(BASE)
    pg.wait_for_selector(".toolcard")
    open_tool(pg, "PDF 工具箱", "页面管理", "合并文档", files=[BP, A5])
    shot(pg, "07-pdfx-merge-dark.png")
    ctx.close()

    # ---------- 5. 旗舰工具页 · 批量打印（另一主要页面布局参照） ----------
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    pg = ctx.new_page()
    preset(pg, "light")
    pg.goto(BASE)
    pg.wait_for_selector(".toolcard")
    pg.locator(".toolcard", has_text="批量打印").first.click()
    pg.wait_for_timeout(900)
    shot(pg, "08-batchprint-desktop.png")
    ctx.close()

    # ---------- 6. 响应式 · 手机 390×844 ----------
    ctx = b.new_context(viewport={"width": 390, "height": 844})
    pg = ctx.new_page()
    preset(pg, "light")
    pg.goto(BASE)
    pg.wait_for_selector(".toolcard")
    shot(pg, "09-home-mobile.png", full=True)
    open_tool(pg, "PDF 工具箱", "页面管理", "合并文档", files=[BP, A5])
    shot(pg, "10-pdfx-mobile.png", full=True)
    ctx.close()

    # ---------- 7. 响应式 · 平板 768×1024 ----------
    ctx = b.new_context(viewport={"width": 768, "height": 1024})
    pg = ctx.new_page()
    preset(pg, "light")
    pg.goto(BASE)
    pg.wait_for_selector(".toolcard")
    open_tool(pg, "PDF 工具箱", "页面管理", "合并文档", files=[BP, A5])
    shot(pg, "11-pdfx-tablet.png", full=True)
    ctx.close()

    # ---------- 8. 打印预设 · 桌面（mock 桌面版打印机枚举态） ----------
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    pg = ctx.new_page()
    preset(pg, "light")
    # 浏览器预览无 Electron IPC，注入 mock 复现桌面版 listPrinters 的真实返回
    # （UNC 网络打印机 + 默认打印机，与用户报截图中的 \\COLD-20240125RH\Canon LBP2900 同形态）
    pg.add_init_script(
        r"""
        window.electronAPI = {
          isElectron: true,
          listPrinters: async () => ([
            {name: '\\\\COLD-20240125RH\\Canon LBP2900', displayName: '\\\\COLD-20240125RH\\Canon LBP2900', isDefault: true},
            {name: 'Microsoft Print to PDF', displayName: 'Microsoft Print to PDF', isDefault: false}
          ])
        };
        """
    )
    pg.goto(BASE)
    pg.wait_for_selector(".toolcard")
    pg.locator(".side-tool", has_text="设置").first.click()
    pg.wait_for_timeout(600)
    pg.locator(".st-nav-i", has_text="打印预设").first.click()
    pg.wait_for_timeout(400)
    pg.locator(".st-pp-add button").click()  # 新增预设 → 展示打印机下拉
    pg.wait_for_timeout(600)
    n_opts = pg.locator(".st-pp-edit select").first.locator("option").count()
    print("printer select options:", n_opts)
    assert n_opts >= 3, "打印机下拉未包含枚举到的打印机（应含 留空/2 台 mock 打印机）"
    shot(pg, "14-printpreset-desktop.png")
    ctx.close()

    b.close()

print("ALL_DONE ->", OUT)
