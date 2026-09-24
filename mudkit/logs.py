"""Journal de Mudkit : %LOCALAPPDATA%\\Mudkit\\logs\\mudkit.log.

Lance via pythonw, Mudkit n'a pas de console : sys.stdout / sys.stderr
valent None, et la moindre bibliotheque qui ecrit dessus (barre de
progression tqdm, print...) leve une exception. On les redirige vers ce
journal, qui sert aussi au rapport d'erreur que l'utilisateur peut copier.
"""
import logging
import logging.handlers
import os
import platform
import sys
import threading

from . import __version__, utils

LOG_FILE = os.path.join(utils.LOG_DIR, "mudkit.log")
log = logging.getLogger("mudkit")


class _StreamToLog:
    """Faux flux texte qui envoie chaque ligne au journal."""

    def __init__(self, level):
        self.level = level
        self._buf = ""

    def write(self, s):
        self._buf += s
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            line = line.rsplit("\r", 1)[-1].rstrip()  # barres de progression
            if line:
                log.log(self.level, line)
        return len(s)

    def flush(self):
        pass

    def isatty(self):
        return False


def setup():
    """A appeler en tout premier au demarrage."""
    try:
        os.makedirs(utils.LOG_DIR, exist_ok=True)
        handler = logging.handlers.RotatingFileHandler(
            LOG_FILE, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    except OSError:
        handler = logging.NullHandler()
    handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)-7s [%(threadName)s] %(name)s: %(message)s",
        "%Y-%m-%d %H:%M:%S"))
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.INFO)

    if sys.stdout is None:
        sys.stdout = _StreamToLog(logging.INFO)
    if sys.stderr is None:
        sys.stderr = _StreamToLog(logging.WARNING)

    def hook(exc_type, exc, tb):
        log.critical("exception non geree", exc_info=(exc_type, exc, tb))
    sys.excepthook = hook
    threading.excepthook = lambda a: log.critical(
        "exception non geree dans %s", a.thread and a.thread.name,
        exc_info=(a.exc_type, a.exc_value, a.exc_traceback))

    log.info("Mudkit %s | Python %s | %s | %s", __version__,
             platform.python_version(), platform.platform(), sys.executable)


def tail(lines=150):
    """Dernieres lignes du journal (fichier courant + precedent)."""
    out = []
    for path in (LOG_FILE + ".1", LOG_FILE):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                out.extend(f.read().splitlines())
        except OSError:
            pass
    return out[-lines:]


def report(extra=None):
    """Texte a copier-coller pour signaler un probleme."""
    cfg = utils.load_config()
    head = [
        f"Mudkit {__version__}",
        f"Windows : {platform.platform()}",
        f"Python : {platform.python_version()} ({sys.executable})",
        f"Dossier : {utils.ROOT}",
        f"ffmpeg : {'oui' if utils.has_ffmpeg() else 'NON'} | "
        f"Real-ESRGAN : {'oui' if utils.has_realesrgan() else 'NON'} | "
        f"NVENC : {cfg.get('nvenc', '?')}",
    ]
    if extra:
        head.append(f"Contexte : {extra}")
    return ("\n".join(head) + "\n\n--- journal (fin) ---\n"
            + "\n".join(tail()))
