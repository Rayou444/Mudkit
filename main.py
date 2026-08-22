"""Mudkit - point d'entree (fenetre native + interface web locale)."""
import ctypes
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from mudkit import dnsfix

# Resolveur tolerant aux pannes DNS (bascule DoH automatique).
dnsfix.activate_if_needed()

import webview  # noqa: E402

from mudkit.api import Api  # noqa: E402


def _set_window_icon():
    """Pose l'icone Mudkit sur la fenetre (titre, barre des taches, alt-tab).

    Win32 direct avec types explicites : sous 64 bits, sans argtypes/restype,
    ctypes tronque les HANDLE et l'icone est perdue en silence.
    """
    import threading
    import time
    from ctypes import wintypes

    ico = os.path.join(ROOT, "assets", "mudkit.ico")
    user32 = ctypes.windll.user32
    user32.FindWindowW.restype = wintypes.HWND
    user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
    user32.LoadImageW.restype = wintypes.HANDLE
    user32.LoadImageW.argtypes = [
        wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT,
        ctypes.c_int, ctypes.c_int, wintypes.UINT]
    user32.SendMessageW.restype = ctypes.c_ssize_t
    user32.SendMessageW.argtypes = [
        wintypes.HWND, wintypes.UINT, ctypes.c_size_t, ctypes.c_ssize_t]

    IMAGE_ICON, LR_LOADFROMFILE = 1, 0x10
    WM_SETICON, ICON_SMALL, ICON_BIG = 0x0080, 0, 1

    def job():
        hwnd = None
        for _ in range(100):  # attend la creation de la fenetre (max 10 s)
            hwnd = user32.FindWindowW(None, "Mudkit")
            if hwnd:
                break
            time.sleep(0.1)
        if not hwnd:
            return
        for size, which in ((16, ICON_SMALL), (32, ICON_BIG)):
            hicon = user32.LoadImageW(None, ico, IMAGE_ICON,
                                      size, size, LR_LOADFROMFILE)
            if hicon:
                user32.SendMessageW(hwnd, WM_SETICON, which, hicon)

    threading.Thread(target=job, daemon=True).start()


def _post_start(window):
    _set_window_icon()


def main():
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
            "Rayan.Mudkit")
    except Exception:  # noqa: BLE001
        pass

    api = Api()
    window = webview.create_window(
        "Mudkit",
        os.path.join(ROOT, "mudkit", "ui", "index.html"),
        js_api=api,
        width=1220, height=800, min_size=(980, 640),
        background_color="#081019",
    )
    api.attach(window)
    webview.start(_post_start, window, http_server=True)


if __name__ == "__main__":
    main()
