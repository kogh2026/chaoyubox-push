# -*- coding: utf-8 -*-
"""批量打印「报价明细」面板 E2E 冒烟：
1) 导入双面×2份 fixture → 明细面板默认展开，行结构 = 名称 / N面 × 单价 / 小计
2) 字段映射一致性：每行 小计 === 面数 × 单价
3) 批量一致性：分项小计之和 === 合计 === 底部栏「预计」金额（单张/批量同引擎同口径）
4) 双面用纸提示存在；面板可收起/展开；追加文件后明细随之更新
"""
import base64, os, re, sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:4173/"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures") + os.sep

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
  root.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  root.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
}"""

def parse_money(text):
    m = re.search(r"¥([\d.]+)", text)
    return round(float(m.group(1)), 2) if m else None

ok = 0
errors = []

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    pg = browser.new_page()
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: errors.append(str(e)))

    pg.goto(BASE)
    pg.wait_for_selector(".sidebar")
    pg.locator(".sidebar").get_by_text("批量打印", exact=True).click()
    pg.wait_for_selector(".bp")

    # ---- 1) 导入双面×2份 fixture → 明细面板默认展开 ----
    pg.evaluate(DROP_JS, [b64(OUT + "test-(2份)双面.pdf"), "test-(2份)双面.pdf", "application/pdf"])
    pg.wait_for_selector(".bp-table tbody tr", timeout=15000)
    pg.wait_for_timeout(1500)
    pop = pg.locator(".bp-detail-pop")
    assert pop.count() == 1 and pop.is_visible(), "报价明细面板未默认展开"
    title = pg.locator(".bp-detail-title").inner_text()
    assert title == "报价明细", f"面板标题异常: {title}"
    print("DETAIL_PANEL_OPEN PASS title =", title)
    ok += 1

    # ---- 2) 行结构 + 字段映射一致性：小计 === 面数 × 单价 ----
    rows = pg.locator(".bp-detail-row:not(.total)")
    n = rows.count()
    assert n >= 1, "明细没有分项行"
    sum_sub = 0.0
    for i in range(n):
        r = rows.nth(i)
        name = r.locator(".bp-detail-name").inner_text()
        calc = r.locator(".bp-detail-calc").inner_text()
        sub = parse_money(r.locator(".bp-detail-sub").inner_text())
        m = re.match(r"(\d+)面\s*×\s*¥([\d.]+)", calc)
        assert m, f"行[{name}] 数量×单价格式异常: {calc}"
        faces, unit = int(m.group(1)), float(m.group(2))
        assert abs(sub - faces * unit) < 0.005, f"行[{name}] 小计 {sub} != {faces}×{unit}"
        assert re.match(r"A\d (黑白|点彩|彩色)(单面|双面)$", name), f"行名不符合「纸张+颜色+单双面」: {name}"
        print(f"  ROW PASS {name}: {faces}面 × ¥{unit:.2f} = ¥{sub:.2f}")
        sum_sub += sub
    print("DETAIL_ROWS_PARSE PASS rows =", n)
    ok += 1

    # ---- 3) 批量一致性：分项之和 === 合计 === 底部栏预计 ----
    total_in_panel = parse_money(pg.locator(".bp-detail-row.total .bp-detail-sub").inner_text())
    money = parse_money(pg.locator(".bp-money").inner_text())
    assert abs(sum_sub - total_in_panel) < 0.005, f"分项之和 {sum_sub} != 面板合计 {total_in_panel}"
    assert abs(total_in_panel - money) < 0.005, f"面板合计 {total_in_panel} != 底部栏预计 {money}"
    print(f"CONSISTENCY PASS 分项和=¥{sum_sub:.2f} = 合计 = 预计 ¥{money:.2f}")
    ok += 1

    # ---- 4) 双面用纸提示 ----
    note = pg.locator(".bp-detail-note").inner_text()
    assert "用纸" in note and "双面的文件每一份都从新的一张纸开始" in note, f"用纸提示异常: {note}"
    print("DUPLEX_NOTE PASS:", note.strip())
    ok += 1

    # ---- 5) 收起 / 展开 ----
    pg.get_by_role("button", name=re.compile("报价明细")).click()
    pg.wait_for_timeout(200)
    assert not pg.locator(".bp-detail-pop").is_visible(), "收起后面板仍可见"
    pg.get_by_role("button", name=re.compile("报价明细")).click()
    pg.wait_for_timeout(200)
    assert pg.locator(".bp-detail-pop").is_visible(), "再次展开后面板不可见"
    print("TOGGLE PASS")
    ok += 1

    # ---- 6) 追加单面文件 → 明细随之更新且一致性保持 ----
    pg.evaluate(DROP_JS, [b64(OUT + "test-bp.pdf"), "test-bp.pdf", "application/pdf"])
    pg.wait_for_timeout(2500)
    rows2 = pg.locator(".bp-detail-row:not(.total)")
    n2 = rows2.count()
    assert n2 >= n, f"追加文件后明细行未增加: {n2} <= {n}"
    sum2 = sum(
        parse_money(rows2.nth(i).locator(".bp-detail-sub").inner_text()) for i in range(n2)
    )
    total2 = parse_money(pg.locator(".bp-detail-row.total .bp-detail-sub").inner_text())
    money2 = parse_money(pg.locator(".bp-money").inner_text())
    assert abs(sum2 - total2) < 0.005 and abs(total2 - money2) < 0.005, \
        f"追加后不一致: 和={sum2} 合计={total2} 预计={money2}"
    print(f"AFTER_APPEND PASS rows {n}->{n2}, 合计 = 预计 = ¥{money2:.2f}")
    ok += 1

    browser.close()

print("CONSOLE_ERRORS:", errors if errors else "none")
assert not errors, "console errors present"
print(f"QUOTE_DETAIL_E2E_OK ({ok} groups passed)")
