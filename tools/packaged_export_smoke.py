# -*- coding: utf-8 -*-
"""打包版导出链路冒烟：验证「IPC 批量写盘」在安装形态下真的能跑。

为什么需要它：`verify:export` 跑的是 http 静态服务 + Chromium，没有 `electronAPI`，
走的是浏览器 `<a download>` 回退 —— **IPC 这条路它一点都不覆盖**。
2026-10-29 用户报的「50 张导出失败：An object could not be cloned.」正是这条路上的 bug
（`onProgress` 函数被展开进 `ipcRenderer.invoke` 参数），而当时所有门禁全绿。

本脚本用 CDP 直接驱动打包版窗口，分三步钉住这条链路：
  1) 纯字节（Uint8Array）过桥 + 主进程原子写盘 → 文件真的出现在磁盘上；
  2) 带 `onProgress`（函数）过桥 → 必须抛 DataCloneError（证明这条边界真实存在，
     也是「为什么必须白名单挑参数」的活证据）；
  3) 控制台无 error。

用法：python tools/packaged_export_smoke.py   （需先 npm run pack）
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tmproot import mkdtemp  # noqa: E402

OUT = os.path.join(ROOT, ".tmp", "packaged-export")
PORT = 9368
APP = os.path.join(ROOT, "dist-pkg-current", "win-unpacked", "超誉工作台.exe")

os.makedirs(OUT, exist_ok=True)
report = {"startedAt": datetime.now().isoformat(timespec="seconds"), "checks": []}


def note(name, ok, detail=""):
    detail = str(detail)
    report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
    print(("  [PASS] " if ok else "  [FAIL] ") + name + (("  " + detail) if detail else ""))


# 独立 userData（空 profile 就有上百 MB）与导出落盘目录都放仓库 .tmp，不占 C 盘
userdata = str(mkdtemp("chaoyu-export-"))
target_dir = str(mkdtemp("chaoyu-export-out-"))
env = dict(os.environ)
env.pop("ELECTRON_RUN_AS_NODE", None)
proc = subprocess.Popen(
    [APP, "--remote-debugging-port=%d" % PORT, "--user-data-dir=%s" % userdata],
    cwd=os.path.dirname(APP), env=env,
    stdout=open(os.path.join(OUT, "packaged.log"), "wb"), stderr=subprocess.STDOUT,
)
print("打包版已启动 pid=%d" % proc.pid)
print("目标目录：%s" % target_dir)

errors = []

try:
    from playwright.sync_api import sync_playwright

    deadline = time.time() + 40
    pages = None
    while time.time() < deadline and not pages:
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            pages = json.loads(opener.open("http://127.0.0.1:%d/json/list" % PORT, timeout=2).read())
        except Exception:
            time.sleep(0.4)
    if not pages:
        raise SystemExit("CDP 未就绪（打包版启动失败？见 %s）" % os.path.join(OUT, "packaged.log"))

    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp("http://127.0.0.1:%d" % PORT)
        pg = [p for p in browser.contexts[0].pages if "index.html" in (p.url or "")][0]
        pg.set_default_timeout(30000)
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append("pageerror: %s" % e))

        pg.wait_for_selector(".toolcard", timeout=30000)
        note("打包版首页渲染（app:// 协议）", True, pg.url)

        # ---- 1) 纯字节过桥 + 原子写盘 ----
        res = pg.evaluate(
            """async (dir) => {
                 const mk = (n) => {
                   const a = new Uint8Array(2048);
                   a[0] = 0xff; a[1] = 0xd8; a[2] = 0xff; a[3] = 0xe0;  // JPEG SOI+APP0 头
                   for (let i = 4; i < a.length; i++) a[i] = (i + n) & 0xff;
                   return a;
                 };
                 const files = [
                   { name: '探针_甲.jpg', data: mk(1) },
                   { name: '探针_乙.jpg', data: mk(2) },
                 ];
                 return await window.electronAPI.saveFiles({ files, dir });
               }""",
            target_dir,
        )
        report["saveFilesRaw"] = res
        note("批量 saveFiles 返回 ok", bool(res and res.get("ok")), json.dumps(res, ensure_ascii=False)[:200])
        saved = (res or {}).get("saved") or []
        note("两份都在 saved 里（同名不会互相覆盖）", len(saved) == 2, "saved=%d" % len(saved))

        on_disk = sorted(os.listdir(target_dir))
        note("文件真的落到磁盘", on_disk == ["探针_乙.jpg", "探针_甲.jpg"] or len(on_disk) == 2, str(on_disk))
        sizes = [os.path.getsize(os.path.join(target_dir, f)) for f in on_disk]
        note("字节数完整（2048 / 份）", sizes == [2048, 2048], str(sizes))

        # ---- 2) 函数过桥必须失败（这条边界真实存在）----
        clone_err = pg.evaluate(
            """async (dir) => {
                 try {
                   await window.electronAPI.saveFiles({
                     files: [{ name: 'x.jpg', data: new Uint8Array([1,2,3]) }],
                     dir,
                     onProgress: () => {},          // ← 正是旧代码 `{...opts}` 展开带进来的东西
                   });
                   return { threw: false, msg: '' };
                 } catch (e) {
                   return { threw: true, msg: String(e && e.message || e) };
                 }
               }""",
            target_dir,
        )
        report["cloneProbe"] = clone_err
        note(
            "带函数的参数过桥会抛错（复现原始故障形态）",
            bool(clone_err and clone_err.get("threw")),
            (clone_err or {}).get("msg", "")[:120],
        )
        note(
            "错误信息就是用户看到的那个",
            "clone" in (clone_err or {}).get("msg", "").lower(),
            (clone_err or {}).get("msg", "")[:80],
        )

        # ---- 3) 清理与收尾 ----
        note("控制台无 error", len(errors) == 0, "; ".join(errors[:2]))
        browser.close()
except Exception as exc:
    note("脚本异常", False, repr(exc))
finally:
    try:
        proc.kill()
        proc.wait(timeout=10)
    except Exception:
        pass
    shutil.rmtree(userdata, ignore_errors=True)

    passed = sum(1 for c in report["checks"] if c["ok"])
    total = len(report["checks"])
    print("\n检查项：%d/%d 通过" % (passed, total))
    report["targetDir"] = target_dir
    with open(os.path.join(OUT, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print("PACKAGED_EXPORT_OK" if passed == total else "PACKAGED_EXPORT_FAIL")
    raise SystemExit(0 if passed == total else 1)
