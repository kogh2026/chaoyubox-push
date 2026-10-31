#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Acrobat Preflight 转曲批处理（Windows / 桌面会话）

用法：
  python tools/acrobat_outline.py --check                  # 列出本机 Preflight 配置名（含「将字体转换为空心」候选）
  python tools/acrobat_outline.py --run <文件或目录...> [--out DIR] [--batch 12]

⚠️ 本脚本按 acrobat-unattended-preflight 技能的 9 条实测机制编写，但**未在本仓库执行环境中实测**
   —— Acrobat 必须以独立实例启动并会显示窗口，须在你自己的桌面会话里运行。
   首次使用建议只跑 1 个文件，确认产出字体归零后再批量。

依赖：
  pip install pikepdf pymupdf
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tmproot import mkdtemp  # noqa: E402

ACROBAT_CANDIDATES = [
    r"C:\Program Files (x86)\Adobe\Acrobat 2017\Acrobat\Acrobat.exe",
    r"C:\Program Files\Adobe\Acrobat DC\Acrobat\Acrobat.exe",
    r"C:\Program Files (x86)\Adobe\Acrobat DC\Acrobat\Acrobat.exe",
]
PROFILE_CANDIDATES = [
    "将字体转换为空心",
    "Convert fonts to outlines",
    "Convert All Fonts to Outlines",
]

# 文件夹级脚本：必须在加载时注册 trustedFunction（技能机制 2/5：加载时不能开文档、受限 API 必须字面写进函数体）
DRIVER_JS = r"""
var CHAOYU_CFG = @@CFG@@;
var CHAOYU_DRIVE = null;
try {
    CHAOYU_DRIVE = app.trustedFunction(function (oDoc, i, cDst) {
        app.beginPriv();
        var res = "NOPROFILE";
        var prof = null;
        try { prof = Preflight.getProfileByName(CHAOYU_CFG.profile); } catch (e1) { prof = null; }
        if (prof) {
            try {
                var r = oDoc.preflight(prof, false);
                res = "OK|ne=" + ((r && r.numErrors !== undefined) ? r.numErrors : -1);
            } catch (e2) { res = "ERR|" + e2.message; }
        }
        try { oDoc.info.Title = "OTRES|" + i + "|" + res; } catch (e3) {}
        if (res.indexOf("OK") === 0) {
            try { oDoc.saveAs({ cPath: cDst, bPromptToOverwrite: false }); }
            catch (e4) { res = "ERR|save:" + e4.message; }
        }
        try { oDoc.closeDoc(false); } catch (e5) {}
        app.endPriv();
        return res;
    });
} catch (e0) { CHAOYU_DRIVE = null; }
"""

OPEN_ACTION_JS = (
    'try { if (typeof CHAOYU_DRIVE === "function") { '
    'CHAOYU_DRIVE(this, @@IDX@@, "@@DST@@"); } } catch (e) { }'
)


def find_acrobat() -> str:
    for p in ACROBAT_CANDIDATES:
        if os.path.isfile(p):
            return p
    raise SystemExit("未找到 Acrobat.exe，请在 ACROBAT_CANDIDATES 里补一条路径")


def privileged_js_dir() -> Path:
    """只有 Privileged\\<版本>\\JavaScripts 会被加载；普通 Javascripts 不加载（机制 1）"""
    appdata = Path(os.environ["APPDATA"])
    base = appdata / "Adobe" / "Acrobat" / "Privileged"
    if not base.is_dir():
        raise SystemExit(f"没找到 {base}，确认 Acrobat 至少启动过一次")
    # 版本目录：2017 / 17.0 / DC …… 排除 JavaScripts 自身
    vers = [
        d
        for d in base.iterdir()
        if d.is_dir() and d.name.lower() != "javascripts"
    ]
    if not vers:
        raise SystemExit(f"{base} 下没有版本目录")
    for d in sorted(vers, key=lambda d: d.name, reverse=True):
        cand = d / "JavaScripts"
        if cand.is_dir():
            return cand
    target = sorted(vers, key=lambda d: d.name)[-1] / "JavaScripts"
    target.mkdir(parents=True, exist_ok=True)
    return target


def write_driver(js_dir: Path, profile: str) -> Path:
    body = DRIVER_JS.replace("@@CFG@@", json.dumps({"profile": profile}, ensure_ascii=True))
    path = js_dir / "chaoyu_drive.js"
    path.write_text(body, encoding="ascii")  # 中文必须转义，否则 Acrobat 解析失败
    return path


def inject(src: Path, dst: Path, idx: int) -> None:
    """把 /OpenAction 写进工作副本（源文件全程只读）"""
    import pikepdf

    js = OPEN_ACTION_JS.replace("@@IDX@@", str(idx)).replace("@@DST@@", dst.as_posix())
    assert js.isascii(), "注入的 JS 必须是纯 ASCII"
    with pikepdf.open(src) as pdf:
        action = pdf.make_indirect(
            pikepdf.Dictionary({"/S": pikepdf.Name("/JavaScript"), "/JS": pikepdf.String(js)})
        )
        pdf.Root["/OpenAction"] = action
        pdf.save(dst)


def strip_action(path: Path) -> None:
    import pikepdf

    with pikepdf.open(path) as pdf:
        if "/OpenAction" in pdf.Root:
            del pdf.Root["/OpenAction"]
            pdf.save(path.with_suffix(".tmp.pdf"))
    tmp = path.with_suffix(".tmp.pdf")
    if tmp.exists():
        tmp.replace(path)


