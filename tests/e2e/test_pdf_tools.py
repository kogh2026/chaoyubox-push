# -*- coding: utf-8 -*-
"""PDF 工具箱（原生 UI）E2E：工具清单 / 合并 / 加密 / 属性 / 批注 / 新建空白文档"""
import os
import json
import shutil
import subprocess
from playwright.sync_api import sync_playwright

BASE = "http://localhost:4173/"
HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures") + os.sep
OUT = os.path.join(HERE, ".out") + os.sep
os.makedirs(OUT, exist_ok=True)
errors = []
passed = []

BP = FIX + "test-bp.pdf"   # 多页
A5 = FIX + "test-a5.pdf"

REPO = os.path.dirname(os.path.dirname(HERE))


def log(name, ok, detail=""):
    passed.append((name, ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")


def pdf_info(path):
    """node + pdf-lib 读页数 / 尺寸 / 标题"""
    js = (
        "const {PDFDocument}=require('pdf-lib');const fs=require('fs');"
        "PDFDocument.load(fs.readFileSync(process.argv[1]),{ignoreEncryption:true}).then(d=>{"
        "console.log(JSON.stringify({pages:d.getPageCount(),title:d.getTitle()||'',"
        "sizes:d.getPages().map(p=>{const s=p.getSize();return [Math.round(s.width),Math.round(s.height)]})}));});"
    )
    r = subprocess.run([shutil.which("node"), "-e", js, path], capture_output=True, text=True, cwd=REPO)
    if r.returncode != 0:
        raise RuntimeError(f"pdf_info node failed: {r.stderr[:200]}")
    return json.loads(r.stdout.strip())


def pdf_annots(path):
    """node + pdf-lib 读首页批注数（对象流保存，字节 grep 不可靠）"""
    js = (
        "const {PDFDocument,PDFName}=require('pdf-lib');const fs=require('fs');"
        "PDFDocument.load(fs.readFileSync(process.argv[1]),{ignoreEncryption:true}).then(d=>{"
        "const a=d.getPage(0).node.get(PDFName.of('Annots'));"
        "console.log(JSON.stringify({n:a&&a.size?a.size():0}));});"
    )
    r = subprocess.run([shutil.which("node"), "-e", js, path], capture_output=True, text=True, cwd=REPO)
    if r.returncode != 0:
        raise RuntimeError(f"pdf_annots node failed: {r.stderr[:200]}")
    return json.loads(r.stdout.strip())


def pick_tool(pg, cat_name, tool_name):
    pg.locator(".pdfx-cat-b", has_text=cat_name).first.click()
    pg.wait_for_timeout(250)
    pg.locator(".pdfx-tool", has_text=tool_name).first.click()
    pg.wait_for_timeout(350)


with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx = b.new_context(accept_downloads=True)
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    pg.goto(BASE)
    pg.wait_for_selector(".sidebar")

    # ---- 1. 首页卡片进入，原生 UI 渲染，40 项工具齐全 ----
    try:
        pg.locator(".toolcard", has_text="PDF 工具箱").first.click()
        pg.wait_for_selector(".pdfx", timeout=10000)
        total = 0
        per_cat = {}
        for cat in ["页面管理", "页面调整", "版式拼版", "格式图像", "标注编号", "安全信息"]:
            pg.locator(".pdfx-cat-b", has_text=cat).first.click()
            pg.wait_for_timeout(200)
            cnt = pg.locator(".pdfx-tool").count()
            per_cat[cat] = cnt
            total += cnt
        log("工具清单", total == 40, f"total={total} {per_cat}")
    except Exception as e:
        log("工具清单", False, str(e)[:150])

    # ---- 2. 合并文档（默认工具，多文件） ----
    try:
        pick_tool(pg, "页面管理", "合并文档")
        pg.locator(".pdfx-main input[type=file]").first.set_input_files([BP, A5])
        pg.wait_for_timeout(400)
        n = pg.locator(".pdfx-files .pp-file").count()
        pg.locator(".actions button", has_text="执行").first.click()
        pg.wait_for_selector(".pdfx-result", timeout=30000)
        with pg.expect_download(timeout=30000) as dl:
            pg.locator(".pdfx-result button", has_text="下载").first.click()
        p = OUT + "pdfx_merge.pdf"
        dl.value.save_as(p)
        info = pdf_info(p)
        log("合并文档", n == 2 and info["pages"] >= 3, f"files={n} pages={info['pages']} size={os.path.getsize(p)}")
    except Exception as e:
        log("合并文档", False, str(e)[:150])

    # ---- 3. 加密文档（输出应含 /Encrypt） ----
    try:
        pick_tool(pg, "安全信息", "加密文档")
        pg.locator(".pdfx-main input[type=file]").first.set_input_files([BP])
        pg.wait_for_timeout(400)
        pws = pg.locator(".pdfx-main input[type=password]")
        pws.nth(0).fill("open123")
        pws.nth(1).fill("own123")
        pg.wait_for_timeout(200)
        pg.locator(".actions button", has_text="执行").first.click()
        pg.wait_for_selector(".pdfx-result", timeout=30000)
        with pg.expect_download(timeout=30000) as dl:
            pg.locator(".pdfx-result button", has_text="下载").first.click()
        p = OUT + "pdfx_enc.pdf"
        dl.value.save_as(p)
        raw = open(p, "rb").read()
        log("加密文档", b"/Encrypt" in raw and os.path.getsize(p) > 300, f"size={os.path.getsize(p)} encrypt={b'/Encrypt' in raw}")
    except Exception as e:
        log("加密文档", False, str(e)[:150])

    # ---- 4. 文档属性（改标题后保存） ----
    try:
        pick_tool(pg, "安全信息", "文档属性")
        pg.locator(".pdfx-main input[type=file]").first.set_input_files([BP])
        pg.wait_for_timeout(400)
        pg.wait_for_selector(".pdfx-meta", timeout=15000)
        title = pg.locator(".pdfx-meta input").first
        title.fill("E2E属性标题")
        pg.wait_for_timeout(200)
        pg.locator(".pdfx-custom button", has_text="保存修改").first.click()
        pg.wait_for_selector(".pdfx-result", timeout=30000)
        with pg.expect_download(timeout=30000) as dl:
            pg.locator(".pdfx-result button", has_text="下载").first.click()
        p = OUT + "pdfx_meta.pdf"
        dl.value.save_as(p)
        info = pdf_info(p)
        log("文档属性", info["title"] == "E2E属性标题", f"title={info['title']!r}")
    except Exception as e:
        log("文档属性", False, str(e)[:150])

    # ---- 5. 添加批注（预览页拖拽划选） ----
    try:
        pick_tool(pg, "标注编号", "添加批注")
        pg.locator(".pdfx-main input[type=file]").first.set_input_files([BP])
        pg.wait_for_timeout(400)
        box = pg.locator(".pdfx-annotbox").first
        box.wait_for(timeout=30000)
        bb = box.bounding_box()
        pg.mouse.move(bb["x"] + 30, bb["y"] + 30)
        pg.mouse.down()
        pg.mouse.move(bb["x"] + 130, bb["y"] + 90, steps=8)
        pg.mouse.move(bb["x"] + 170, bb["y"] + 120, steps=8)
        pg.mouse.up()
        pg.wait_for_timeout(400)
        chips = pg.locator(".pdfx-annot-chip").count()
        pg.locator(".actions button", has_text="执行").first.click()
        pg.wait_for_selector(".pdfx-result", timeout=30000)
        with pg.expect_download(timeout=30000) as dl:
            pg.locator(".pdfx-result button", has_text="下载").first.click()
        p = OUT + "pdfx_annot.pdf"
        dl.value.save_as(p)
        info = pdf_annots(p)
        log("添加批注", chips >= 1 and info["n"] >= 1, f"chips={chips} annots={info['n']} size={os.path.getsize(p)}")
    except Exception as e:
        log("添加批注", False, str(e)[:150])

    # ---- 6. 新建空白文档（无输入文件） ----
    try:
        pick_tool(pg, "版式拼版", "新建空白文档")
        pg.wait_for_timeout(300)
        pg.locator(".actions button", has_text="生成文档").first.click()
        pg.wait_for_selector(".pdfx-result", timeout=30000)
        with pg.expect_download(timeout=30000) as dl:
            pg.locator(".pdfx-result button", has_text="下载").first.click()
        p = OUT + "pdfx_blank.pdf"
        dl.value.save_as(p)
        info = pdf_info(p)
        log("新建空白文档", info["pages"] == 1 and info["sizes"][0] == [595, 842], f"pages={info['pages']} size={info['sizes']}")
    except Exception as e:
        log("新建空白文档", False, str(e)[:150])

    print("ERRORS:", errors if errors else "none")
    assert not errors, errors[:5]
    b.close()

ok = sum(1 for _, v in passed if v)
print(f"PDFTOOLS_E2E_OK ({ok}/{len(passed)})")
