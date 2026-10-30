# -*- coding: utf-8 -*-
"""证件照导出的行为特征测试（characterization test）。

目的：在**不改产品代码**的前提下，把「批量导出」当前的对外行为钉死，作为
`IdPhoto.tsx` 拆分（composeOne / composeMany 抽取）的安全网。断言的是
**导出产物本身**：文件名、份数、每张的像素尺寸、DPI、JPEG 格式；
而不是内部实现细节 —— 所以重构只要行为不变，它就一直绿。

为什么不用单测：合成管线写在组件 effect 里，没有可 import 的边界。
等步骤 2 抽出 `lib/idphotoCompose.ts` 后，这层继续守着「真实产物」，
新加的 lib 单测守「调用参数」，两层互补。

环境技巧（无 Electron）：静态服务把 `/res/**` 映射到 `resources/**`，
注入 `electronAPI.appResBase` 让抠图/人脸模型能加载；把 <a download> 的点击
拦成记录，并用 createObjectURL 的桩拿住 Blob 取字节。

用法：
  python tools/export_characterization.py            # 比对基线
  python tools/export_characterization.py --update    # 重写基线（行为有意变更时）
产物：.tmp/export-char/*.jpg + report.json，基线 .characterization/idphoto-export.json
"""
from __future__ import annotations

import base64
import functools
import http.server
import json
import os
import socketserver
import sys
import threading
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
RES = ROOT / "resources"
OUT = ROOT / ".tmp" / "export-char"
GOLDEN = ROOT / ".characterization" / "idphoto-export.json"
DPI = 300

# 参与特征化的规格：mm 与名称必须和 src/lib/cardLayout.ts 的 PHOTO_PRESETS 一致
SPECS = {"1寸 25×35": (25, 35), "2寸 35×49": (35, 49)}

INIT = """
window.__blobs = [];
window.__cap = [];
const _cou = URL.createObjectURL.bind(URL);
URL.createObjectURL = function (b) { const u = _cou(b); window.__blobs.push({ url: u, blob: b }); return u; };
const _click = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  if (this.download) { window.__cap.push({ name: this.download, url: this.href }); return; }
  return _click.call(this);
};
"""


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def translate_path(self, path):
        if path.startswith("/res/"):
            rel = path[len("/res/"):].split("?")[0]
            return str(RES / rel)
        return super().translate_path(path)


def mm_to_px(mm: float) -> int:
    return round(mm * DPI / 25.4)


