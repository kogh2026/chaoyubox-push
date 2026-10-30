# -*- coding: utf-8 -*-
"""实测：证卡拼版助手在「1 张身份证 + A4 竖版」时，预览 canvas 里卡面的真实毫米尺寸。
方法：投一张纯红 4:3 图（cover 填充后红面铺满整个卡槽矩形），
     再扫描预览 canvas 像素找红色包围盒，按 canvas 宽=210mm 换算。"""
from playwright.sync_api import sync_playwright

# 生成纯红 4:3 图的 JS（1200x900，cover 进 85.6:54 槽会裁上下，红面即槽矩形）
MAKE_FILE = """(size) => {
  const c = document.createElement('canvas');
  c.width = 1200; c.height = 900;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 1200, 900);
  return new Promise((res) => c.toBlob((b) => res(b), 'image/png'));
}"""

DROP = """(blob) => {
  const file = new File([blob], 'red.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const root = document.querySelector('.icw-cards');
  root.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  root.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
}"""

MEASURE = """() => {
  const cv = document.querySelector('.icw-canvas');
  const ctx = cv.getContext('2d');
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let minX = cv.width, minY = cv.height, maxX = -1, maxY = -1;
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      const i = (y * cv.width + x) * 4;
      // 红色像素：R 高、G/B 低
      if (d[i] > 180 && d[i+1] < 90 && d[i+2] < 90) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const mmPerPx = 210 / cv.width;
  return {
    canvasW: cv.width,
    bboxWmm: +((maxX - minX + 1) * mmPerPx).toFixed(1),
    bboxHmm: +((maxY - minY + 1) * (297 / cv.height)).toFixed(1),
    xmm: +(minX * mmPerPx).toFixed(1),
    ymm: +(minY * (297 / cv.height)).toFixed(1),
  };
}"""

with sync_playwright() as pw:
    b = pw.chromium.launch()
    pg = b.new_page(viewport={'width': 1440, 'height': 900})
    pg.goto('http://localhost:4173/')
    pg.wait_for_selector('.sidebar')
    pg.locator('.sidebar').get_by_text('证卡拼版助手', exact=True).click()
    pg.wait_for_selector('.icw')
    blob = pg.evaluate(MAKE_FILE)
    pg.evaluate(DROP, blob)
    pg.wait_for_timeout(800)

    # 默认状态（perPage 初始 = 2）
    r2 = pg.evaluate(MEASURE)
    print(f"[perPage=2 默认] 卡面实测 {r2['bboxWmm']} x {r2['bboxHmm']} mm，左上角 ({r2['xmm']}, {r2['ymm']}) mm")

    # 切到「1张」档
    pg.locator('.cnt-btn', has_text='1张').first.click()
    pg.wait_for_timeout(500)
    r1 = pg.evaluate(MEASURE)
    print(f"[perPage=1]      卡面实测 {r1['bboxWmm']} x {r1['bboxHmm']} mm，左上角 ({r1['xmm']}, {r1['ymm']}) mm")
    print(f"期望（真实尺寸）: 85.6 x 54.0 mm")
    b.close()
