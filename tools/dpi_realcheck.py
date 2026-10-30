"""真实环境验证：用 Chromium 画布产出的真 JPEG 走 withJpegDpi，再用 PIL 读回 DPI。

为什么要真跑：单测用的是手造字节，只能证明「偏移写对了」；这里要证明两件事——
1) canvas.toBlob 出来的 JPEG 首段确实是 JFIF APP0（否则我们的补写直接不生效）；
2) 补写后的文件被第三方解码器（Pillow）读出来就是 300 DPI，长度与像素不变。

用法：python tools/dpi_realcheck.py
"""

from __future__ import annotations

import base64
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".tmp" / "dpi"
PORT = 5199
PY = sys.executable


def wait_server(url: str, timeout: float = 40.0) -> None:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(0.4)
    raise SystemExit(f"开发服务器未就绪：{url}")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    from playwright.sync_api import sync_playwright

    vite = subprocess.Popen(
        ["node", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", str(PORT), "--strictPort", "--logLevel", "error"],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_server(f"http://127.0.0.1:{PORT}/")
        with sync_playwright() as p:
            b = p.chromium.launch()
            page = b.new_page()
            page.goto(f"http://127.0.0.1:{PORT}/", wait_until="domcontentloaded")
            data = page.evaluate(
                """async () => {
                const mod = await import('/src/lib/dpiTag.ts');
                const c = document.createElement('canvas');
                c.width = 295; c.height = 413;           // 一寸 @300DPI
                const ctx = c.getContext('2d');
                ctx.fillStyle = '#f5f6f8'; ctx.fillRect(0, 0, c.width, c.height);
                ctx.fillStyle = '#1e63ec'; ctx.fillRect(10, 10, 120, 60);
                const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
                const bytes = new Uint8Array(await blob.arrayBuffer());
                const tagged = mod.withJpegDpi(bytes, 300);
                const b64 = (a) => {
                  let s = '';
                  for (let i = 0; i < a.length; i += 0x8000) {
                    s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
                  }
                  return btoa(s);
                };
                return {
                  raw: b64(bytes), tagged: b64(tagged),
                  rawLen: bytes.length, taggedLen: tagged.length,
                  head: [...bytes.slice(0, 20)],
                };
            }"""
            )
            b.close()
    finally:
        vite.terminate()
        try:
            vite.wait(timeout=10)
        except Exception:
            vite.kill()

    raw = base64.b64decode(data["raw"])
    tagged = base64.b64decode(data["tagged"])
    (OUT / "raw.jpg").write_bytes(raw)
    (OUT / "tagged.jpg").write_bytes(tagged)

    from PIL import Image

    def probe(path: Path) -> dict:
        im = Image.open(path)
        return {
            "size": im.size,
            "dpi": tuple(round(float(x)) for x in im.info.get("dpi", ()) or ()),
            "jfif_density": im.info.get("jfif_density"),
            "jfif_unit": im.info.get("jfif_unit"),
        }

    a, b = probe(OUT / "raw.jpg"), probe(OUT / "tagged.jpg")
    # 字节级必然不同（4 个字节被改写），所以用 PIL 解码后的像素做等价性判断
    pa = Image.open(OUT / "raw.jpg").tobytes()
    pb = Image.open(OUT / "tagged.jpg").tobytes()
    pixels_equal = pa == pb

    print(json.dumps({"head": data["head"], "raw": a, "tagged": b,
                      "len": [data["rawLen"], data["taggedLen"]],
                      "pixels_identical": pixels_equal}, ensure_ascii=False, indent=2))

    ok = (
        a["jfif_unit"] == 0
        and b["jfif_unit"] == 1
        and b["dpi"] == (300, 300)
        and data["rawLen"] == data["taggedLen"]
        and pixels_equal
        and a["size"] == b["size"]
    )
    print("DPI_REALCHECK_OK" if ok else "DPI_REALCHECK_FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
