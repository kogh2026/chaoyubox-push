# -*- coding: utf-8 -*-
"""GUI 侧 adapter —— 在**真实浏览器**里跑爱印官方 worker，并抓画布像素 + 屏幕截图。

与 official_worker（Node 托管）的区别：
- Node 路径拿到的是 worker 返回的裸 RGBA，**没有**「画到 canvas → 合成上屏」这一段；
- GUI 路径经过 chromium 的 canvas 2D 实现、合成器、色彩管理与设备像素比，
  这才是用户屏幕上真正看到的东西。差异（若有）只会出现在这一段。

两种模式
--------
1) `render`（默认，可进 CI）：本目录的 `gui_host.html` 起一个最小宿主页，
   把 vendor worker 作为**真 Web Worker** 加载（`/vendor/card-correction-worker.js` +
   `/vendor/onnxruntime-web/ort.min.js`，路径与爱印 app 内的绝对路径一致），
   worker 返回的 ImageData 用 `putImageData` 画到 1:1 的 canvas 上。
2) `attach`（真机）：连接**已在运行的**爱印桌面端（Electron 支持 CDP），
   用 `chromium.connectOverCDP` 接管，找页面里的 canvas 截图。
   启动方式：`"爱印工具箱.exe" --remote-debugging-port=9222`

产出（out_dir 下）
------------------
    gui_canvas/<key>__p<i>.png   画布回读（canvas.toDataURL('image/png')，无损，权威像素）
    gui_shot/<key>__p<i>.png     element screenshot（合成上屏后的真实屏幕像素）
    gui/manifest.json            每张卡的几何/耗时/DPR/score/angle

返回结构刻意与 `adapter_official_worker.OfficialWorkerNode.run_batch` 对齐，
以便 harness 直接把 GUI 侧当"官方侧"用；`self.gui_metrics[key]` 另存截图保真度指标。

自测：python tools/aiyin_compare/adapter_official_gui.py --limit 2
"""
from __future__ import annotations

import base64
import json
import os
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote

from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
HOST_PAGE = HERE / "gui_host.html"

sys.path.insert(0, str(HERE.parent))  # tools/ —— 取 tmproot
from tmproot import tmp_root  # noqa: E402

BROWSER_DIR_NAME = "ms-playwright"


def _has_chromium(base: Path) -> bool:
    """目录里是否真有可用的 chromium 可执行文件。

    只判「目录存在且非空」会误判——下载中断会留下 `chromium-1148/` 半成品
    （本机就是 22 MB 的残骸），照样 launch 失败。所以必须找到 chrome.exe。
    """
    if not base.is_dir():
        return False
    for d in base.glob("chromium-*"):
        if d.is_dir() and any(d.glob("chrome-win*/chrome.exe")):
            return True
    return False


def adopt_tmp_env() -> None:
    """把本进程的临时目录也改到 D 盘。

    Playwright 每建一个 context 就在 `%TEMP%` 下拉一个浏览器 user-data-dir
    （全量跑一轮能留下几十上百 MB，且浏览器异常退出时不会清）。Python 的
    `tempfile` 与浏览器子进程都读这三个环境变量，所以在这里统一改掉，
    并同步 `tempfile.tempdir`（它可能已被首次调用缓存过）。
    """
    base = tmp_root() / "tmp"
    base.mkdir(parents=True, exist_ok=True)
    for k in ("TMP", "TEMP", "TMPDIR"):
        os.environ[k] = str(base)
    import tempfile

    tempfile.tempdir = str(base)


def ensure_browser_dir(log=print) -> None:
    """把 Playwright 的浏览器目录默认收到仓库 `.tmp/ms-playwright`（D 盘）。

    只在「用户没显式设置 且 系统默认位置没有**可用**浏览器」时才改：
    已经装好的机器不受影响（不搬、不重下）。
    必须在 `sync_playwright()` 之前调用——registry 到启动那一刻才读环境变量。
    """
    if os.environ.get("PLAYWRIGHT_BROWSERS_PATH"):
        return
    local = os.environ.get("LOCALAPPDATA", "")
    default = Path(local) / BROWSER_DIR_NAME if local else None
    if default and _has_chromium(default):
        return  # 系统默认位置已有可用浏览器，沿用
    target = tmp_root() / BROWSER_DIR_NAME
    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(target)
    log(f"  Playwright 浏览器目录 -> {target}（默认位置无可用浏览器，改落 D 盘）")
    if not _has_chromium(target):
        log(f"    尚未安装，需要时执行：$env:PLAYWRIGHT_BROWSERS_PATH='{target}'; "
            f"python -m playwright install chromium")

