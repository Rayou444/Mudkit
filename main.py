"""Mudkit - point d'entree (fenetre native + interface web locale)."""
import ctypes
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from mudkit import dnsfix, utils

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


def _wire_drops(window, api):
    """Enregistre les zones de depot cote Python.

    pywebview ne fournit les chemins complets des fichiers deposes qu'aux
    handlers DOM enregistres cote Python (jamais au JS de la page) : le
    natif ne capture d'ailleurs les chemins que si au moins un handler
    'drop' Python existe (_dnd_state['num_listeners'] > 0).
    """
    from webview.dom import DOMEventHandler

    def make_handler(zone):
        def on_drop(e):
            files = (e.get("dataTransfer") or {}).get("files") or []
            paths = [f.get("pywebviewFullPath") for f in files
                     if f.get("pywebviewFullPath")]
            if paths:
                api._emit({"type": "dropped", "zone": zone,  # noqa: SLF001
                           "paths": paths})
        return on_drop

    wired = 0
    for zone in ("#up-drop", "#cv-drop", "#cp-drop", "#bg-drop"):
        try:
            el = window.dom.get_element(zone)
            if el is not None:
                el.events.drop += DOMEventHandler(make_handler(zone),
                                                  prevent_default=True)
                wired += 1
        except Exception:  # noqa: BLE001 - zone absente : on continue
            pass
    print(f"zones de depot cablees: {wired}", flush=True)


def _window_geometry():
    """Taille et position d'ouverture.

    Reprend la geometrie memorisee si elle tient encore dans l'ecran,
    sinon ouvre a ~80 % de l'ecran principal, centre.
    """
    cfg = utils.load_config()
    try:
        ctypes.windll.user32.SetProcessDPIAware()  # meme reglage que pywebview
        sw = ctypes.windll.user32.GetSystemMetrics(0)
        sh = ctypes.windll.user32.GetSystemMetrics(1)
    except Exception:  # noqa: BLE001
        sw, sh = 1920, 1080

    geo = cfg.get("window") or {}
    w, h = geo.get("w"), geo.get("h")
    if not (w and h and 900 <= w <= sw and 600 <= h <= sh):
        w = min(max(1100, int(sw * 0.80)), 1720, sw - 40)
        h = min(max(720, int(sh * 0.82)), 1080, sh - 80)
    x, y = geo.get("x"), geo.get("y")
    if x is None or y is None or not (0 <= x <= sw - 300 and 0 <= y <= sh - 300):
        x, y = (sw - w) // 2, max(0, (sh - h) // 2 - 20)
    return w, h, x, y


def _save_geometry(window):
    try:
        cfg = utils.load_config()
        cfg["window"] = {"w": int(window.width), "h": int(window.height),
                         "x": int(window.x), "y": int(window.y)}
        utils.save_config(cfg)
    except Exception:  # noqa: BLE001 - confort, jamais bloquant
        pass


def _post_start(window):
    _set_window_icon()


def main():
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
            "Rayan.Mudkit")
    except Exception:  # noqa: BLE001
        pass

    api = Api()
    w, h, x, y = _window_geometry()
    window = webview.create_window(
        "Mudkit",
        os.path.join(ROOT, "mudkit", "ui", "index.html"),
        js_api=api,
        width=w, height=h, x=x, y=y, min_size=(980, 640),
        background_color="#0A0E14",
    )
    api.attach(window)
    window.events.loaded += lambda *a: _wire_drops(window, api)
    window.events.closing += lambda *a: _save_geometry(window)
    webview.start(_post_start, window, http_server=True)


if __name__ == "__main__":
    main()
