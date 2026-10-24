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


import json, subprocess, shutil

REPO = os.path.dirname(os.path.dirname(HERE))  # tests/e2e 的上两级 = 仓库根


def pdf_info(path):
    """用 node + pdf-lib 读页数与每页尺寸（pdf-lib 输出压缩对象流，字节 grep 不可靠）"""
    js = (
        "const {PDFDocument}=require('pdf-lib');const fs=require('fs');"
        "PDFDocument.load(fs.readFileSync(process.argv[1])).then(d=>{"
        "console.log(JSON.stringify({pages:d.getPageCount(),"
        "sizes:d.getPages().map(p=>{const s=p.getSize();return [Math.round(s.width),Math.round(s.height)]})}));});"
    )
    r = subprocess.run([shutil.which("node"), "-e", js, path], capture_output=True, text=True, cwd=REPO)
    if r.returncode != 0:
        raise RuntimeError(f"pdf_info node failed: {r.stderr[:200]}")
    return json.loads(r.stdout.strip())


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
        pg.locator(".pp-actions button", has_text="合并为 1 个 PDF").click()
        pg.wait_for_timeout(1500)
        with pg.expect_download(timeout=30000) as dl:
            pg.locator(".pp-actions button", has_text="下载").first.click()
        p = OUT + "pp_merge.pdf"
        dl.value.save_as(p)
        info = pdf_info(p)
        log("合并", n == 3 and info["pages"] >= 5, f"files={n} pages={info['pages']} size={os.path.getsize(p)}")
    except Exception as e:
        log("合并", False, str(e)[:120])

    # ---- 2. 拆分 ----
    try:
        pg.locator(".pp-tab", has_text="拆分").click()
        pg.wait_for_timeout(300)
        pg.locator(".pp-row input[type=file]").first.set_input_files([BP])
        pg.wait_for_timeout(500)
        pg.locator(".pp-range").fill("1,2")  # 两个范围 → 两个文件
        pg.wait_for_timeout(200)
        pg.locator(".pp-actions button", has_text="拆分").first.click()
        pg.wait_for_timeout(1500)
        # 串行捕获：全部下载内部错开 350ms 触发，两个并行 waiter 会被同一事件解析
        with pg.expect_download(timeout=30000) as d1:
            pg.locator(".pp-actions button", has_text="全部下载").first.click()
        p1, p2 = OUT + "pp_split1.pdf", OUT + "pp_split2.pdf"
        d1.value.save_as(p1)
        with pg.expect_download(timeout=30000) as d2:
            pg.wait_for_timeout(800)  # 等第二个错开的下载
        d2.value.save_as(p2)
        diff = open(p1, "rb").read() != open(p2, "rb").read()
        log("拆分", os.path.getsize(p1) > 300 and os.path.getsize(p2) > 300 and diff,
            f"{d1.value.suggested_filename}+{d2.value.suggested_filename} diff={diff}")
    except Exception as e:
        log("拆分", False, str(e)[:120])

    # ---- 3. 旋转 ----
    try:
        pg.locator(".pp-tab", has_text="旋转").click()
        pg.wait_for_timeout(300)
        pg.locator(".pp-row input[type=file]").first.set_input_files([BP])
        pg.wait_for_timeout(500)
        pg.locator(".pp-seg-b", has_text="180").click()
        pg.locator(".pp-actions button", has_text="旋转").first.click()
        pg.wait_for_timeout(1500)
        with pg.expect_download(timeout=30000) as dl:
            pg.locator(".pp-actions button", has_text="下载").first.click()
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
        pg.locator(".pp-range").fill("")  # 清空：范围状态跨 Tab 保留
        pg.locator(".pp-select").first.select_option("A5")
        pg.wait_for_timeout(200)
        pg.locator(".pp-actions button", has_text="统一页面大小").click()
        pg.wait_for_timeout(2000)
        with pg.expect_download(timeout=30000) as dl:
            pg.locator(".pp-actions button", has_text="下载").first.click()
        p = OUT + "pp_unify.pdf"
        dl.value.save_as(p)
        info = pdf_info(p)
        # A5 = 420×595pt，全部页应统一
        ok = info["pages"] >= 1 and all(sz == [420, 595] for sz in info["sizes"])
        log("统一大小", ok, f"pages={info['pages']} sizes={info['sizes'][:2]}")
    except Exception as e:
        log("统一大小", False, str(e)[:120])

    # ---- 5. 转图片 ----
    try:
        pg.locator(".pp-tab", has_text="转图片").click()
        pg.wait_for_timeout(300)
        pg.locator(".pp-row input[type=file]").first.set_input_files([BP])
        pg.wait_for_timeout(500)
        pg.locator(".pp-select").first.select_option("1")
        pg.locator(".pp-actions button", has_text="转换并下载 ZIP").click()
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
        pg.locator(".pp-actions button", has_text="合并为 1 个 PDF").click()
        pg.wait_for_timeout(1500)
        pg.locator(".pp-actions button", has_text="发送到批量打印").first.click()
        pg.wait_for_timeout(800)
        # 侧栏进批量打印，应出现导入行 + toast 提示
        pg.locator(".side-tool", has_text="批量打印").click()
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