# 浏览器依赖的显式提示（缺依赖时给出可复制的修复命令，而不是 Playwright 的英文堆栈）
INSTALL_HINT = (
    "找不到可用的 Chromium 内核浏览器。三选一：\n"
    "  A) 安装 Playwright 自带浏览器（推荐，版本可控）：\n"
    "         python -m playwright install chromium\n"
    "     （首次约 200 MB；C 盘空间不足时把浏览器装到其它盘：\n"
    "         set PLAYWRIGHT_BROWSERS_PATH=D:\\playwright-browsers\n"
    "     并把 TMP/TEMP 也指到同一块盘，否则解压阶段仍会 ENOSPC）\n"
    "  B) 直接用系统已装的 Chrome / Edge（同一 Blink 内核，adapter 会自动回退）\n"
    "  C) 用 AIYIN_PW_BROWSER=<chrome/msedge 或 exe 绝对路径> 显式指定"
)

# 系统浏览器回退顺序：Playwright 自带 chromium → chrome → msedge
# 为什么可以回退：三者同为 Blink + 同一 canvas 2D 实现，DPR=1/1:1 显示下
# 截图链路噪声一致（实测均为 0）；换浏览器只影响版本固定的可复现性，不影响判定口径。
FALLBACK_CHANNELS = ("chrome", "msedge")


def _safe(s: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in s)[:140]


class _Handler(SimpleHTTPRequestHandler):
    """只读静态服务；把爱印 app 里的绝对路径映射到本机真实文件。"""

    def __init__(self, *a, routes: dict, host_html: bytes, **kw):
        self.routes = routes
        self.host_html = host_html
        super().__init__(*a, directory=str(HERE), **kw)

    def log_message(self, *a):  # 静音
        pass

    def _send(self, body: bytes, ctype: str, code: int = 200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        path = unquote(self.path.split("?", 1)[0])
        if path in ("/", "/index.html"):
            return self._send(self.host_html, "text/html; charset=utf-8")
        fp = self.routes.get(path)
        if fp is None:
            return self._send(b"404", "text/plain", 404)
        fp = Path(fp)
        if not fp.exists():
            return self._send(f"missing: {fp}".encode(), "text/plain", 404)
        ctype = {
            ".js": "text/javascript; charset=utf-8",
            ".mjs": "text/javascript; charset=utf-8",
            ".wasm": "application/wasm",
            ".html": "text/html; charset=utf-8",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".onnx": "application/octet-stream",
        }.get(fp.suffix.lower(), "application/octet-stream")
        return self._send(fp.read_bytes(), ctype)


class _Server:
    def __init__(self, routes: dict):
        host_html = HOST_PAGE.read_bytes()
        handler = partial(_Handler, routes=routes, host_html=host_html)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *a):
        self.httpd.shutdown()
        self.httpd.server_close()


