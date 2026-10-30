# -*- coding: utf-8 -*-
"""爱印计时测试：清空 → 重新导入文件夹 → 统计「缩略图变红」进度 → 换白底/红底计时。

计时口径：对话框点「导入」那一刻 = t0（与应用开始读文件一致）。
进度信号：左侧卡片列缩略图底色变红的张数（每张卡缩略图约 122x163 屏幕像素）。
"""
import json, os, subprocess, sys, time
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cmp50"))
import win  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), ".tmp", "cmp50")
REPORT = os.path.join(OUT, "aiyin-timed.json")


def shot_win(h, path):
    return win.shot_window(path, h)


def card_red_count(img):
    """统计左侧卡片列中红底缩略图张数。列区域(窗口内)：x 55..320, y 190..880 (窗口本地)。"""
    a = np.asarray(img.convert("RGB"), dtype=np.int16)
    col = a[235:880, 245:370]
    red = (col[:, :, 0] > 180) & (col[:, :, 1] < 70) & (col[:, :, 2] < 70)
    # 每张缩略图红底约 (122*163*0.55) 像素；用中值法估每张红像素
    total = int(red.sum())
    per = 94 * 125 * 0.55
    return total, max(0, int(round(total / per)))


def main():
    h = win.find_window("爱印工具箱", 15)
    if not h:
        print("爱印窗口未找到")
        return 2
    win.foreground(h)
    rep = {"steps": []}

    # 1) 清空
    win.click(630, 938, delay=1.5)  # 清空
    img = shot_win(h, os.path.join(OUT, "t00.png"))
    rep["steps"].append({"step": "clear_clicked"})

    # 2) 导入文件夹
    win.click(576, 231, delay=2.0)
    d = win.find_window("选择文件夹", 15)
    if not d:
        img2 = shot_win(h, os.path.join(OUT, "t01.png"))
        print("no dialog; see t01.png")
        json.dump(rep, open(REPORT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        return 3
    win.foreground(d)
    # 导航：此电脑 → D: → 50 → 寸照（沿用实测坐标）
    win.click(308, 480, delay=1.0)
    win.click(741, 261, double=True, delay=1.2)   # tool (D:)
    win.click(462, 242, double=True, delay=1.2)   # 50
    win.shot_window(os.path.join(OUT, "t02.png"), d)
    win.click(462, 283, double=True, delay=1.0)   # 寸照（第 3 行）
    win.shot_window(os.path.join(OUT, "t03.png"), d)
    # t0：点击「导入」
    t0 = time.time()
    win.click(1040, 607, delay=1.0)
    rep["t0"] = t0

    # 3) 轮询红底缩略图数量
    samples = []
    last_n = -1
    t_done = None
    while time.time() - t0 < 1500:
        img = shot_win(h, os.path.join(OUT, "t_prog.png"))
        total, n = card_red_count(img)
        el = time.time() - t0
        if n != last_n:
            samples.append({"t": round(el, 1), "red": n})
            print("%6.1fs red=%d" % (el, n), flush=True)
            last_n = n
        if n >= 50:
            t_done = time.time()
            break
        time.sleep(1.2)
    rep["matte_elapsed_s"] = round(t_done - t0, 1) if t_done else None
    rep["samples_tail"] = samples[-12:]

    # 4) 换白底计时（右上面板色块：白底 (1525,386)，红底 (1575,386)）
    def timed_switch(cx, cy, want_red):
        tt = time.time()
        win.click(cx, cy, delay=0.3)
        while time.time() - tt < 600:
            img = shot_win(h, os.path.join(OUT, "t_sw.png"))
            _, n = card_red_count(img)
            if (n >= 50) if want_red else (n <= 2):
                return round(time.time() - tt, 1)
            time.sleep(1.0)
        return None

    rep["switch_white_s"] = timed_switch(1384, 359, False)
    rep["switch_red_s"] = timed_switch(1421, 359, True)
    shot_win(h, os.path.join(OUT, "t_final.png"))
    json.dump(rep, open(REPORT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps(rep, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
