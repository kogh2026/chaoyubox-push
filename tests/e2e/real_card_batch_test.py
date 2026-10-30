# -*- coding: utf-8 -*-
"""实物图批量实测：证卡拼版助手对 D:\\50\\身份证正面 全部图片 + 用户样例图的检测效果。

流程（重复 ROUNDS 轮，验证确定性）：
  1. 全新页面 -> 进入证卡拼版助手
  2. 把全部图片分批经真实拖放链路投入（走 handleFiles / detectCardQuad）
  3. 读取每个列表项的文件名、徽标（需检查/可导出/已排除）、title 中的置信度
  4. 汇总各轮结果，逐图对比跨轮一致性
"""
import base64
import json
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://localhost:4173/"
SAMPLE = r"C:\Users\Coldhack\.workbuddy\clipboard-images\clipboard-2026-10-26T02-48-29-261Z-278f0610.jpg"
FOLDER = r"D:\50\身份证正面"
ROUNDS = 3
BATCH = 10

io = Path(__file__).with_name("_real_card_io")
io.mkdir(exist_ok=True)

DROP_JS = """
(b64List) => {
  const dt = new DataTransfer();
  for (const [name, b64] of b64List) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], name, { type: 'image/jpeg' }));
  }
  const root = document.querySelector('.icw-cards');
  root.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  root.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return true;
}
"""

READ_JS = """
() => {
  const out = [];
  document.querySelectorAll('.ph-card').forEach((card) => {
    const img = card.querySelector('.ph-imgbox img');
    const badge = card.querySelector('.ph-badge');
    out.push({
      name: img ? img.alt : '?',
      badge: badge ? badge.textContent.trim() : '?',
      conf: badge ? badge.title : '',
    });
  });
  return { n: out.length, items: out };
}
"""


def load_images():
    """把样例图 + 文件夹图读成 (name, b64) 列表。"""
    entries = [(Path(SAMPLE).name, Path(SAMPLE).read_bytes())]
    for p in sorted(Path(FOLDER).glob("*.jpg")):
        entries.append((p.name, p.read_bytes()))
    out = []
    for name, data in entries:
        out.append((name, base64.b64encode(data).decode()))
    return out


def main():
    images = load_images()
    print(f"[setup] 待测图片 {len(images)} 张（样例 1 + 文件夹 {len(images)-1}）")
    all_runs = []
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        for r in range(1, ROUNDS + 1):
            pg = b.new_page(viewport={"width": 1440, "height": 900})
            pg.goto(BASE)
            pg.wait_for_selector(".sidebar")
            pg.locator(".sidebar").get_by_text("证卡拼版助手", exact=True).click()
            pg.wait_for_selector(".icw")
            t0 = time.time()
            for i in range(0, len(images), BATCH):
                chunk = images[i : i + BATCH]
                pg.evaluate(DROP_JS, chunk)
                # 等待本批全部入列（检测同步执行，最长 30s）
                pg.wait_for_function(
                    "(n) => document.querySelectorAll('.ph-card').length >= n",
                    arg=i + len(chunk),
                    timeout=30000,
                )
            dt = time.time() - t0
            res = pg.evaluate(READ_JS)
            all_runs.append(res["items"])
            warn = sum(1 for it in res["items"] if it["badge"] == "需检查")
            print(f"[run {r}] 入列 {res['n']}/{len(images)}，需检查 {warn} 张，耗时 {dt:.1f}s")
            # 首轮截图：列表整体 + 预览画布（前 4 张参与排版的效果）
            if r == 1:
                pg.locator(".icw-cards").screenshot(path=str(io / "run1_card_list.png"))
                sel = pg.locator(".icw-canvas")
                if sel.count():
                    sel.screenshot(path=str(io / "run1_preview_canvas.png"))
            pg.close()
        b.close()

    # ---- 跨轮一致性 ----
    by_run = [{it["name"]: it for it in run} for run in all_runs]
    names = [it["name"] for it in all_runs[0]]
    mismatch = []
    for n in names:
        confs = [by_run[r].get(n, {}).get("conf", "?") for r in range(ROUNDS)]
        badges = [by_run[r].get(n, {}).get("badge", "?") for r in range(ROUNDS)]
        if len(set(confs)) > 1 or len(set(badges)) > 1:
            mismatch.append((n, confs, badges))
    print(f"[check] 跨 {ROUNDS} 轮逐图对比：{'全部一致' if not mismatch else f'{len(mismatch)} 张不一致'}")
    for n, confs, badges in mismatch:
        print(f"  MISMATCH {n}: conf={confs} badge={badges}")

    # ---- 汇总表 ----
    rows = []
    for n in names:
        it = all_runs[0][[x["name"] for x in all_runs[0]].index(n)]
        rows.append({"name": n, "badge": it["badge"], "conf": it["conf"]})
    (io / "results.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")

    warn_rows = [r for r in rows if r["badge"] == "需检查"]
    print(f"[summary] 共 {len(rows)} 张：可导出 {len(rows)-len(warn_rows)}，需检查 {len(warn_rows)}")
    for r in warn_rows:
        print(f"  需检查  {r['name']}  {r['conf']}")
    print("REALCARD_BATCH_OK")


if __name__ == "__main__":
    sys.exit(main())