class OfficialGuiAdapter:
    """用 Playwright 驱动真实 chromium，抓爱印 worker 的画布输出与屏幕截图。"""

    def __init__(self, worker_js: str, model_path: str, max_pages: int = 2,
                 min_area_frac: float = 0.04, css_scale: float = 1.0,
                 dpr: int = 1, serve_original: bool = False,
                 headless: bool = True, timeout_ms: int = 240000):
        self.worker_js = Path(worker_js).resolve()
        self.model_path = Path(model_path).resolve()
        self.ort_dir = ROOT / "node_modules" / "onnxruntime-web" / "dist"
        self.max_pages = max_pages
        self.min_area_frac = min_area_frac
        self.css_scale = css_scale
        self.dpr = dpr
        self.serve_original = serve_original
        self.headless = headless
        self.timeout_ms = timeout_ms
        self.gui_metrics: dict[str, dict] = {}
        self.last_stats: dict = {}

    # ---------- 浏览器选择 ----------
    def _launch_browser(self, pw, log=print):
        """自带 chromium 优先，缺失时回退到系统 Chrome/Edge（同 Blink 内核）。"""
        forced = os.environ.get("AIYIN_PW_BROWSER", "").strip()
        if forced:
            if forced.lower() in ("chrome", "msedge"):
                log(f"  使用指定浏览器 channel={forced}")
                return pw.chromium.launch(headless=self.headless, channel=forced), f"channel:{forced}"
            log(f"  使用指定浏览器 {forced}")
            return pw.chromium.launch(headless=self.headless, executable_path=forced), forced
        last = None
        try:
            b = pw.chromium.launch(headless=self.headless)
            log("  浏览器：Playwright 自带 chromium")
            return b, "playwright-chromium"
        except Exception as e:  # noqa: BLE001
            last = e
        for ch in FALLBACK_CHANNELS:
            try:
                b = pw.chromium.launch(headless=self.headless, channel=ch)
                log(f"  Playwright 自带 chromium 不可用，回退系统 {ch}")
                return b, f"channel:{ch}"
            except Exception as e:  # noqa: BLE001
                last = e
        raise RuntimeError(f"{INSTALL_HINT}\n原始错误：{last}")

    # ---------- 模式 1：自带宿主页 ----------
    def _routes(self, img_dir: Path) -> dict:
        routes = {
            "/vendor/card-correction-worker.js": self.worker_js,
            "/vendor/onnxruntime-web/ort.min.js": self.ort_dir / "ort.min.js",
            "/model/card-correction-fp32.onnx": self.model_path,
        }
        # ort 会按 wasmPaths 约定再请求 .wasm/.mjs，逐个映射
        for f in self.ort_dir.iterdir():
            if f.is_file():
                routes[f"/vendor/onnxruntime-web/{f.name}"] = f
        for f in img_dir.iterdir():
            routes[f"/img/{f.name}"] = f
        return routes

    def run_batch(self, entries: list[tuple[str, Path]], out_dir: Path, log=print
                  ) -> dict[str, list[dict]]:
        out_dir = Path(out_dir).resolve()
        canvas_dir = out_dir / "gui_canvas"
        shot_dir = out_dir / "gui_shot"
        img_dir = out_dir / "_imgs"
        for d in (canvas_dir, shot_dir, img_dir):
            d.mkdir(parents=True, exist_ok=True)

        # 统一输入：PIL 解码成 PNG 再喂浏览器（隔离"浏览器 JPEG 解码器 vs libjpeg"的 ±1 差异）
        # 落盘用 **纯 ASCII 序号名**：中文文件名进 URL 会被浏览器百分号编码，
        # 静态服务按原始路径查表就 404，浏览器报 "The source image could not be decoded"。
        served: list[tuple[str, Path]] = []
        for i, (key, p) in enumerate(entries):
            if self.serve_original:
                dst = img_dir / f"{i:05d}{p.suffix.lower()}"
                dst.write_bytes(p.read_bytes())
            else:
                dst = img_dir / f"{i:05d}.png"
                Image.open(p).convert("RGBA").save(dst)
            served.append((key, dst))

        from playwright.sync_api import sync_playwright

        result: dict[str, list[dict]] = {}
        manifest: list[dict] = []
        errors: list[dict] = []
        adopt_tmp_env()
        ensure_browser_dir(log)
        with _Server(self._routes(img_dir)) as srv, sync_playwright() as pw:
            browser, browser_kind = self._launch_browser(pw, log)
            ctx = browser.new_context(device_scale_factor=self.dpr, viewport={"width": 1200, "height": 900})
            page = ctx.new_page()
            page.goto(f"http://127.0.0.1:{srv.port}/", wait_until="load")
            log(f"  GUI 宿主页就绪：http://127.0.0.1:{srv.port}/ (dpr={self.dpr}, cssScale={self.css_scale})")
            loc = page.locator("#cv")

            for key, img in served:
                t0 = time.time()
                try:
                    page.evaluate(
                        """async (o) => { await window.__init(o); }""",
                        {
                            "modelUrl": "/model/card-correction-fp32.onnx",
                            "imgUrl": f"/img/{quote(img.name)}",
                            "maxPages": self.max_pages,
                            "minAreaFrac": self.min_area_frac,
                            "cssScale": self.css_scale,
                        },
                    )
                    info = page.evaluate("() => window.__gui.result")
                    # 视口贴合画布 + 重新做设备像素对齐：
                    # 画布比视口大时，居中的 flex 容器会向左溢出，截图的 clip 会错位
                    # （实测 2616px 卡错位后 mae 飙到 131）。固定留 24px 边距后重对齐。
                    PAD = 24
                    # 视口要按 **CSS 尺寸** 算：cssScale≠1 时画布的 CSS 宽屏大于内在宽，
                    # 用内在尺寸算会让画布溢出视口、截图 clip 错位（实测 mae 飙到 90+）
                    cw_css = int(round(info.get("cssWidth") or info["width"]))
                    ch_css = int(round(info.get("cssHeight") or info["height"]))
                    vw = min(cw_css + PAD * 2, 4000)
                    vh = min(ch_css + PAD * 2, 4000)
                    page.set_viewport_size({"width": int(vw), "height": int(vh)})
                    snapped = page.evaluate("() => window.__snap()")
                    info["cssWidth"] = snapped["width"]
                    info["cssHeight"] = snapped["height"]
                    info["canvas_origin"] = [snapped["left"], snapped["top"]]
                    info["integer_aligned"] = snapped["integerAligned"]
                    if not snapped["integerAligned"]:
                        log(f"  ! 画布坐标非整数（{snapped['left']},{snapped['top']}），截图会重采样")
                    # 1) 画布回读（权威、无损）
                    data_url = page.evaluate("() => window.__gui.canvasDataUrl()")
                    canvas_png = canvas_dir / f"{_safe(key)}__p0.png"
                    canvas_png.write_bytes(base64.b64decode(data_url.split(",", 1)[1]))
                    # 2) 屏幕截图（合成后）
                    shot_png = shot_dir / f"{_safe(key)}__p0.png"
                    loc.screenshot(path=str(shot_png))

                    result.setdefault(key, []).append({
                        "page": 0, "png": canvas_png, "shot": shot_png,
                        "width": info["width"], "height": info["height"],
                        "score": info.get("score"), "angle": info.get("angle"),
                        "upright_turns": info.get("uprightTurns"),
                        "css_width": info.get("cssWidth"), "css_height": info.get("cssHeight"),
                        "dpr": info.get("dpr"), "css_scale": info.get("cssScale"),
                    })
                    self.gui_metrics[key] = {
                        "canvas_png": str(canvas_png), "shot_png": str(shot_png),
                        "canvas_size": [info["width"], info["height"]],
                        "css_size": [info.get("cssWidth"), info.get("cssHeight")],
                        "dpr": info.get("dpr"), "css_scale": info.get("cssScale"),
                        "wall_ms": info.get("wallMs"), "inference_ms": info.get("inferenceMs"),
                        "passes": info.get("passes"), "room": info.get("room"),
                    }
                    manifest.append({"key": key, "ok": True, "page": 0, **{k: v for k, v in info.items()},
                                     "elapsed_ms": round((time.time() - t0) * 1000)})
                    log(f"  [gui] {key}: {info['width']}x{info['height']} "
                        f"score={float(info.get('score') or 0):.3f} {time.time() - t0:.1f}s")
                except Exception as e:  # noqa: BLE001
                    msg = str(e).splitlines()[0][:300]
                    errors.append({"key": key, "error": msg})
                    result[key] = []
                    log(f"  ! [gui] 失败 {key}: {msg}")
            browser.close()

        (out_dir / "gui").mkdir(parents=True, exist_ok=True)
        (out_dir / "gui" / "manifest.json").write_text(
            json.dumps({"mode": "render", "browser": browser_kind, "dpr": self.dpr,
                        "css_scale": self.css_scale, "items": manifest, "errors": errors},
                       ensure_ascii=False, indent=2),
            encoding="utf-8")
        self.last_stats = {"mode": "render", "browser": browser_kind,
                           "n": len(manifest), "errors": len(errors)}
        return result

    # ---------- 模式 2：接管真实爱印 app ----------
    def attach_app(self, out_dir: Path, cdp_url: str = "http://127.0.0.1:9222",
                   selector: str = "canvas", log=print) -> dict:
        """连接已在运行的官方桌面端（需带 --remote-debugging-port），截取指定 canvas。

        注意：app 内的加载/识别流程仍需人工点击（我们不模拟 UI 操作，避免与官方
        交互逻辑耦合）。本方法只负责"找到画布 → 抓画布像素 + 截图"。
        """
        from playwright.sync_api import sync_playwright

        out_dir = Path(out_dir).resolve()
        shot_dir = out_dir / "gui_shot"
        shot_dir.mkdir(parents=True, exist_ok=True)
        adopt_tmp_env()
        ensure_browser_dir(log)
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.connect_overCDP(cdp_url)
            except Exception as e:  # noqa: BLE001
                raise RuntimeError(
                    f"无法连接 {cdp_url}。请先以调试端口启动爱印桌面端：\n"
                    f'    "爱印工具箱.exe" --remote-debugging-port=9222\n原始错误：{e}') from e
            pages = [pg for c in browser.contexts for pg in c.pages]
            log(f"  CDP 已连接：{len(pages)} 个页面")
            hits = []
            for pg in pages:
                try:
                    n = pg.locator(selector).count()
                except Exception:  # noqa: BLE001
                    continue
                if n:
                    hits.append((pg, n))
            if not hits:
                raise RuntimeError(f"未找到匹配 {selector!r} 的页面（app 界面可能还没打开识别结果）")
            pg, n = hits[0]
            el = pg.locator(selector).first
            shot = shot_dir / "app_canvas.png"
            el.screenshot(path=str(shot))
            box = el.bounding_box()
            info = {"mode": "attach", "cdp_url": cdp_url, "pages": len(pages),
                    "canvas_count": n, "shot": str(shot), "box": box,
                    "page_title": (pg.title() or "")[:120]}
            (out_dir / "gui").mkdir(parents=True, exist_ok=True)
            (out_dir / "gui" / "attach_manifest.json").write_text(
                json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
            log(f"  已截图：{shot} box={box}")
            return info


def main_demo(limit: int = 2, css_scale: float = 1.0):
    import adapter_official_worker as aow  # 仅用于对照打印
    import lib_gui_diff

    model = ROOT / "resources" / "card-model" / "card-correction-fp32.onnx"
    worker_js = r"D:/Downloads/2026-10-23-08-38-11/aiyin_decrypted_assets/vendor/id2pdf-card-correction-worker.js"
    d = Path(r"C:/Users/Coldhack/Desktop/下载结果/身份证人像面")
    imgs = sorted(p for p in d.iterdir() if p.suffix.lower() == ".jpg")[:limit]
    out = ROOT / ".tmp/gui_demo"

    print(f"GUI adapter 自测：{len(imgs)} 张，cssScale={css_scale}")
    gui = OfficialGuiAdapter(worker_js, str(model), css_scale=css_scale)
    res = gui.run_batch([(f"demo__{p.name}", p) for p in imgs], out, log=print)

    # 官方 worker 基准（Node），用于证明画布==worker、截图只是多了一层上屏
    nw = aow.OfficialWorkerNode(worker_js, str(model))
    ref = nw.run_batch([(f"demo__{p.name}", p) for p in imgs], out / "official", log=lambda m: None)

    print()
    print(f"{'key':<32}{'画布vsWorker':<16}{'截图vs画布':<14}{'截图vsWorker':<16}{'verdict'}")
    for key, pages in res.items():
        if not pages:
            print(f"{key:<32}无产出")
            continue
        worker_png = ref.get(key, [{}])[0].get("png")
        g = lib_gui_diff.compare_gui(
            shot=Path(pages[0]["shot"]), canvas_native=Path(pages[0]["png"]),
            worker=Path(worker_png) if worker_png else None,
            tol=lib_gui_diff.DEFAULT_TOL)
        print(f"{key:<32}{g.canvas_vs_worker_mae:<16.4f}{g.floor_mae:<14.4f}"
              f"{g.content_mae:<16.4f}{g.verdict}")
        if g.notes:
            for n in g.notes:
                print(f"    - {n}")
    print(f"\n产出目录：{out}")


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=2)
    ap.add_argument("--css-scale", type=float, default=1.0)
    a = ap.parse_args()
    main_demo(a.limit, a.css_scale)
