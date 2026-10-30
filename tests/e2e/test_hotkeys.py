"""E2E：可自定义快捷键全链路
覆盖工单 05：默认键位触发、录制改键生效/旧键失效、冲突拒绝、Esc 取消、持久化、恢复默认。
"""
from playwright.sync_api import sync_playwright

BASE = "http://localhost:4173/"
errors = []
ok = 0


def active_id(pg):
    return pg.evaluate("() => document.activeElement.id || document.activeElement.tagName")


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    pg = browser.new_page()
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: errors.append(str(e)))

    pg.goto(BASE)
    pg.wait_for_selector(".sidebar")

    def open_shortcut_settings():
        pg.locator(".sidebar").get_by_text("设置", exact=True).click()
        pg.wait_for_timeout(300)
        pg.locator(".st-nav .st-nav-i", has_text="快捷键").click()
        pg.wait_for_selector(".st-keys tbody tr")

    # ---- 1) 默认键位：Ctrl K 聚焦搜索 ----
    pg.keyboard.press("Control+k")
    pg.wait_for_timeout(300)
    print("CTRL_K_FOCUS:", active_id(pg))
    assert active_id(pg) == "app-search", "Ctrl K 应聚焦搜索框"
    ok += 1

    # ---- 2) 默认键位：缩放 Ctrl+= / Ctrl+- / Ctrl+0 ----
    # 注意：先 blur——上一步焦点在搜索框，打字保护会正确吞掉快捷键
    pg.evaluate("() => document.activeElement.blur()")
    # 实际生效的 zoom = 用户缩放 × 跟随窗口的自动适配系数（lib/uiScale），
    # 所以这里按"相对初始值"断言，既验证快捷键语义，又不依赖当前窗口大小
    def ui_zoom():
        return float(pg.evaluate("() => document.documentElement.style.zoom") or 1)

    base = ui_zoom()
    zoom0 = pg.evaluate("() => document.documentElement.style.zoom")
    pg.keyboard.press("Control+=")
    pg.wait_for_timeout(150)
    zoom_in = pg.evaluate("() => document.documentElement.style.zoom")
    print("ZOOM:", zoom0, "->", zoom_in)
    assert abs(ui_zoom() / base - 1.1) < 0.01, f"Ctrl+= 应放大到 110%（相对 {base}）"
    pg.keyboard.press("Control+-")
    pg.wait_for_timeout(150)
    assert abs(ui_zoom() - base) < 0.005, "Ctrl+- 应回到上一级"
    pg.keyboard.press("Control+=")
    pg.keyboard.press("Control+=")
    pg.wait_for_timeout(150)
    assert abs(ui_zoom() / base - 1.2) < 0.01, "连按两次 Ctrl+= 应到 120%"
    pg.keyboard.press("Control+0")
    pg.wait_for_timeout(150)
    assert abs(ui_zoom() - base) < 0.005, "Ctrl+0 应恢复默认缩放"
    ok += 1

    # ---- 3) 设置页表格显示默认键位 ----
    open_shortcut_settings()
    rows = pg.locator(".st-keys tbody tr")
    print("ROWS:", rows.count())
    assert rows.count() == 7
    first_kbd = rows.first.locator("kbd").inner_text()
    print("FIRST_KBD:", first_kbd)
    assert first_kbd == "Ctrl K"
    ok += 1

    # ---- 4) 录制改键：search → Ctrl J ----
    search_row = rows.filter(has_text="搜索工具")
    search_row.locator("button", has_text="录制").click()
    pg.keyboard.press("Control+j")
    pg.wait_for_timeout(300)
    new_kbd = search_row.locator("kbd").inner_text()
    print("AFTER_RECORD:", new_kbd)
    assert new_kbd == "Ctrl J"
    ok += 1

    # ---- 5) 新键生效、旧键失效 ----
    pg.evaluate("() => document.activeElement.blur()")
    pg.keyboard.press("Control+j")
    pg.wait_for_timeout(300)
    print("CTRL_J_FOCUS:", active_id(pg))
    assert active_id(pg) == "app-search"
    pg.evaluate("() => document.activeElement.blur()")
    pg.keyboard.press("Control+k")
    pg.wait_for_timeout(300)
    print("CTRL_K_AFTER_REBIND:", active_id(pg))
    assert active_id(pg) != "app-search", "旧键位应已失效"
    ok += 1

    # ---- 6) 刷新后保留（持久化）----
    pg.reload()
    pg.wait_for_selector(".sidebar")
    open_shortcut_settings()
    kept = pg.locator(".st-keys tbody tr").filter(has_text="搜索工具").locator("kbd").inner_text()
    print("AFTER_RELOAD:", kept)
    assert kept == "Ctrl J"
    ok += 1

    # ---- 7) 冲突拒绝：打印行录 Ctrl J（已被搜索占用）----
    print_row = pg.locator(".st-keys tbody tr").filter(has_text="打印")
    print_row.locator("button", has_text="录制").click()
    pg.keyboard.press("Control+j")
    pg.wait_for_timeout(300)
    conflict = print_row.locator(".st-conflict")
    print("CONFLICT_TEXT:", conflict.inner_text() if conflict.count() else "(none)")
    assert conflict.count() == 1 and "冲突" in conflict.inner_text()
    # 冲突保持录制态；Esc 退出后键位应未被改写（仍是默认 Ctrl P）
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(200)
    assert print_row.locator("kbd").inner_text() == "Ctrl P"
    ok += 1

    # ---- 8) Esc 取消录制 ----
    export_row = pg.locator(".st-keys tbody tr").filter(has_text="导出")
    export_row.locator("button", has_text="录制").click()
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(200)
    assert export_row.locator(".st-rec-hint").count() == 0
    assert export_row.locator("kbd").inner_text() == "Ctrl S"
    ok += 1

    # ---- 9) 全部恢复默认 ----
    pg.locator("button", has_text="全部恢复默认").click()
    pg.wait_for_timeout(300)
    all_kbd = pg.locator(".st-keys tbody tr kbd").all_inner_texts()
    print("AFTER_RESET_ALL:", all_kbd)
    assert all_kbd[0] == "Ctrl K"
    ok += 1

    # ---- 10) 在场感：打开工具后，快捷键页显示该工具支持的动作 ----
    pg.locator(".side-tool-name", has_text="批量打印").click()
    pg.wait_for_timeout(400)
    open_shortcut_settings()
    caps_line = pg.locator(".st-caps-line")
    caps_text = caps_line.inner_text()
    print("CAPS_LINE:", caps_text)
    assert "批量打印" in caps_text, "应显示最近使用的工具名"
    caps_items = pg.locator(".st-caps-item")
    print("CAPS_ITEMS:", caps_items.all_inner_texts())
    assert caps_items.count() == 3, "批量打印应登记 导入/打印/导出 三个动作"
    assert "Ctrl O" in caps_text and "Ctrl P" in caps_text and "Ctrl S" in caps_text
    ok += 1

    browser.close()

print("CONSOLE_ERRORS:", errors if errors else "none")
assert not errors
print(f"HOTKEY_E2E_OK ({ok} groups)")
