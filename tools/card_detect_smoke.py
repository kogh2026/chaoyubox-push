# -*- coding: utf-8 -*-
"""证卡识别的端到端冒烟 + 视觉证据。

为什么需要它：`cardDetect.cv.test.ts` 用合成像素验证的是**几何算法**；
而「导入 → 识别 → 自动校正 → 排版预览」这条真实链路只存在于浏览器里
（canvas 取像素、Worker 重采样、CSS transform）。这个脚本做三件事：

  1. 用 PIL 现场合成两张「翻拍照片」—— 单卡（旋转+透视）、双卡并排；
     卡面画了抬头条 / 头像块 / 文字行，等价于真实身份证的可辨识特征。
  2. 起静态服务打开 证卡拼版助手，把照片喂进 `<input type=file>`，
     等自动校正完成。
  3. 断言用户能看到的结果：卡数量（多卡是否拆开）、置信度、
     校正图长宽比是否是 85.6:54、四角是不是卡面白而不是桌面木纹。

用法：python tools/card_detect_smoke.py   （需先 npm run build）
通过输出 CARD_DETECT_OK；失败逐条打印 [FAIL] 并 exit 1。
"""

from __future__ import annotations

import functools
import http.server
import math
import socketserver
import threading
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
RES = ROOT / "resources"
OUT = ROOT / ".tmp" / "card-detect"


# ---------------- 合成照片 ----------------

def card_face(w: int = 830, h: int = 524) -> Image.Image:
    """画一张身份证样式的卡面（白底 + 抬头条 + 文字行 + 头像块）。"""
    im = Image.new("RGB", (w, h), (243, 242, 236))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, w - 1, h - 1], outline=(206, 208, 204), width=3)
    # 抬头条
    d.rectangle([int(w * 0.06), int(h * 0.10), int(w * 0.60), int(h * 0.21)], fill=(196, 212, 232))
    # 头像块（灰阶渐变）
    px0, py0, px1, py1 = int(w * 0.72), int(h * 0.28), int(w * 0.95), int(h * 0.78)
    for i in range(py1 - py0):
        g = 138 + int(26 * math.sin(i / 26))
        d.line([(px0, py0 + i), (px1, py0 + i)], fill=(g, g + 4, g + 8))
    d.rectangle([px0, py0, px1, py1], outline=(160, 160, 160), width=2)
    # 文字行
    y = int(h * 0.28)
    for i in range(6):
        length = 0.30 + ((i * 13) % 5) * 0.06
        d.rectangle(
            [int(w * 0.07), y, int(w * (0.07 + length)), y + int(h * 0.033)],
            fill=(78, 80, 86),
        )
        y += int(h * 0.093)
    # 底部号码条
    d.rectangle([int(w * 0.07), int(h * 0.86), int(w * 0.62), int(h * 0.90)], fill=(96, 98, 104))
    return im


def desk(w: int = 1600, h: int = 1200, seed: int = 3) -> Image.Image:
    rng = np.random.default_rng(seed)
    base = np.zeros((h, w, 3), dtype=np.float32)
    yy, xx = np.mgrid[0:h, 0:w]
    tone = 118 + 24 * np.sin(xx / w * 2.4) + 16 * np.cos(yy / h * 1.9)
    base[..., 0] = tone
    base[..., 1] = tone * 0.96
    base[..., 2] = tone * 0.90
    base += rng.normal(0, 4.5, base.shape)
    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))


def place(img: Image.Image, card: Image.Image, quad: list[tuple[float, float]]) -> Image.Image:
    """把 card 按四角 quad（在 img 坐标系）做透视贴入 img。"""
    cw, ch = card.size
    # 求解 output(x,y) → input(u,v) 的单应（PIL PERSPECTIVE 需要这个方向）
    src = []
    dst = []
    for (x, y), (u, v) in zip(quad, [(0, 0), (cw, 0), (cw, ch), (0, ch)]):
        src.append((x, y))
        dst.append((u, v))
    A = []
    b = []
    for (x, y), (u, v) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        b.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        b.append(v)
    coeffs = np.linalg.solve(np.array(A, dtype=float), np.array(b, dtype=float))
    warped = card.transform(img.size, Image.PERSPECTIVE, tuple(coeffs), Image.BICUBIC)
    mask = Image.new("L", card.size, 255).transform(
        img.size, Image.PERSPECTIVE, tuple(coeffs), Image.BILINEAR
    )
    out = img.copy()
    out.paste(warped, (0, 0), mask)
    return out


