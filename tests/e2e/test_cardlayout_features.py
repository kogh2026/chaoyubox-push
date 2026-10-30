"""证卡拼版助手 T0/T1/T3 聚焦 E2E：布局策略、参考线/蚂蚁线、份数、自动校正与手动兜底。
不覆盖 ML 增强（默认关闭，依赖按需下载模型，不在默认链路内）。
"""
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:4173/"

DROP = """async (spec) => {
  const c = document.createElement('canvas');
  c.width = 600; c.height = 380;
  const ctx = c.getContext('2d');
  ctx.fillStyle = spec.bg; ctx.fillRect(0, 0, 600, 380);
  if (spec.card) {
    ctx.fillStyle = spec.card;
    ctx.fillRect(600 * 0.15, 380 * 0.15, 600 * 0.7, 380 * 0.7);
  }
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const file = new File([blob], spec.name, { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const root = document.querySelector('.icw-cards');
  root.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  root.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  await new Promise(r => setTimeout(r, 700));
  return document.querySelectorAll('.ph-card').length;
}"""


def main():
    fails = 0

    def check(cond, label):
        nonlocal fails
        print(("PASS " if cond else "FAIL ") + label)
        if not cond:
            fails += 1

    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": 1440, "height": 900})
        errors = []
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.goto(BASE)
        pg.wait_for_selector(".sidebar")
        pg.locator(".sidebar").get_by_text("证卡拼版助手", exact=True).click()
        pg.wait_for_selector(".icw")

        # 1) 高置信图（白卡+灰底，边缘清晰）→ 自动校正 → 徽标「已校正」
        n1 = pg.evaluate(DROP, {"name": "good.png", "bg": "#888888", "card": "#ffffff"})
        # 2) 低置信图（纯色无边缘）→ 徽标「需检查」
        n2 = pg.evaluate(DROP, {"name": "bad.png", "bg": "#888888", "card": None})

        check(n2 == 2, "两张图均加入列表 (count=2)")
        badges = pg.locator(".ph-card .ph-badge").all_inner_texts()
        print("badges:", badges)
        check("已校正" in badges, "高置信图自动校正徽标=已校正")
        check("需检查" in badges, "低置信图徽标=需检查（待手动兜底）")

        # 3) 手动裁切兜底：点「需检查」卡的 ⛶ → 弹窗出现 → 取消
        bad_card = pg.locator(".ph-card", has=pg.locator(".ph-badge", has_text="需检查"))
        bad_card.locator("button[title^='手动裁切']").click()
        check(pg.locator(".mc-overlay").is_visible(), "手动裁切弹窗出现（兜底可用）")
        pg.locator(".mc-foot .btn", has_text="取消").click()
        check(not pg.locator(".mc-overlay").is_visible(), "手动裁切弹窗可取消关闭")

        # 4) 布局策略切换（T0）：切到「紧凑填充」不崩溃且激活态更新
        pg.locator(".icw-right .seg-btn", has_text="紧凑填充").click()
        check(pg.locator(".icw-right .seg-btn.active", has_text="紧凑填充").count() == 1,
              "布局算法切换为紧凑填充且激活态正确")
        pg.locator(".icw-right .seg-btn", has_text="自适应").click()
        check(pg.locator(".icw-right .seg-btn.active", has_text="自适应").count() == 1,
              "布局算法可切到自适应")

        # 5) 参考线/蚂蚁线开关（T1）：切换不崩溃，预览画布仍存在
        pg.locator(".icw-right .chk", has_text="导出蚂蚁线裁切口").locator("input").click()
        pg.locator(".icw-right .chk", has_text="预览参考线").locator("input").click()  # 关闭参考线
        pg.locator(".icw-right .chk", has_text="预览参考线").locator("input").click()  # 再打开
        check(pg.locator(".icw-canvas").is_visible(), "参考线/蚂蚁线开关后预览画布正常")

        # 6) 份数步进（T1）：第一张卡 ＋ 一次 → 待排版总数 +1
        before = pg.locator(".icw-cbar-info em").inner_text()
        pg.locator(".ph-card").first.locator("button[title='增加份数']").click()
        pg.wait_for_timeout(200)
        after = pg.locator(".icw-cbar-info em").inner_text()
        print("before/after 待排版:", before, after)
        check(before != after, "份数 +1 后待排版总数变化")

        check(len(errors) == 0, "无 console 错误")
        b.close()

    if fails == 0:
        print("CARDLAYOUT_E2E_OK")
        sys.exit(0)
    else:
        print(f"CARDLAYOUT_E2E_FAIL ({fails})")
        sys.exit(1)


if __name__ == "__main__":
    main()
