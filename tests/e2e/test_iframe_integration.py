# -*- coding: utf-8 -*-
"""集成冒烟：PDF 工具箱 iframe 页 + 功能抽查 + 主应用导出不受影响"""
import os
from playwright.sync_api import sync_playwright

BASE = "http://localhost:4173/"
HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures") + os.sep
OUT = os.path.join(HERE, ".out") + os.sep
os.makedirs(os.path.join(HERE, ".out"), exist_ok=True)
errors = []

with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx = b.new_context(accept_downloads=True)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append('PAGEERROR: ' + str(e)))
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

    pg.goto(BASE)
    pg.wait_for_selector('.sidebar')
    # 1) 首页应出现 PDF 工具箱卡片
    card = pg.locator('.toolcard', has_text='PDF 工具箱')
    assert card.count() >= 1, 'home card missing'
    print('HOME_CARD_OK')

    # 2) 点击进入工具页，iframe 加载
    card.first.click()
    pg.wait_for_timeout(600)
    assert pg.locator('.pdt-title').inner_text() == 'PDF 工具箱'
    frame = pg.frame_locator('.pdt-frame iframe')
    # 3) iframe 内工具列表渲染（40 个 .tool-name）
    pg.wait_for_selector('.pdt-frame iframe')
    names = frame.locator('.tool-name')
    names.first.wait_for(timeout=20000)
    cnt = names.count()
    print('IFRAME_TOOLS:', cnt)
    assert cnt == 40, f'expect 40 tools, got {cnt}'

    # 4) iframe 内跑一次真实功能：常规合并（下载）
    with pg.expect_download(timeout=60000) as dl:
        frame.locator('.tool-card', has_text='常规合并').first.click()
        frame.locator('input[type=file]').first.set_input_files([
            FIX + 'test-bp.pdf',
            FIX + 'test-a5.pdf',
        ])
        pg.wait_for_timeout(3000)
        # 找执行按钮（合并并保存）
        btns = frame.locator('button')
        texts = btns.all_inner_texts()
        target = None
        for t in texts:
            if '合并' in t and '保存' in t:
                target = t
                break
        assert target, f'no merge-exec button, buttons={texts}'
        btns.filter(has_text=target).first.click()
    d = dl.value
    path = OUT + 'iframe_merge.pdf'
    d.save_as(path)
    print('MERGE_DOWNLOAD:', d.suggested_filename, os.path.getsize(path), 'bytes')
    assert os.path.getsize(path) > 1000

    # 5) 回主应用验证：搜索能搜到新工具（拼音）
    pg.locator('.side-home').click()
    pg.wait_for_timeout(300)
    pg.locator('#app-search, .home-search input').first.fill('pdf')
    pg.wait_for_timeout(300)
    n = pg.locator('.toolcard').count()
    print('SEARCH_pdf_cards:', n)
    assert n >= 1

    print('ERRORS:', errors if errors else 'none')
    assert not errors, errors[:5]
    b.close()

print('IFRAME_SMOKE_OK')