def quad_of(cx, cy, cw, ch, deg=0.0, persp=0.0):
    rad = math.radians(deg)
    cos, sin = math.cos(rad), math.sin(rad)
    pts = [
        (-cw / 2, -ch / 2),
        (cw / 2, -ch / 2),
        (cw / 2, ch / 2),
        (-cw / 2, ch / 2),
    ]
    out = []
    for x, y in pts:
        x *= 1 - persp * (y / ch + 0.5)
        y *= 1 - persp * 0.18 * (x / cw + 0.5)
        out.append((cx + x * cos - y * sin, cy + x * sin + y * cos))
    return out


def make_photos() -> dict[str, Path]:
    OUT.mkdir(parents=True, exist_ok=True)
    face = card_face()

    single = place(desk(seed=3), face, quad_of(800, 600, 900, 568, deg=7.5, persp=0.14))
    p1 = OUT / "photo-single.png"
    single.save(p1)

    d2 = desk(seed=9)
    d2 = place(d2, face, quad_of(430, 560, 640, 404, deg=-5))
    d2 = place(d2, face, quad_of(1160, 640, 640, 404, deg=4))
    p2 = OUT / "photo-dual.png"
    d2.save(p2)

    # 反面用例：只有桌面、没有证件 —— 期望「不自动裁」而不是瞎裁一个框
    blank = desk(seed=13)
    p3 = OUT / "photo-blank.png"
    blank.save(p3)
    return {"single": p1, "dual": p2, "blank": p3}


# ---------------- 浏览器验证 ----------------

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def translate_path(self, path):
        if path.startswith("/res/"):
            return str(RES / path[len("/res/"):].split("?")[0])
        return super().translate_path(path)


EDGE = Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")


def launch_browser(p):
    """优先用系统 Edge（本机没装 playwright 自带 chromium 时的等价方案）。"""
    tries = []
    if EDGE.exists():
        tries.append({"executable_path": str(EDGE)})
    tries.append({"channel": "msedge"})
    tries.append({})
    last = None
    for kw in tries:
        try:
            return p.chromium.launch(**kw)
        except Exception as e:  # noqa: BLE001
            last = e
    raise RuntimeError(f"没有可用浏览器：{last}")


