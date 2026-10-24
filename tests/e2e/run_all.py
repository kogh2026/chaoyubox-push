# -*- coding: utf-8 -*-
"""E2E 一键 runner：起 vite preview → 依次跑全部 E2E → 汇总 → 关服务。

用法：
    python tests/e2e/run_all.py      # 或 npm run test:e2e

说明：
- 端口 4173 已被占用时复用现有服务（不重复起）；
- 需要仓库已 build（dist/ 存在）且 npm 依赖已安装；
- playwright 的 Python 包需可用（pip install playwright + playwright install chromium）。
"""
import os
import shutil
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))  # tests/e2e → repo root
PORT = 4173
SCRIPTS = ["test_hotkeys.py", "test_drop.py", "test_detect.py"]


def wait_port(port: int, timeout: float = 30.0) -> bool:
    """双栈轮询：vite preview 默认绑 localhost（可能是 IPv6 ::1），
    chromium/curl 会自动 fallback，但裸 socket 不会，两个地址都要试。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        for host in ("127.0.0.1", "::1"):
            try:
                with socket.create_connection((host, port), timeout=1):
                    return True
            except OSError:
                pass
        time.sleep(0.3)
    return False


def start_server():
    """优先 node 直跑 vite.js（进程树干净，terminate 即可回收）；
    node 不在 PATH 时退化成 PATH 注入 + shell。"""
    env = dict(os.environ)
    node = shutil.which("node")
    vite_js = os.path.join(ROOT, "node_modules", "vite", "bin", "vite.js")
    if node and os.path.exists(vite_js):
        return subprocess.Popen(
            [node, vite_js, "preview", "--port", str(PORT), "--strictPort"],
            cwd=ROOT,
            env=env,
        )
    bin_dir = os.path.join(ROOT, "node_modules", ".bin")
    env["PATH"] = bin_dir + os.pathsep + env.get("PATH", "")
    return subprocess.Popen(
        f"vite preview --port {PORT} --strictPort",
        cwd=ROOT,
        shell=True,
        env=env,
    )


def main() -> int:
    if not os.path.isdir(os.path.join(ROOT, "dist")):
        print("dist/ 不存在，请先 npm run build")
        return 2

    server = None
    if wait_port(PORT, 1):
        print(f"检测到 {PORT} 已有服务，复用")
    else:
        server = start_server()

    try:
        if not wait_port(PORT, 30):
            print("预览服务启动超时（30s）")
            return 2
        results = []
        for s in SCRIPTS:
            print(f"\n===== {s} =====", flush=True)
            r = subprocess.run([sys.executable, os.path.join(HERE, s)], cwd=HERE)
            results.append((s, r.returncode))
    finally:
        if server is not None:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()

    print("\n===== 汇总 =====")
    bad = 0
    for name, code in results:
        print(f"  {name}: {'PASS' if code == 0 else 'FAIL'}")
        bad += code != 0
    print("E2E_ALL_OK" if bad == 0 else f"E2E_ALL_FAIL ({bad} 个失败)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
