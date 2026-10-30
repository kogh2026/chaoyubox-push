# -*- coding: utf-8 -*-
"""批量性能基准：50 张 12MP 一寸照源片 → 抠图 → 合成 → 切换红底。

全部计时在页面内用 rAF 采样（排除 Playwright 上传文件的协议开销）：
  t0            input 'change' 事件（捕获阶段，早于 React onChange）
  matte_ms      t0 → 50 张全部出现「已处理/失败」角标
  compose1_ms   t0 → 50 张结果图首次全部出现（白底）
  switch_red_ms 点击「红底」→ 首张结果图 src 变化（合成整批一次性 setState）
  switch_white_ms 再切回白底（验证是否有重复计算）
同时统计 canvas API 调用次数/累计耗时、getImageData 像素总量、长任务、JS 堆。

用法： python tools/bench_batch50.py --label baseline --n 50
产物： .tmp/bench-batch50/<label>.json
"""
import argparse
import json
import os
import platform
import subprocess
import sys
import time
import urllib.request
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, ".tmp", "bench-batch50")
PHOTOS = os.path.join(ROOT, ".tmp", "bench50")
ELECTRON = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")

os.makedirs(OUT, exist_ok=True)

SETUP = r"""
(n) => {
  if (window.__bench) return 'already';
  const canvasStat = () => ({ canvas: {}, gidPixels: 0, gidMax: 0, longtask: { count: 0, total: 0, max: 0 }, mem: null });
  const B = {
    n,
    phase: 'idle',
    result: {},
    cur: canvasStat(),
    armedSrc: null,
  };
  window.__bench = B;
  const add = (k, dt) => {
    const s = B.cur.canvas[k] || (B.cur.canvas[k] = { n: 0, ms: 0 });
    s.n += 1; s.ms += dt;
  };
  const wrap = (proto, name) => {
    const orig = proto[name];
    if (!orig) return;
    proto[name] = function (...a) {
      const t = performance.now();
      const r = orig.apply(this, a);
      add(name, performance.now() - t);
      return r;
    };
  };
  const C2D = CanvasRenderingContext2D.prototype;
  ['getImageData', 'putImageData', 'drawImage', 'fillRect', 'createImageData'].forEach((nm) => wrap(C2D, nm));
  const gid = C2D.getImageData;
  C2D.getImageData = function (...a) {
    B.cur.gidPixels += a[2] * a[3];
    B.cur.gidMax = Math.max(B.cur.gidMax, a[2] * a[3]);
    return gid.apply(this, a);
  };
  const t2b = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) {
    const t = performance.now();
    const px = this.width * this.height;
    return t2b.call(this, (b) => {
      const dt = performance.now() - t;
      add(px > 1e6 ? 'toBlob@full' : 'toBlob@out', dt);
      add('toBlob.total', dt);
      cb(b);
    }, ...rest);
  };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        B.cur.longtask.count += 1; B.cur.longtask.total += e.duration;
        B.cur.longtask.max = Math.max(B.cur.longtask.max, e.duration);
      }
    }).observe({ type: 'longtask', buffered: false });
  } catch (e) {}

  const mem = () => (performance.memory ? {
    usedMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
    totalMB: +(performance.memory.totalJSHeapSize / 1048576).toFixed(1),
  } : null);
  const freeze = (obj) => JSON.parse(JSON.stringify(obj));
  const close = (name, t0, t1) => {
    B.cur.mem = mem();
    B.result[name] = { ms: Math.round(t1 - t0), canvas: freeze(B.cur.canvas), gidPixels: B.cur.gidPixels, gidMax: B.cur.gidMax, longtask: freeze(B.cur.longtask), mem: B.cur.mem, at: Math.round(t1) };
    B.cur = canvasStat();
  };
  // 左栏每行缩略图在出片后带 data-done：合成完成的张数以它为准（中栏现在只画当前那一张）
  const imgs = () => document.querySelectorAll('.idp-left .idp-card-img img[data-done="1"]');

  // 阶段计时（rAF 采样；主线程被长任务占住时采样点顺延到下一帧，与用户感知一致）
  let t0 = 0, tMatte = 0, tCompose = 0;
  let redArm = 0, redFrom = null, whiteArm = 0, whiteFrom = null;
  const tick = () => {
    const now = performance.now();
    if (B.phase === 'matte') {
      if (document.querySelectorAll('.idp-badge.done, .idp-badge.err').length >= B.n) {
        tMatte = now;
        B.phase = 'compose1';
      }
    }
    if (B.phase === 'compose1') {
      if (imgs().length >= B.n) {
        tCompose = now;
        B.phase = 'idle';
        close('matte', t0, tMatte);
        close('compose1', tMatte, tCompose);
        B.result.total_to_first_result_ms = Math.round(tCompose - t0);
      }
    }
    if (B.phase === 'red') {
      const els = imgs();
      if (els.length >= B.n && els[0].getAttribute('src') !== redFrom) {
        close('switch_red', redArm, now);
        B.phase = 'idle';
      }
    }
    if (B.phase === 'white') {
      const els = imgs();
      if (els.length >= B.n && els[0].getAttribute('src') !== whiteFrom) {
        close('switch_white', whiteArm, now);
        B.phase = 'idle';
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const input = document.querySelector('.idp input[type=file][accept="image/*"]');
  input.addEventListener('change', () => {
    if (B.phase !== 'idle') return;
    B.cur = canvasStat();
    t0 = performance.now();
    B.phase = 'matte';
  }, true);

  B.armRed = () => { redFrom = imgs()[0] ? imgs()[0].getAttribute('src') : null; redArm = performance.now(); B.cur = canvasStat(); B.phase = 'red'; };
  B.armWhite = () => { whiteFrom = imgs()[0] ? imgs()[0].getAttribute('src') : null; whiteArm = performance.now(); B.cur = canvasStat(); B.phase = 'white'; };
  B.snap = () => ({ result: B.result, phase: B.phase, mem: mem() });
  B.count = () => ({ cards: document.querySelectorAll('.idp-card').length, imgs: imgs().length, done: document.querySelectorAll('.idp-badge.done, .idp-badge.err').length });
  return 'ok';
}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="baseline")
    ap.add_argument("--n", type=int, default=50)
    ap.add_argument("--port", type=int, default=9361)
    ap.add_argument("--engine", choices=["isnet", "modnet"], default="isnet", help="在导入前切换抠图引擎")
    ap.add_argument("--wait", type=int, default=2400, help="单阶段最长等待秒数")
    args = ap.parse_args()

    files = sorted(os.path.join(PHOTOS, f) for f in os.listdir(PHOTOS) if f.lower().endswith(".jpg"))[: args.n]
    if not files:
        print("缺少测试照片，先跑 tools/make_bench_photos.py")
        return 2
    report = {
        "label": args.label,
        "startedAt": datetime.now().isoformat(timespec="seconds"),
        "photos": len(files),
        "photoMB": round(os.path.getsize(files[0]) / 1048576, 2),
        "os": {"platform": platform.platform(), "cpu": os.cpu_count()},
        "result": {},
        "anomalies": [],
    }

    env = dict(os.environ)
    env.pop("ELECTRON_RUN_AS_NODE", None)
    log = open(os.path.join(OUT, "electron-%s.log" % args.label), "wb")
    proc = subprocess.Popen(
        [ELECTRON, ".", "--remote-debugging-port=%d" % args.port],
        cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT,
    )
    print("Electron pid=%d" % proc.pid)
    t_start = time.time()

    try:
        from playwright.sync_api import sync_playwright

        deadline = time.time() + 40
        pages = None
        while time.time() < deadline and not pages:
            try:
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                pages = json.loads(opener.open("http://127.0.0.1:%d/json/list" % args.port, timeout=2).read())
            except Exception:
                time.sleep(0.4)
        if not pages:
            print("CDP 未就绪")
            return 3

        with sync_playwright() as pw:
            browser = pw.chromium.connect_over_cdp("http://127.0.0.1:%d" % args.port)
            pg = [p for p in browser.contexts[0].pages if "index.html" in (p.url or "")][0]
            pg.set_default_timeout(30000)
            errs, perrs = [], []
            pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
            pg.on("pageerror", lambda e: perrs.append(str(e)))

            pg.wait_for_selector(".toolcard", timeout=30000)
            info = pg.evaluate("() => ({ href: location.href, coi: self.crossOriginIsolated, cores: navigator.hardwareConcurrency, dpr: devicePixelRatio })")
            report["runtime"] = info
            print("runtime:", info)

            pg.locator(".toolcard", has_text="证件照批量处理").first.click()
            pg.wait_for_selector(".idp", timeout=20000)
            if args.engine == "modnet":
                pg.locator(".seg-btn", has_text="快速").first.click()
                print("engine -> modnet(快速)：", pg.evaluate("() => document.querySelector('.seg-btn.active') ? document.querySelector('.seg-btn.active').textContent : ''"))
            print("setup:", pg.evaluate(SETUP, args.n))

            t_up = time.time()
            pg.query_selector('input[type=file][accept="image/*"]').set_input_files(files, timeout=300000)
            report["upload_s"] = round(time.time() - t_up, 1)
            print("upload %.1fs, cards=%s" % (report["upload_s"], pg.evaluate("() => window.__bench.count()")))

            deadline = time.time() + args.wait
            while time.time() < deadline:
                s = pg.evaluate("() => window.__bench.snap()")
                if "compose1" in s["result"]:
                    break
                time.sleep(2)
            print("phase1:", json.dumps(pg.evaluate("() => ({r: window.__bench.result, p: window.__bench.phase})"), ensure_ascii=False)[:200])

            pg.screenshot(path=os.path.join(OUT, "%s-white.png" % args.label))

            # 切红底
            pg.evaluate("() => window.__bench.armRed()")
            pg.evaluate("() => document.querySelector('.idp-swatch[title=\"红底\"]').click()")
            deadline = time.time() + args.wait
            while time.time() < deadline:
                s = pg.evaluate("() => window.__bench.result.switch_red")
                if s:
                    break
                time.sleep(1)
            pg.screenshot(path=os.path.join(OUT, "%s-red.png" % args.label))

            # 切回白底（重复计算检验）
            pg.evaluate("() => window.__bench.armWhite()")
            pg.evaluate("() => document.querySelector('.idp-swatch[title=\"白底\"]').click()")
            deadline = time.time() + args.wait
            while time.time() < deadline:
                if pg.evaluate("() => !!window.__bench.result.switch_white"):
                    break
                time.sleep(1)

            report["result"] = pg.evaluate("() => window.__bench.result")
            report["finalMem"] = pg.evaluate("() => window.__mem ? window.__mem() : null")
            report["consoleErrors"] = errs[:10]
            report["pageErrors"] = perrs[:10]
            if perrs:
                report["anomalies"].append("渲染进程异常: " + "; ".join(perrs[:2]))
            browser.close()
    finally:
        try:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, timeout=25)
        except Exception:
            proc.kill()
        log.close()

    report["total_s"] = round(time.time() - t_start, 1)
    path = os.path.join(OUT, "%s.json" % args.label)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print("\n===== %s（%d 张 %.2fMB/张）=====" % (args.label, len(files), report["photoMB"]))
    print("  上传（Playwright 协议开销，不计入耗时）: %.1fs" % report.get("upload_s", 0))
    for k, v in report["result"].items():
        if isinstance(v, dict):
            print("  %-16s %8.2f s   longtask=%d/%.0fms heap=%sMB gid=%.1fM(单次最大%.2fM)" % (
                k, v["ms"] / 1000, v["longtask"]["count"], v["longtask"]["total"],
                (v.get("mem") or {}).get("usedMB"), v["gidPixels"] / 1e6, (v["gidMax"] or 0) / 1e6))
            for name, st in sorted(v["canvas"].items()):
                print("      %-22s n=%-5d %9.0f ms" % (name, st["n"], st["ms"]))
        else:
            print("  %-16s %s" % (k, v))
    print("report -> %s (wall %.1fs)" % (path, report["total_s"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
