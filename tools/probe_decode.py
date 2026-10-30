# -*- coding: utf-8 -*-
"""微基准：50 张 12MP 照片的「采样解码」路径对比（inspect 阶段热点）。

对比 three 路径（各 10 张，取均值）：
  A. new Image() 加载 + drawImage 到 256 宽 canvas + getImageData  ← 当前 inspect 做法
  B. createImageBitmap(file)（全解码拿原尺寸）+ drawImage 到 256 + getImageData
  C. createImageBitmap(file, {resizeWidth:256})（解码器直接降采样）+ getImageData
另测：把 1024 PNG matte 解码 + draw 到 310×413（合成路径的人物层准备）。
"""
import glob
import json
import os
import subprocess
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ELECTRON = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")
PORT = 9391
files = sorted(glob.glob(os.path.join(ROOT, ".tmp", "bench50", "*.jpg")))[:10]
base = "app://local/"

CODE = r"""
async (paths) => {
  const urls = paths.map((p) => p);
  const out = { A: [], B: [], C: [] };
  const loadImg = (src) => new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src;
  });
  const t = () => performance.now();
  for (const u of urls) {
    // A
    let s = t();
    const img = await loadImg(u);
    const c = document.createElement('canvas');
    c.width = 256; c.height = Math.round(256 * img.naturalHeight / img.naturalWidth);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    c.getContext('2d').getImageData(0, 0, c.width, c.height);
    out.A.push(t() - s);
    // B
    s = t();
    const blob = await (await fetch(u)).blob();
    const bmp = await createImageBitmap(blob);
    const c2 = document.createElement('canvas');
    c2.width = 256; c2.height = Math.round(256 * bmp.height / bmp.width);
    c2.getContext('2d').drawImage(bmp, 0, 0, c2.width, c2.height);
    c2.getContext('2d').getImageData(0, 0, c2.width, c2.height);
    bmp.close?.();
    out.B.push(t() - s);
    // C
    s = t();
    const bmp2 = await createImageBitmap(blob, { resizeWidth: 256, resizeQuality: 'low' });
    const c3 = document.createElement('canvas');
    c3.width = bmp2.width; c3.height = bmp2.height;
    c3.getContext('2d').drawImage(bmp2, 0, 0);
    c3.getContext('2d').getImageData(0, 0, c3.width, c3.height);
    bmp2.close?.();
    out.C.push(t() - s);
  }
  const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  const dims = await createImageBitmap(await (await fetch(urls[0])).blob());
  return {
    A_img_ms: avg(out.A), B_bitmapFull_ms: avg(out.B), C_bitmapResize_ms: avg(out.C),
    sample: [dims.width, dims.height],
  };
}
"""

env = dict(os.environ)
env.pop("ELECTRON_RUN_AS_NODE", None)
proc = subprocess.Popen([ELECTRON, ".", "--remote-debugging-port=%d" % PORT], cwd=ROOT, env=env,
                        stdout=open(os.path.join(ROOT, ".tmp", "probe3.log"), "wb"), stderr=subprocess.STDOUT)
try:
    from playwright.sync_api import sync_playwright
    deadline = time.time() + 40
    while time.time() < deadline:
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            if json.loads(opener.open("http://127.0.0.1:%d/json/list" % PORT, timeout=2).read()):
                break
        except Exception:
            time.sleep(0.4)
    with sync_playwright() as pw:
        br = pw.chromium.connect_over_cdp("http://127.0.0.1:%d" % PORT)
        pg = [p for p in br.contexts[0].pages if "index.html" in (p.url or "")][0]
        pg.wait_for_selector(".toolcard", timeout=30000)
        # 通过 fetch 读取本地文件：app:// 协议下用 /@fs 不行，改为直接读 file:// 拦截？改用 CDP 注入 blob：
        # 简单起见：把文件读成 base64 传给页面转 Blob URL
        import base64
        blobs = []
        for p in files:
            with open(p, "rb") as f:
                b64 = base64.b64encode(f.read()).decode()
            url = pg.evaluate(
                "async (b64) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length);"
                " for (let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);"
                " return URL.createObjectURL(new Blob([u8], {type:'image/jpeg'})); }", b64)
            blobs.append(url)
        res = pg.evaluate(CODE, blobs)
        print(json.dumps(res, ensure_ascii=False), flush=True)
        br.close()
finally:
    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, timeout=25)