def main() -> int:
    photos = make_photos()
    print("photos:", ", ".join(f"{k}={v}" for k, v in photos.items()))

    httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(DIST)))
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print("serving dist on", port)

    ok = True

    def check(label: str, cond: bool, extra: str = "") -> None:
        nonlocal ok
        print(("  [PASS] " if cond else "  [FAIL] ") + label + ("  " + extra if extra else ""))
        ok = ok and cond

    errors: list[str] = []
    with sync_playwright() as p:
        browser = launch_browser(p)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on(
            "response",
            lambda r: errors.append(f"404 {r.url}") if r.status >= 400 else None,
        )
        page.goto(f"http://127.0.0.1:{port}/", wait_until="load")
        page.get_by_role("button", name="证卡拼版助手").first.click()
        page.wait_for_selector(".icw-cards", timeout=15000)

        # 单卡
        page.set_input_files("input[type=file]", str(photos["single"]))
        page.wait_for_selector(".ph-card", timeout=30000)
        page.wait_for_function(
            "() => [...document.querySelectorAll('.ph-card img')].every(i => i.src.startsWith('data:'))",
            timeout=60000,
        )
        page.wait_for_timeout(600)
        n1 = page.eval_on_selector_all(".ph-card", "els => els.length")
        check("单卡照片 → 1 条记录", n1 == 1, f"实际 {n1}")
        badge = page.eval_on_selector(".ph-badge", "el => ({t: el.textContent, title: el.title})")
        conf = int("".join(ch for ch in badge["title"] if ch.isdigit()) or 0)
        check("单卡自动校正（徽标=已校正）", badge["t"] == "已校正", str(badge))
        check("置信度 ≥ 60%", conf >= 60, f"{conf}%")

        shot = page.eval_on_selector(
            ".ph-card img",
            """el => {
              const c = document.createElement('canvas');
              c.width = el.naturalWidth; c.height = el.naturalHeight;
              const g = c.getContext('2d'); g.drawImage(el, 0, 0);
              const px = (x, y) => { const d = g.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; };
              const lum = ([r, gg, b]) => 0.299*r + 0.587*gg + 0.114*b;
              const w = el.naturalWidth, h = el.naturalHeight;
              let minL = 255, sum = 0, n = 0;
              for (let gy = 0; gy < 8; gy++) {
                for (let gx = 0; gx < 12; gx++) {
                  const x = Math.round(w * (0.10 + 0.80 * gx / 11));
                  const y = Math.round(h * (0.15 + 0.70 * gy / 7));
                  const l = lum(px(x, y));
                  if (l < minL) minL = l;
                  sum += l; n++;
                }
              }
              return {
                w, h,
                corners: [px(6,6), px(w-7,6), px(6,h-7), px(w-7,h-7)].map(lum),
                minL, meanL: sum / n,
              };
            }""",
        )
        ratio = shot["w"] / shot["h"]
        check("校正图长宽比 ≈ 85.6:54", abs(ratio - 85.6 / 54) < 0.06, f"{ratio:.3f} ({shot['w']}×{shot['h']})")
        check(
            "四角是卡面白（未留桌面木纹）",
            all(v > 170 for v in shot["corners"]),
            str([round(v) for v in shot["corners"]]),
        )
        check("卡面内确有字迹（最暗点 < 150）", shot["minL"] < 150, f"最暗 {shot['minL']:.0f} / 均值 {shot['meanL']:.0f}")
        page.screenshot(path=str(OUT / "ui-single.png"))

        # 双卡
        page.set_input_files("input[type=file]", str(photos["dual"]))
        page.wait_for_function(
            "() => document.querySelectorAll('.ph-card').length >= 3", timeout=60000
        )
        page.wait_for_timeout(1200)
        n2 = page.eval_on_selector_all(".ph-card", "els => els.length")
        check("双卡照片被拆成 2 条（累计 3 条）", n2 == 3, f"实际 {n2}")
        names = page.eval_on_selector_all(".ph-card img", "els => els.map(e => e.alt)")
        check("拆分记录带（1/2）（2/2）标注", any("1/2" in x for x in names) and any("2/2" in x for x in names), str(names[-2:]))
        page.screenshot(path=str(OUT / "ui-dual.png"))

        # 无证件照片：必须标「需检查」并保留原图（回退而不是瞎裁）
        page.set_input_files("input[type=file]", str(photos["blank"]))
        page.wait_for_function(
            "() => document.querySelectorAll('.ph-card').length >= 4", timeout=60000
        )
        page.wait_for_timeout(1500)
        last = page.eval_on_selector_all(
            ".ph-card",
            "els => { const el = els[els.length-1]; return { badge: el.querySelector('.ph-badge').textContent.trim(), src: el.querySelector('img').src.slice(0,5) }; }",
        )
        check("无证件照片 → 标「需检查」", last["badge"] == "需检查", str(last))
        check("无证件照片 → 保留原图不自动裁", last["src"] == "blob:", str(last["src"]))
        page.screenshot(path=str(OUT / "ui-blank.png"))

        # 静态服务没有 /favicon.ico 之类的 404 与功能无关，只看真实报错
        # 只关心「应用代码抛错」。静态 harness 没有 favicon / CDN 上的 OCR 语言包，
        # 浏览器会打一条没有 URL 的 "Failed to load resource"，与识别链路无关。
        real = [e for e in errors if not e.startswith("Failed to load resource")]
        check("无 JS 报错（pageerror / 应用 console.error）", len(real) == 0, "; ".join(real[:4]))
        browser.close()

    httpd.shutdown()
    print("CARD_DETECT_OK" if ok else "CARD_DETECT_FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
