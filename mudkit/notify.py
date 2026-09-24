"""Notification Windows quand une tache longue se termine.

Seulement si la fenetre de Mudkit n'est pas au premier plan : le bouton
de la barre des taches clignote, et une bulle (NotifyIcon WinForms, affichee
comme une notification sous Windows 10/11) donne le resultat. pywebview
tourne deja sur WinForms, donc aucune dependance en plus.
"""
import ctypes
import logging
import os
from ctypes import wintypes

from . import utils

log = logging.getLogger("mudkit.notify")
user32 = ctypes.windll.user32
user32.GetForegroundWindow.restype = wintypes.HWND

_icon = None  # NotifyIcon unique, cree a la premiere notification


class _FLASHWINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("hwnd", wintypes.HWND),
                ("dwFlags", wintypes.DWORD), ("uCount", wintypes.UINT),
                ("dwTimeout", wintypes.DWORD)]


def _hwnd(window):
    try:
        return int(window.native.Handle.ToInt64())
    except Exception:  # noqa: BLE001 - fenetre pas encore creee / fermee
        return None


def is_foreground(window):
    hwnd = _hwnd(window)
    fg = user32.GetForegroundWindow()
    return bool(hwnd) and fg is not None and int(fg) == hwnd


def _flash(hwnd):
    FLASHW_ALL, FLASHW_TIMERNOFG = 0x3, 0xC  # clignote jusqu'au retour
    info = _FLASHWINFO(ctypes.sizeof(_FLASHWINFO), hwnd,
                       FLASHW_ALL | FLASHW_TIMERNOFG, 0, 0)
    user32.FlashWindowEx(ctypes.byref(info))


def _balloon(window, title, text):
    import clr  # noqa: F401 - pythonnet, charge par pywebview
    from System import Action
    from System.Drawing import Icon
    from System.Windows.Forms import FormWindowState, NotifyIcon, ToolTipIcon

    form = window.native

    def show():
        global _icon
        if _icon is None:
            _icon = NotifyIcon()
            _icon.Icon = Icon(os.path.join(utils.ROOT, "assets", "mudkit.ico"))
            _icon.Text = "Mudkit"

            def front(*_):
                try:
                    if form.WindowState == FormWindowState.Minimized:
                        form.WindowState = FormWindowState.Normal
                    form.Activate()
                except Exception:  # noqa: BLE001
                    pass
            _icon.BalloonTipClicked += front
            _icon.DoubleClick += front
        _icon.Visible = True
        _icon.ShowBalloonTip(8000, title, text, ToolTipIcon.Info)

    form.BeginInvoke(Action(show))  # NotifyIcon vit sur le thread de l'UI


def notify(window, title, text):
    """Renvoie True si une notification a ete affichee."""
    if window is None or is_foreground(window):
        return False
    hwnd = _hwnd(window)
    if hwnd:
        _flash(hwnd)
    try:
        _balloon(window, title, text)
    except Exception:  # noqa: BLE001 - confort, jamais bloquant
        log.exception("notification impossible")
    return True


def cleanup():
    """Retire l'icone de la zone de notification a la fermeture (sinon elle
    reste affichee jusqu'au survol de la souris)."""
    global _icon
    icon, _icon = _icon, None
    if icon is None:
        return
    try:
        # Visible = False -> Shell_NotifyIcon(NIM_DELETE), valable depuis
        # n'importe quel thread ; pas d'Invoke pour ne jamais bloquer la
        # fermeture.
        icon.Visible = False
    except Exception:  # noqa: BLE001
        pass
