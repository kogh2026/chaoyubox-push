# -*- coding: utf-8 -*-
"""最小化 Windows 窗口/输入控制（ctypes，无第三方依赖），用于驱动原生应用 UI。"""
import ctypes
import ctypes.wintypes as wt
import subprocess
import time

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

SW_RESTORE = 9
SW_SHOW = 5
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
KEYEVENTF_KEYUP = 0x0002
VK = {
    "enter": 0x0D, "esc": 0x1B, "tab": 0x09, "back": 0x08, "del": 0x2E,
    "ctrl": 0x11, "shift": 0x10, "alt": 0x12, "a": 0x41, "v": 0x56, "c": 0x43,
    "colon": 0xBA, "backslash": 0xDC,
}


def find_window(title_substr, timeout=30.0, class_name=None):
    """按标题子串找可见顶层窗口句柄。"""
    found = []
    CB = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)

    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        if title_substr in buf.value:
            if class_name:
                cbuf = ctypes.create_unicode_buffer(256)
                user32.GetClassNameW(hwnd, cbuf, 256)
                if cbuf.value != class_name:
                    return True
            found.append((hwnd, buf.value))
        return True

    deadline = time.time() + timeout
    while time.time() < deadline:
        found.clear()
        user32.EnumWindows(CB(cb), 0)
        if found:
            return found[0][0]
        time.sleep(0.5)
    return None


def window_title(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def rect(hwnd):
    r = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right, r.bottom


def foreground(hwnd):
    user32.ShowWindow(hwnd, SW_RESTORE)
    # 绕过前台窗口切换限制
    user32.keybd_event(VK["alt"], 0, 0, 0)
    user32.keybd_event(VK["alt"], 0, KEYEVENTF_KEYUP, 0)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.4)


def move_resize(hwnd, x, y, w, h):
    user32.SetWindowPos(hwnd, 0, x, y, w, h, 0x0004 | 0x0010)  # NOZORDER|NOACTIVATE
    time.sleep(0.4)


def click(x, y, double=False, delay=0.25):
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.08)
    for _ in range(2 if double else 1):
        user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        time.sleep(0.03)
        user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
        time.sleep(0.08)
    time.sleep(delay)


def key(name, times=1):
    vk = VK.get(name.lower())
    if vk is None:
        vk = ord(name.upper())
    for _ in range(times):
        user32.keybd_event(vk, 0, 0, 0)
        time.sleep(0.02)
        user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.06)


def hotkey(*names):
    vks = []
    for n in names:
        v = VK.get(n.lower())
        vks.append(v if v is not None else ord(n.upper()[0]))
    for vk in vks:
        user32.keybd_event(vk, 0, 0, 0)
        time.sleep(0.02)
    for vk in reversed(vks):
        user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.02)
    time.sleep(0.15)


def type_text(text):
    """只支持 ASCII（路径/数字），逐字符 VkKeyScan 映射，带 shift 处理。"""
    for ch in text:
        vk_scan = user32.VkKeyScanW(ord(ch))
        vk, shift = vk_scan & 0xFF, (vk_scan >> 8) & 0xFF
        if vk == 0xFF:
            continue
        if shift & 1:
            user32.keybd_event(VK["shift"], 0, 0, 0)
        user32.keybd_event(vk, 0, 0, 0)
        time.sleep(0.012)
        user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
        if shift & 1:
            user32.keybd_event(VK["shift"], 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.012)


def shot(path, tries=8):
    """截图偶尔失败（显示驱动抖动），自动重试。"""
    from PIL import ImageGrab
    last = None
    for _ in range(tries):
        try:
            img = ImageGrab.grab(all_screens=True)
            img.save(path)
            return img
        except OSError as e:
            last = e
            time.sleep(0.7)
    raise last


def shot_window(path, hwnd, tries=6):
    """对指定窗口用 PrintWindow 截图（不受全屏抓屏失败影响）。"""
    from PIL import Image
    l, t, r, b = rect(hwnd)
    w, h = r - l, b - t
    last = None
    for _ in range(tries):
        hdc = user32.GetWindowDC(hwnd)
        if hdc:
            mem = gdi32.CreateCompatibleDC(hdc)
            bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
            old = gdi32.SelectObject(mem, bmp)
            ok = user32.PrintWindow(hwnd, mem, 2)  # PW_RENDERFULLCONTENT
            class BMIH(ctypes.Structure):
                _fields_ = [("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int32),
                            ("biHeight", ctypes.c_int32), ("biPlanes", ctypes.c_uint16),
                            ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32),
                            ("biSizeImage", ctypes.c_uint32), ("biXPelsPerMeter", ctypes.c_int32),
                            ("biYPelsPerMeter", ctypes.c_int32), ("biClrUsed", ctypes.c_uint32),
                            ("biClrImportant", ctypes.c_uint32)]
            info = BMIH()
            info.biSize = ctypes.sizeof(BMIH)
            info.biWidth = w
            info.biHeight = -h
            info.biPlanes = 1
            info.biBitCount = 32
            info.biCompression = 0
            buf = ctypes.create_string_buffer(w * h * 4)
            gdi32.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(info), 0)
            gdi32.SelectObject(mem, old)
            gdi32.DeleteObject(bmp)
            gdi32.DeleteDC(mem)
            user32.ReleaseDC(hwnd, hdc)
            if ok:
                img = Image.frombuffer("RGBA", (w, h), buf.raw, "raw", "BGRA", 0, 1).convert("RGB")
                img.save(path)
                return img
        last = RuntimeError("PrintWindow failed")
        time.sleep(0.5)
    raise last


def foreground_strong(hwnd):
    """强制置顶再激活（对付覆盖在上面的其他窗口）。"""
    HWND_TOPMOST, HWND_NOTOPMOST = -1, -2
    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)  # NOSIZE|NOMOVE|SHOWWINDOW
    user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.35)
    return user32.GetForegroundWindow() == hwnd