def main() -> int:
    update = "--update" in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    if not (DIST / "index.html").exists():
        raise SystemExit("dist 不存在，先 npm run build")

    httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(DIST)))
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    def drive() -> tuple[list[dict], list[str]]:
        """跑一遍浏览器流程，返回 (payload, consoleErrors)。

        抽成函数是为了「超时重试一次」：本机的 onnxruntime 推理偶尔会在 Worker 里
        挂住不回（两个 Worker 都只回进度消息、永不出结果），换一个浏览器实例就好。
        那是宿主环境的抖动，不是产品行为，所以不让它把门禁打成红 —— 但只对
        **超时** 重试，断言失败照样立刻红。
        """
        errors: list[str] = []
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append("pageerror: %s" % e))
            page.add_init_script(INIT)
            page.add_init_script("window.electronAPI = { appResBase: 'http://127.0.0.1:%d/res/' };" % port)
            page.goto("http://127.0.0.1:%d/index.html" % port, wait_until="load")
            page.wait_for_timeout(1200)
            page.get_by_text("证件照批量处理", exact=False).first.click()
            page.wait_for_timeout(1200)

            page.get_by_text("演示照片", exact=True).first.click()
            page.wait_for_selector(".idp-photo-card", timeout=180000)
            page.wait_for_timeout(2500)

            def export(label: str) -> list[dict]:
                page.evaluate("window.__cap = []")
                page.get_by_text("开始导出", exact=True).first.click()
                page.wait_for_function("window.__cap.length > 0", timeout=180000)
                page.wait_for_timeout(1500)  # 等批量写完
                shots = page.evaluate("window.__cap")
                print("  [%s] 捕获 %d 份" % (label, len(shots)))
                return shots

            # A) 单规格快速路径：默认只勾当前规格
            single = export("单规格")
            # B) 多规格：勾上第二规格，每尺寸独立构图
            page.locator(".idp-size input").nth(1).check()
            page.wait_for_timeout(300)
            multi = export("多规格")

            # 取字节：直接对桩住的 Blob 读（避开 revokeObjectURL 的 5s 竞态）
            payload = []
            for group, shots in (("single", single), ("multi", multi)):
                for s in shots:
                    b64 = page.evaluate(
                        """async (url) => {
                        const hit = window.__blobs.filter((x) => x.url === url).pop();
                        if (!hit) return null;
                        const buf = new Uint8Array(await hit.blob.arrayBuffer());
                        let out = '';
                        for (let i = 0; i < buf.length; i += 0x8000) {
                          out += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
                        }
                        return btoa(out);
                    }""",
                        s["url"],
                    )
                    payload.append({"group": group, "name": s["name"], "b64": b64})
            browser.close()
        return payload, errors

    payload: list[dict] = []
    errors: list[str] = []
    try:
        for attempt in (1, 2):
            try:
                payload, errors = drive()
                break
            except PlaywrightTimeout as e:
                first = str(e).splitlines()[0]
                if attempt == 2:
                    raise SystemExit("抠图/导出超时（已重试 1 次）：%s" % first)
                print("  [retry] 首轮超时，重开浏览器再跑一次（%s）" % first)
    finally:
        httpd.shutdown()

    from PIL import Image

    files = []
    for i, item in enumerate(payload):
        if item["b64"] is None:
            raise SystemExit("取不到字节：%s" % item["name"])
        raw = base64.b64decode(item["b64"])
        path = OUT / ("%02d-%s" % (i, item["group"])) / os.path.basename(item["name"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        im = Image.open(path)
        files.append(
            {
                "group": item["group"],
                "name": item["name"],
                "format": im.format,
                "w": im.size[0],
                "h": im.size[1],
                "dpi": [round(float(v)) for v in (im.info.get("dpi") or ())],
                "bytes": len(raw),
            }
        )

    # ---------- 断言 ----------
    checks = []

    def check(name, ok, detail=""):
        checks.append({"name": name, "ok": bool(ok), "detail": str(detail)})
        print(("  [PASS] " if ok else "  [FAIL] ") + name + (("  " + detail) if detail else ""))

    singles = [f for f in files if f["group"] == "single"]
    multis = [f for f in files if f["group"] == "multi"]

    check("单规格导出份数 = 照片数", len(singles) == 2, "got %d" % len(singles))
    check("多规格导出份数 = 2 规格 × 照片数", len(multis) == 4, "got %d" % len(multis))
    check(
        "文件名带规格名",
        all(any(("_" + s) in f["name"] for s in SPECS) for f in files),
        ", ".join(f["name"] for f in files[:2]),
    )
    check("全部为 JPEG", all(f["format"] == "JPEG" for f in files), str({f["format"] for f in files}))
    check(
        "全部写入 300 DPI",
        all(f["dpi"] == [DPI, DPI] for f in files),
        str(sorted({tuple(f["dpi"]) for f in files})),
    )

    dims_ok, dims_detail = True, []
    for f in files:
        spec = next((s for s in SPECS if ("_" + s) in f["name"]), None)
        if not spec:
            dims_ok = False
            dims_detail.append("%s 无规格" % f["name"])
            continue
        mmw, mmh = SPECS[spec]
        exp = (mm_to_px(mmw), mm_to_px(mmh))
        if (f["w"], f["h"]) != exp:
            dims_ok = False
            dims_detail.append("%s 期望 %s 实际 %s" % (spec, exp, (f["w"], f["h"])))
    check("每张像素尺寸等于该规格 @300DPI", dims_ok, "; ".join(dims_detail[:3]))

    # 同一张图在两个规格下必须是两份不同的产物（不是把一份缩放/复制）
    by_photo = {}
    for f in multis:
        base = f["name"].rsplit("_", 1)[0]
        by_photo.setdefault(base, set()).add((f["w"], f["h"]))
    check(
        "同一照片在两个规格下产出两种尺寸",
        by_photo and all(len(v) == 2 for v in by_photo.values()),
        str({k: sorted(v) for k, v in by_photo.items()})[:160],
    )

    check("控制台无错误", not errors, errors[0][:120] if errors else "")

    # ---------- 基线 ----------
    current = {
        "generatedBy": "tools/export_characterization.py",
        "dpi": DPI,
        "files": [{k: f[k] for k in ("group", "name", "format", "w", "h", "dpi")} for f in files],
    }
    diff = []
    if update or not GOLDEN.exists():
        GOLDEN.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN.write_text(json.dumps(current, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("  基线已写入 %s" % GOLDEN.relative_to(ROOT))
    else:
        old = json.loads(GOLDEN.read_text(encoding="utf-8"))
        key = lambda f: (f["group"], f["name"])
        old_map = {key(f): f for f in old["files"]}
        new_map = {key(f): f for f in current["files"]}
        for k in sorted(set(old_map) | set(new_map)):
            a, b = old_map.get(k), new_map.get(k)
            if a is None or b is None:
                diff.append("份数/命名变化：%s" % (k,))
                continue
            for field in ("format", "w", "h", "dpi"):
                if a[field] != b[field]:
                    diff.append("%s 的 %s：%s → %s" % (b["name"], field, a[field], b[field]))
        check("与基线一致（命名/尺寸/DPI/格式）", not diff, "; ".join(diff[:3]))

    report = {"checks": checks, "files": files, "diff": diff, "consoleErrors": errors}
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    ok = all(c["ok"] for c in checks)
    print("\n  %d/%d 通过，产物目录 %s" % (sum(1 for c in checks if c["ok"]), len(checks), OUT))
    print("EXPORT_CHAR_OK" if ok else "EXPORT_CHAR_FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
