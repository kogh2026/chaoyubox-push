import base64, os, sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:4173/"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures") + os.sep
FILES = {
    "test-bp.pdf": OUT + "test-bp.pdf",
    "test-a3.pdf": OUT + "test-a3.pdf",
    "test-a5.pdf": OUT + "test-a5.pdf",
    "test-(2份)双面.pdf": OUT + "test-(2份)双面.pdf",
}

def b64(p):
    return base64.b64encode(open(p, "rb").read()).decode()

DROP_JS = """(args) => {
  const [b64, name, type] = args;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], name, { type });
  const dt = new DataTransfer();
  dt.items.add(file);
  const root = document.querySelector('.bp');
  const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
  root.dispatchEvent(over);
  const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
  root.dispatchEvent(drop);
}"""

errors = []
ok = 0

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    pg = browser.new_page()
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: errors.append(str(e)))

    pg.goto(BASE)
    pg.wait_for_selector(".sidebar")
    pg.locator(".sidebar").get_by_text("批量打印", exact=True).click()
    pg.wait_for_selector(".bp")

    # ---- 1) 系统拖放（真实 DataTransfer 模拟，复现用户 bug 场景）----
    pg.evaluate(DROP_JS, [b64(FILES["test-a3.pdf"]), "test-a3.pdf", "application/pdf"])
    pg.wait_for_selector(".bp-table tbody tr", timeout=15000)
    pg.wait_for_timeout(1500)
    row = pg.locator(".bp-table tbody tr").first
    print("DROP_OK rows =", pg.locator(".bp-table tbody tr").count())
    assert "test-a3.pdf" in row.inner_text()
    badge = pg.locator(".bp-table .badge.size").first
    print("SIZE_BADGE:", badge.inner_text())
    assert badge.inner_text() == "A3"
    paper_sel = pg.locator(".bp-table select").first
    print("PAPER_SELECT:", paper_sel.input_value())
    assert paper_sel.input_value() == "A3"
    ok += 1

    # ---- 2) 再拖 A5 + 文件名带份数双面的 ----
    pg.evaluate(DROP_JS, [b64(FILES["test-a5.pdf"]), "test-a5.pdf", "application/pdf"])
    pg.wait_for_timeout(1200)
    pg.evaluate(DROP_JS, [b64(FILES["test-(2份)双面.pdf"]), "test-(2份)双面.pdf", "application/pdf"])
    pg.wait_for_timeout(1200)
    print("ROWS_AFTER_3_DROPS:", pg.locator(".bp-table tbody tr").count())
    assert pg.locator(".bp-table tbody tr").count() == 3
    badges = pg.locator(".bp-table .badge.size").all_inner_texts()
    print("SIZE_BADGES:", badges)
    assert badges == ["A3", "A5", "A4"]
    # 文件名识别：份数 2、双面 on
    dup_row = pg.locator(".bp-table tbody tr").nth(2)
    copies = dup_row.locator("input.copies").input_value()
    dup_on = dup_row.locator(".bp-duplex button.on").inner_text()
    print("DUP_NAME_DETECT: copies =", copies, "duplex =", dup_on)
    assert copies == "2" and dup_on == "双面"
    ok += 1

    # ---- 3) 单面/双面切换 → 价格与用纸变化 ----
    a5_row = pg.locator(".bp-table tbody tr").nth(1)
    money_before = pg.locator(".bp-money").inner_text()
    a5_row.locator(".bp-duplex button", has_text="双面").click()
    pg.wait_for_timeout(200)
    money_after = pg.locator(".bp-money").inner_text()
    print("MONEY:", money_before, "->", money_after)
    assert money_before != money_after
    ok += 1

    # ---- 4) 页面视图：每页标签显示识别尺寸 ----
    pg.get_by_role("button", name="页面", exact=True).click()
    pg.wait_for_timeout(600)
    chips = pg.locator(".pg-chip").all_inner_texts()
    print("PAGE_CHIPS:", chips[:6])
    assert any("A3" in c for c in chips) and any("A5" in c for c in chips)
    ok += 1

    # ---- 5) 不支持的文件 → toast 提示，且不产生行 ----
    pg.evaluate(DROP_JS, [base64.b64encode(b"hello").decode(), "note.txt", "text/plain"])
    pg.wait_for_timeout(400)
    toast = pg.locator(".bp-toast")
    print("TOAST:", toast.inner_text() if toast.count() else "(none)")
    assert toast.count() == 1
    ok += 1

    # ---- 6) 选择文件按钮路径仍正常（test-bp.pdf 3页）----
    pg.get_by_role("button", name="列表", exact=True).click()
    pg.locator(".bp-toolbar input[type=file]").first.set_input_files(FILES["test-bp.pdf"])
    pg.wait_for_timeout(2500)
    print("ROWS_AFTER_INPUT:", pg.locator(".bp-table tbody tr").count())
    assert pg.locator(".bp-table tbody tr").count() == 4
    ok += 1

    browser.close()

print("CONSOLE_ERRORS:", errors if errors else "none")
assert not errors, "console errors present"
print(f"ALL_OK ({ok} groups passed)")