def font_count(path: Path) -> int:
    import fitz  # pymupdf

    with fitz.open(path) as doc:
        return sum(len(page.get_fonts()) for page in doc)


def wait_outputs(expected: list[Path], timeout_s: int) -> tuple[list[Path], list[Path]]:
    """等写盘稳定：文件大小连续两次不变（技能：产出锁是瞬态，约秒级）"""
    deadline = time.time() + timeout_s
    sizes: dict[Path, int] = {}
    done: list[Path] = []
    while time.time() < deadline:
        done = []
        for p in expected:
            if not p.exists():
                continue
            try:
                s = p.stat().st_size
            except OSError:
                continue
            if s > 0 and sizes.get(p) == s:
                done.append(p)
            sizes[p] = s
        if len(done) == len(expected):
            return done, []
        time.sleep(0.8)
    return done, [p for p in expected if p not in done]


def cmd_check() -> int:
    """只做安全探测：确认 Acrobat 存在、Privileged 目录可写、给出候选 profile 名"""
    acrobat = find_acrobat()
    js_dir = privileged_js_dir()
    print(f"Acrobat : {acrobat}")
    print(f"脚本目录: {js_dir}")
    print("候选 profile：", "、".join(PROFILE_CANDIDATES))
    print(
        "\n注：profile 名是本地化文本，必须用 Preflight.getNumProfiles() 枚举确认；\n"
        "     中文版通常是「将字体转换为空心」，英文版是 Convert fonts to outlines。"
    )
    print("\n下一步（在你自己的桌面会话里执行，会启动 Acrobat 窗口）：")
    print("  python tools/acrobat_outline.py --run 你的文件.pdf --out out")
    return 0


def cmd_run(targets: list[str], out_dir: Path, batch: int, timeout_s: int, profile: str) -> int:
    files: list[Path] = []
    for t in targets:
        p = Path(t).resolve()
        if p.is_dir():
            files.extend(sorted(x for x in p.iterdir() if x.suffix.lower() == ".pdf"))
        elif p.is_file() and p.suffix.lower() == ".pdf":
            files.append(p)
    if not files:
        raise SystemExit("没有找到 PDF")

    batch = max(1, min(batch, 40))  # 硬上限 40，超过会中途停滞
    acrobat = find_acrobat()
    js_dir = privileged_js_dir()
    driver = write_driver(js_dir, profile)
    out_dir.mkdir(parents=True, exist_ok=True)
    # 带注入内容的 PDF 副本可能有几十 MB/份，落仓库 .tmp 而不是 C 盘 %TEMP%
    work = mkdtemp("acrobat-outline-")

    print(f"Acrobat : {acrobat}")
    print(f"profile : {profile}")
    print(f"文件    : {len(files)} 个，每批 {batch}\n")

    ok = failed = 0
    try:
        for start in range(0, len(files), batch):
            chunk = files[start : start + batch]
            jobs = []
            for i, src in enumerate(chunk):
                dst = (out_dir / f"{src.stem}.outline.pdf").resolve()
                copy = work / f"w{start + i}.pdf"
                inject(src, copy, i)
                jobs.append((copy, dst))
            # 交给 Acrobat 的路径一律绝对化，否则弹模态框卡死整批（机制 8）
            proc = subprocess.Popen([acrobat, "/n", "/s", "/h", *[str(c) for c, _ in jobs]])
            done, missing = wait_outputs([d for _, d in jobs], timeout_s)
            for d in done:
                try:
                    strip_action(d)
                    n = font_count(d)
                    if n == 0:
                        ok += 1
                        print(f"  ✔ {d.name} 字体已归零")
                    else:
                        failed += 1
                        print(f"  ✖ {d.name} 仍有 {n} 处字体")
                except Exception as e:  # noqa: BLE001
                    failed += 1
                    print(f"  ✖ {d.name} 处理失败：{e}")
            for m in missing:
                failed += 1
                print(f"  ✖ {m.name} 超时未产出（看 Acrobat 是否卡在模态框）")
            # 回收本实例：不带 /F，Acrobat 自己收尾需要数十秒
            subprocess.run(["taskkill", "/PID", str(proc.pid)], capture_output=True)
    finally:
        try:
            driver.unlink(missing_ok=True)
        except OSError:
            pass
        print(f"\n临时工作目录（带注入内容的副本，可删）：{work}")

    print(f"\n{ok}/{len(files)} 成功，{failed} 失败 → {out_dir}")
    return 0 if failed == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Acrobat Preflight 转曲批处理")
    ap.add_argument("--check", action="store_true", help="只探测环境，不开 Acrobat")
    ap.add_argument("--run", nargs="+", metavar="PDF", help="要处理的文件或目录")
    ap.add_argument("--out", default="outline-acrobat")
    ap.add_argument("--batch", type=int, default=12)
    ap.add_argument("--timeout", type=int, default=180, help="每批等待秒数")
    ap.add_argument("--profile", default=PROFILE_CANDIDATES[0])
    a = ap.parse_args()
    if a.check:
        return cmd_check()
    if not a.run:
        ap.print_help()
        return 2
    return cmd_run(a.run, Path(a.out), a.batch, a.timeout, a.profile)


if __name__ == "__main__":
    sys.exit(main())
