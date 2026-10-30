# -*- coding: utf-8 -*-
"""真机预览脚本：启动**真实 Electron 桌面窗口**（非浏览器预览），
驱动「证件照 → 专业匀肤」全链路，采集环境信息、控制台异常、像素指标与截图。

用法（在仓库根目录）：
    python tools/preview_retouch.py

产物：
    .tmp/preview/*.png          各阶段截图
    .tmp/preview/report.json    环境 + 检查项 + 指标 + 异常

要点：
- Electron 由本脚本亲自拉起，跑完自动 taskkill /T（不留后台进程）；
- 连接走 CDP（--remote-debugging-port），因此不做任何应用内埋点，测的是打包后的真实 dist + app:// + res/ 资源；
- 环境变量 ELECTRON_RUN_AS_NODE 必须清掉，否则 electron.exe 会退化成 node 跑 main.cjs 并崩在 protocol 上。
"""
import io
import re
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, ".tmp", "preview")
PORT = 9333
ELECTRON = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")
PHOTO = os.path.abspath(os.path.join(ROOT, "..", "compare", "imgs", "0002-01.jpg"))

os.makedirs(OUT, exist_ok=True)
report = {"startedAt": datetime.now().isoformat(timespec="seconds"), "checks": [], "metrics": {}, "anomalies": []}
shots = []


def note(name, ok, detail=""):
    report["checks"].append({"name": name, "ok": bool(ok), "detail": str(detail)})
    print(("  [PASS] " if ok else "  [FAIL] ") + name + (("  " + str(detail)) if detail else ""))


def anomaly(text):
    report["anomalies"].append(text)
    print("  [ANOMALY] " + text)


def shot(pg, name):
    path = os.path.join(OUT, name)
    pg.screenshot(path=path)
    shots.append(path)
    return path


def result_src(pg):
    return pg.evaluate("() => { const i = document.querySelector('.idp-photo-card img'); return i ? i.src : ''; }")


def wait_recompose(pg, prev_src, timeout=90):
    """等结果 <img> 的 src 真的换成新一轮合成的 object URL（避免量测到旧图）。"""
    pg.wait_for_function(
        "([s]) => { const i = document.querySelector('.idp-photo-card img'); return !!i && i.src !== s; }",
        arg=[prev_src],
        timeout=timeout * 1000,
    )


def wait_settled(pg, quiet=1.2, timeout=90):
    """等主预览的 src 连续 quiet 秒不再变化。

    为什么需要：导入后会先出第一版成品，随后「批量默认启用自动构图」再按人脸重排一次
    （src 再变一次），两版像素不同。基线若量到第一版、后续量到第二版，就会把所有
    像素级断言（匀肤是否更平滑、归零是否逐位一致）全部带偏。
    """
    end = time.time() + timeout
    last, since = None, time.time()
    while time.time() < end:
        cur = result_src(pg)
        if cur != last:
            last, since = cur, time.time()
        elif cur and time.time() - since >= quiet:
            return cur
        time.sleep(0.2)
    return last


