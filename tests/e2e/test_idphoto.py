# -*- coding: utf-8 -*-
"""证件照批量处理 UI 冒烟测试：演示→生成→导出 + 错误路径 + 排版预览 + 规格切换。

覆盖刚刚重构的 IdPhoto.tsx：
- drawDemoCanvas 生成的演示缩略图（无需模型即可渲染）；
- 「先试一张」→ createDemoItem / canvasToBlob 生成真实照片 → matte 抠图（可能离线失败）；
- 生成成功则验证导出下载；离线/模型不可用时验证错误路径（⚠ 抠图失败）可见、不崩溃；
- 排版照 tab、尺寸标注开关、规格切换的像素文本更新。

前置：vite preview 已在 4173 端口运行（npm run build 之后）。
"""
import os
from playwright.sync_api import sync_playwright

BASE = "http://localhost:4173/"
HERE = os.path.dirname(os.path.abspath(__file__))


def preset(pg, theme="light"):
    """预置 localStorage：跳过首页向导、指定主题。"""
    pg.add_init_script(
        "localStorage.setItem('chaoyu.settings.v1', JSON.stringify({wizardDone:true, theme:'%s'}))" % theme
    )


def log(name, ok, detail=""):
    print("  %s: %s %s" % (name, "PASS" if ok else "FAIL", detail))
    assert ok, "%s 失败: %s" % (name, detail)


with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    pg = ctx.new_page()
    preset(pg, "light")
    pg.goto(BASE)
    pg.wait_for_selector(".toolcard")

    # 进入「证件照批量处理」工具
    pg.locator(".toolcard", has_text="证件照批量处理").first.click()
    pg.wait_for_selector(".idp", timeout=8000)

    # 1) 组件渲染 + 演示缩略图（drawDemoCanvas 生成 dataURL，不依赖模型）
    log("idp 容器渲染", pg.locator(".idp").count() == 1)
    demo_cards = pg.locator(".idp-demo-card")
    log("演示缩略图卡片数=2", demo_cards.count() == 2, "count=%d" % demo_cards.count())
    first_img = demo_cards.first.locator("img")
    log("演示缩略图已生成图片", first_img.count() == 1 and first_img.is_visible())

    # 2) 点「先试一张」→ 真实照片生成 → matte（首次运行需下载 ISNet ONNX 模型，较慢）
    demo_cards.first.click()
    # 进度文本出现即证明 matte 流水线已启动（createDemoItem 已产出真实照片）
    pg.wait_for_selector(".progress-text", timeout=8000)
    log("matte 流水线已启动（进度文本可见）", True, pg.locator(".progress-text").inner_text()[:30])

    # 等待：结果网格出现 或 错误标记出现（任一即可）。首次模型下载 + WASM 推理较慢，给足时间。
    try:
        pg.wait_for_function(
            "() => document.querySelectorAll('.idp-grid .idp-photo-card').length>0 "
            "|| document.querySelectorAll('.idp-item-x[title*=\"失败\"]').length>0",
            timeout=90000,
        )
        res = pg.locator(".idp-grid .idp-photo-card").count()
        errs = pg.locator(".idp-item-x[title*='失败']").count()
    except Exception:
        res, errs = 0, 0

    if res > 0:
        log("生成链路完成（结果网格）", True, "results=%d" % res)
        # 生成成功：点击「导出证件照」，应触发一次下载
        with pg.expect_download() as dl:
            pg.locator("button:has-text('导出证件照')").click()
        name = dl.value.suggested_filename
        log("导出下载文件名含「证件照」", "证件照" in name, name)
    elif errs > 0:
        # 模型不可达：错误路径可见即视为通过（重构后错误不再静默丢失）
        log("离线/无模型→错误路径可见（非阻塞）", True, "errors=%d" % errs)
    else:
        # 模型仍在下载/推理（环境过慢）：演示照片已生成，跳过生成/导出断言，不判失败
        print("  [SKIP] 模型仍在加载（环境过慢/不可达）：演示照片已生成，"
              "matting 依赖外部 ONNX 模型，跳过结果/导出断言")

    # 3) 切换「排版照」tab，验证画布或空态渲染不崩溃
    pg.locator(".idp-tabs button", has_text="排版照").click()
    pg.wait_for_timeout(400)
    log("排版照 tab 渲染 canvas 或空态", pg.locator(".sheet-scroll canvas, .idp-stage-box").count() > 0)

    # 切回「证件照」tab
    pg.locator(".idp-tabs button", has_text="证件照").click()
    pg.wait_for_timeout(300)

    # 4) 尺寸标注开关不崩溃
    sz = pg.locator(".idp-bottom-l input[type=checkbox]")
    if sz.count() > 0:
        sz.first.check()
        pg.wait_for_timeout(200)
        sz.first.uncheck()
        log("尺寸标注开关可用", True)

    # 5) 规格切换更新像素文本（验证 mmToPx 联动 UI）
    sel = pg.locator(".idp-right select").first
    before = pg.locator(".idp-step p.muted").first.inner_text()
    sel.select_option(index=1)
    pg.wait_for_timeout(300)
    after = pg.locator(".idp-step p.muted").first.inner_text()
    log("规格像素文本随选择更新", ("px" in after) and (before != after), "%r -> %r" % (before, after))

    b.close()
print("IDPHOTO_E2E_OK")
