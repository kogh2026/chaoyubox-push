# -*- coding: utf-8 -*-
"""PDF 预处理 E2E：合并/拆分/旋转/统一大小/转图片 + 发送到批量打印"""
import os
from playwright.sync_api import sync_playwright

BASE = "http://localhost:4173/"
HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures") + os.sep
OUT = os.path.join(HERE, ".out") + os.sep
os.makedirs(os.path.join(HERE, ".out"), exist_ok=True)

BP = FIX + "test-bp.pdf"      # 多页
A5 = FIX + "test-a5.pdf"
A3 = FIX + "test-a3.pdf"
errors = []
passed = []


def log(name, ok, detail=""):
    passed.append((name, ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")


def pdf_pages(path):
    """数 PDF 页数（数 /Type /Page 出现，宽松但够用）"""
    import re
    raw = open(path, "rb").read()
    return len(re.findall(rb"/Type\s*/Page[^s]", raw))


with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx = b.new_context(accept_downloads=True)
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    pg.goto(BASE)
    pg.wait_for_selector(".sidebar")
    pg.locator(".toolcard", has_text="PDF 预处理").first.click()
    pg.wait_for_timeout(500)
    assert pg.locator(".pp-title, .pp-tab").count() > 0, "tool page not rendered"

    # ---- 1. 合并 ----
    try:
        pg.locator("button", has_text="添加 PDF").first.click()
        pg.wait_for_timeout(200)
        pg.locator(".pp-row input[type=file]").first.set_input_files([BP, A5, A3])
        pg.wait_for_timeout(400)
        n = pg.locator(".pp-file").count()
        pg.locator("button", has_text="合并为 1 个 PDF").click()
        pg.wait_for_timeout(1500)
        with pg.expect_download(timeout=30000) as dl:
            pg.locator("button", has_text="下载").first.click()
        p = OUT + "pp_merge.pdf"
        dl.value.save_as(p)
        pages = pdf_pages(p)
        log("合并", n == 3 and pages >= 5, f"files={n} pages={pages} size={os.path.getsize(p)}")
    except Exception as e:
        log("合并", False, str(e)[:120])

    # ---- 2. 拆分 ----
    try:
        pg.locator(".pp-tab", has_text="拆分").click()
        pg.wait_for_timeout(300)
        pg.locator(".pp-row input[type=file]").first.set_input_files([BP])
        pg.wait_for_timeout(500)
        pg.locator(".pp-range").fill("1-2")
        pg.wait_for_timeout(200)
        pg.locator("button", has_text="拆分").first.click()
        pg.wait_for_timeout(1500)
        with pg.expect_download(timeout=30000) as d1:
            pg.locator("button", has_text="全部下载").first.click()
        pg.wait_for_timeout(1200)
        with pg.expect_download(timeout=30000) as d2:
            pass  # 第二个文件紧随其后
        p = OUT + "pp_split.pdf"
        d1.value.save_as(p)
        log("拆分", os.path.getsize(p) > 300, f"first={d1.value.suggested_filename} size={os.path.getsize(p)}")
    except Exception as e:
        log("拆分", False, str(e)[:120])

    # ---- 3. 旋转 ----
    try:
        pg.locator(".pp-tab", has_text="旋转").click()
        pg.wait_for_timeout(300)
        pg.locator(".pp-row input[type=file]").first.set_input_files([BP])
        pg.wait_for_timeout(500)
        pg.locator(".pp-seg-b", has_text="180").click()
        pg.locator("button", has_text="旋转").first.click()
        pg.wait_for_timeout(1500)
        with pg.expect_download(timeout=30000) as dl:
            pg.locator("button", has_text="下载").first.click()
        p = OUT + "pp_rotate.pdf"
        dl.value.save_as(p)
        log("旋转", os.path.getsize(p) > 300, f"size={os.path.getsize(p)}")
    except Exception as e:
        log("旋转", False, str(e)[:120])

    # ---- 4. 统一大小 ----
    try:
        pg.locator(".pp-tab", has_text="统一大小").click()
        pg.wait_for_timeout(300)
        pg.locator(".pp-row input[type=file]").first.set_input_files([BP])
        pg.wait_for_timeout(500)
        pg.locator(".pp-select").first.select_option("A5")
        pg.wait_for_timeout(200)
        pg.locator("button", has_text="统一页面大小").click()
        pg.wait_for_timeout(2000)
        with pg.expect_download(timeout=30000) as dl:
            pg.locator("button", has_text="下载").first.click()
        p = OUT + "pp_unify.pdf"
        dl.value.save_as(p)
        raw = open(p, "rb").read()
        # A5 = 420×595pt
        ok = b"420" in raw and b"595" in raw
        log("统一大小", os.path.getsize(p) > 300 and ok, f"size={os.path.getsize(p)} A5box={ok}")
    except Exception as e:
        log("统一大小", False, str(e)[:120])

    # ---- 5. 转图片 ----
    try:
        pg.locator(".pp-tab", has_text="转图片").click()
        pg.wait_for_timeout(300)
        pg.locator(".pp-row input[type=file]").first.set_input_files([BP])
        pg.wait_for_timeout(500)
        pg.locator(".pp-select").first.select_option("1")
        pg.locator("button", has_text="转换并下载 ZIP").click()
        with pg.expect_download(timeout=60000) as dl:
            pass
        p = OUT + "pp_images.zip"
        dl.value.save_as(p)
        import zipfile
        with zipfile.ZipFile(p) as z:
            names = z.namelist()
        log("转图片", len(names) >= 1 and all(n.endswith(".jpg") for n in names), f"entries={len(names)}")
    except Exception as e:
        log("转图片", False, str(e)[:120])

    # ---- 6. 发送到批量打印 ----
    try:
        pg.locator(".pp-tab", has_text="合并").click()
        pg.wait_for_timeout(300)
        pg.locator(".pp-row input[type=file]").first.set_input_files([BP, A5])
        pg.wait_for_timeout(400)
        pg.locator("button", has_text="合并为 1 个 PDF").click()
        pg.wait_for_timeout(1500)
        pg.locator("button", has_text="发送到批量打印").first.click()
        pg.wait_for_timeout(800)
        # 侧栏进批量打印，应出现导入行
        pg.locator(".side-tool', has_text='批量打印").click()
        pg.wait_for_timeout(2500)
        rows = pg.locator(".bp-table tbody tr").count()
        log("发送到批量打印", rows >= 1, f"rows={rows}")
    except Exception as e:
        log("发送到批量打印", False, str(e)[:120])

    print("ERRORS:", errors if errors else "none")
    assert not errors, errors[:5]
    b.close()

ok = sum(1 for _, v in passed if v)
print(f"PDFPREP_E2E_OK ({ok}/{len(passed)})")