def http_json(path, timeout=2.0):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 绕过系统代理
    with opener.open("http://127.0.0.1:%d%s" % (PORT, path), timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def port_free(port):
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def wait_cdp(deadline=25.0):
    end = time.time() + deadline
    while time.time() < end:
        try:
            pages = http_json("/json/list")
            if pages:
                return pages
        except Exception:
            pass
        time.sleep(0.4)
    return None


# ---------------------------------------------------------------- 环境
env = dict(os.environ)
env.pop("ELECTRON_RUN_AS_NODE", None)
env["ELECTRON_ENABLE_LOGGING"] = "1"

if not os.path.exists(ELECTRON):
    print("找不到 electron 可执行文件：%s" % ELECTRON)
    sys.exit(2)
if not port_free(PORT):
    print("端口 %d 已被占用，先关掉旧的 Electron 再跑" % PORT)
    sys.exit(2)
if not os.path.exists(PHOTO):
    print("找不到测试人像：%s" % PHOTO)
    sys.exit(2)

import io
logf = open(os.path.join(OUT, "electron.log"), "wb")
proc = subprocess.Popen(
    [ELECTRON, ".", "--remote-debugging-port=%d" % PORT],
    cwd=ROOT,
    env=env,
    stdout=logf,
    stderr=subprocess.STDOUT,
)
print("Electron 已启动 pid=%d，等待 CDP…" % proc.pid)

pages = wait_cdp()
if not pages:
    proc.kill()
    print("CDP 未就绪，见 .tmp/preview/electron.log")
    sys.exit(3)

from playwright.sync_api import sync_playwright  # noqa: E402

console_logs = []
page_errors = []

try:
    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp("http://127.0.0.1:%d" % PORT)
        ctx = browser.contexts[0]
        pg = None
        for p in ctx.pages:
            if "index.html" in (p.url or ""):
                pg = p
                break
        pg = pg or ctx.pages[0]
        pg.set_default_timeout(20000)

        pg.on("console", lambda m: console_logs.append({"type": m.type, "text": m.text}))
        pg.on("pageerror", lambda e: page_errors.append(str(e)))

        pg.wait_for_selector(".toolcard", timeout=25000)
        info = pg.evaluate(
            """() => {
              const c = document.createElement('canvas');
              const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
              let gpu = '';
              if (gl) {
                const dbg = gl.getExtension('WEBGL_debug_renderer_info');
                gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
              }
              return {
                url: location.href,
                ua: navigator.userAgent,
                screen: [screen.width, screen.height],
                dpr: devicePixelRatio,
                inner: [innerWidth, innerHeight],
                crossOriginIsolated: self.crossOriginIsolated,
                gpu,
                cores: navigator.hardwareConcurrency,
                hasAppRes: !!(window.electronAPI && window.electronAPI.appResBase),
                appResBase: window.electronAPI ? window.electronAPI.appResBase : null,
              };
            }"""
        )
        report["runtime"] = info
        report["os"] = {
            "platform": platform.platform(),
            "version": platform.version(),
            "machine": platform.machine(),
            "cpuCount": os.cpu_count(),
            "python": platform.python_version(),
        }
        report["process"] = {"pid": proc.pid, "electron": ELECTRON, "argv": [ELECTRON, ".", "--remote-debugging-port=%d" % PORT]}
        print("  运行时：%s" % json.dumps(info, ensure_ascii=False))
        shot(pg, "01-home.png")

        # 1) 进入证件照
        pg.locator(".toolcard", has_text="证件照批量处理").first.click()
        pg.wait_for_selector(".idp", timeout=15000)
        note("证件照工具在真机窗口内打开", pg.locator(".idp").count() == 1, info["url"])

        adv_row = pg.locator(".idp-row", has_text="专业匀肤")
        note("「专业匀肤」开关已渲染", adv_row.count() == 1)

        # 2) 导入真人像（隐藏 input[type=file]，直接 set_input_files 等价于用户选文件）
        pg.set_input_files('input[type=file][accept="image/*"]', PHOTO)
        note("导入真实人像", os.path.basename(PHOTO), PHOTO)
        pg.wait_for_selector(".progress-text", timeout=15000)
        note("抠图流水线启动（进度文本出现）", True, pg.locator(".progress-text").first.inner_text(timeout=1500) or "")

        # 3) 等待抠图 + 合成完成
        pg.wait_for_function(
            "() => document.querySelectorAll('.idp-photo-card img').length > 0 "
            "|| document.querySelectorAll('[title*=\"失败\"]').length > 0",
            timeout=180000,
        )
        failed = pg.locator('[title*="失败"]').count()
        cards = pg.locator(".idp-photo-card img").count()
        note("抠图+合成在真机渲染进程内完成", cards > 0 and failed == 0, "结果卡=%d 失败=%d" % (cards, failed))
        if failed:
            anomaly("抠图失败标记出现，后续匀肤验证无法进行")
        shot(pg, "02-idphoto-imported.png")

        # 像素指标：中心人脸区域的 3x3 残差标准差（hfσ，越低越平滑）+ 平均亮度
        def measure(store_key=None, compare_key=None):
            return pg.evaluate(
                """([storeKey, compareKey]) => {
                  const img = document.querySelector('.idp-photo-card img');
                  if (!img) return null;
                  const w = img.naturalWidth, h = img.naturalHeight;
                  const c = document.createElement('canvas');
                  c.width = w; c.height = h;
                  const x = c.getContext('2d');
                  x.drawImage(img, 0, 0, w, h);
                  const d = x.getImageData(0, 0, w, h).data;
                  const x0 = Math.floor(w * 0.3), x1 = Math.ceil(w * 0.7);
                  const y0 = Math.floor(h * 0.15), y1 = Math.ceil(h * 0.6);
                  let sum = 0, sum2 = 0, n = 0;
                  for (let j = y0 + 1; j < y1 - 1; j++) {
                    for (let i = x0 + 1; i < x1 - 1; i++) {
                      const p = (j * w + i) * 4;
                      const lum = q => 0.299 * d[q] + 0.587 * d[q + 1] + 0.114 * d[q + 2];
                      const v = lum(p);
                      const lap = 4 * v - lum(p - 4) - lum(p + 4) - lum(p - w * 4) - lum(p + w * 4);
                      sum += lap; sum2 += lap * lap; n++;
                    }
                  }
                  const mean = sum / n;
                  const hf = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
                  const out = { w, h, hf: +hf.toFixed(4), n };
                  if (storeKey) window[storeKey] = new Uint8ClampedArray(d);
                  if (compareKey && window[compareKey]) {
                    const base = window[compareKey];
                    let acc = 0, mx = 0, cnt = 0;
                    for (let i = 0; i < d.length; i += 4) {
                      for (let k = 0; k < 3; k++) {
                        const dv = Math.abs(d[i + k] - base[i + k]);
                        acc += dv; if (dv > mx) mx = dv; cnt++;
                      }
                    }
                    out.diffMean = +(acc / cnt).toFixed(3);
                    out.diffMax = mx;
                  }
                  return out;
                }""",
                [store_key, compare_key],
            )

        # 基线必须在「完全不做平滑」的状态下取：专业匀肤一开就会接管磨皮、把经典美颜强制为 0
        # （见 retouch.beauty 的装配），所以「关掉经典美颜」才是与后续状态可比的原点。
        cur = result_src(pg)
        pg.locator(".idp-row", has_text="美颜").locator("button", has_text="关").first.click()
        wait_recompose(pg, cur)
        wait_settled(pg, quiet=0.8)
        base = measure(store_key="__baseShot")
        report["metrics"]["baseline"] = base
        note("基线结果可量测", bool(base), json.dumps(base, ensure_ascii=False) if base else "")
        src_base = result_src(pg)

        # 4) 打开专业匀肤（默认 60/35/25）：等新结果真正生成再量测
        adv_row.locator('input[type="checkbox"]').check()
        pg.wait_for_timeout(300)
        note("三档滑块出现", pg.locator(".idp-slider", has_text="去油光").count() == 1 and pg.locator(".idp-slider", has_text="去黑眼圈").count() == 1)

        wait_recompose(pg, src_base)
        wait_settled(pg, quiet=0.8)
        try:
            pg.wait_for_function(
                """() => Array.from(document.querySelectorAll('.idp .muted'))
                        .some(e => /平滑 \\d+ px/.test(e.textContent || ''))""",
                timeout=10000,
            )
            msg = pg.evaluate(
                """() => { const e = Array.from(document.querySelectorAll('.idp .muted'))
                           .find(e => /平滑 \\d+ px/.test(e.textContent || '')); return e ? e.textContent : ''; }"""
            )
            note("专业匀肤完成并回报统计", True, msg)
            report["metrics"]["advMessage"] = msg
            note("人脸检测命中（脸宽为实测而非估算）", "(估算)" not in msg, msg)
            note("黑眼圈档生效（眼下 px>0）", not re.search(r"眼下 0 px", msg), msg)
        except Exception as e:
            note("专业匀肤统计文案未出现", False, str(e)[:200])
            anomaly("未见「平滑 N px」统计，匀肤可能未执行")

        shot(pg, "03-adv-default.png")
        adv = measure(store_key="__advShot", compare_key="__baseShot")
        report["metrics"]["adv60"] = adv
        if base and adv:
            note(
                "匀肤后高频残差下降",
                adv["hf"] < base["hf"],
                "hfσ %.3f → %.3f（%.1f%%），与原图平均差 %.2f 级、最大 %d 级"
                % (base["hf"], adv["hf"], (1 - adv["hf"] / max(base["hf"], 1e-6)) * 100, adv["diffMean"], adv["diffMax"]),
            )

        # 5) 拉到 100 再验一次（参数真的生效 → 更平滑）
        src_prev = result_src(pg)
        pg.locator(".idp-slider", has_text="匀肤").locator('input[type="range"]').fill("100")
        wait_recompose(pg, src_prev)
        wait_settled(pg, quiet=0.8)
        shot(pg, "04-adv-full.png")
        full = measure(store_key="__fullShot", compare_key="__baseShot")
        report["metrics"]["adv100"] = full
        if adv and full:
            note("斜杆拉到 100 效果更强（参数链路生效）", full["hf"] < adv["hf"], "hfσ %.3f → %.3f" % (adv["hf"], full["hf"]))

        # 6) 三档归零 → 明确提示“未做匀肤”，且结果应与基线逐位一致
        src_prev = result_src(pg)
        for label in ("匀肤", "去油光", "去黑眼圈"):
            pg.locator(".idp-slider", has_text=label).locator('input[type="range"]').fill("0")
        try:
            pg.wait_for_function(
                """() => Array.from(document.querySelectorAll('.idp .muted'))
                        .some(e => /三档均为 0/.test(e.textContent || ''))""",
                timeout=30000,
            )
            note("三档全 0 时明确提示未处理", True)
        except Exception:
            note("三档全 0 提示缺失", False)
            anomaly("三档归零后没有「三档均为 0」提示")
        wait_recompose(pg, src_prev)
        wait_settled(pg, quiet=0.8)
        zero = measure(compare_key="__baseShot")
        report["metrics"]["zero"] = zero
        if zero and base:
            same = zero.get("diffMean", 999) == 0.0 and zero.get("diffMax", 999) == 0
            note("三档归零后结果与基线逐位一致（无残留副作用）", same,
                 "hfσ %.3f vs %.3f，平均差 %.2f、最大差 %d" % (zero["hf"], base["hf"], zero.get("diffMean", -1), zero.get("diffMax", -1)))
            if not same:
                anomaly("三档归零后结果与基线不一致：平均差 %.2f（应为 0）" % zero.get("diffMean", -1))

        # 7) 经典美颜联动：专业档开启时经典档按钮应禁用
        disabled = pg.locator(".idp-row", has_text="美颜").locator("button", has_text="自然").is_disabled()
        note("专业档开启时经典美颜按钮禁用（互斥）", disabled)

        src_prev = result_src(pg)
        pg.locator(".idp-slider", has_text="匀肤").locator('input[type="range"]').fill("80")
        pg.locator(".idp-slider", has_text="去油光").locator('input[type="range"]').fill("45")
        wait_recompose(pg, src_prev)
        shot(pg, "05-final.png")

        # 8) 控制台异常
        errs = [c for c in console_logs if c["type"] == "error"]
        report["console"] = {"total": len(console_logs), "errors": errs[:20]}
        report["pageErrors"] = page_errors
        note("渲染进程无 JS 异常", len(page_errors) == 0, "; ".join(page_errors[:3]))
        if errs:
            anomaly("控制台 error 共 %d 条：%s" % (len(errs), "; ".join(e["text"][:120] for e in errs[:4])))
        else:
            note("控制台无 error 级日志", True)

        browser.close()
finally:
    try:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, timeout=20)
    except Exception:
        proc.kill()
    logf.close()

report["finishedAt"] = datetime.now().isoformat(timespec="seconds")
report["screenshots"] = shots
with io.open(os.path.join(OUT, "report.json"), "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)

print("\n截图：%s" % ", ".join(os.path.basename(s) for s in shots))
ok = sum(1 for c in report["checks"] if c["ok"])
print("检查项：%d/%d 通过；异常 %d 条" % (ok, len(report["checks"]), len(report["anomalies"])))
