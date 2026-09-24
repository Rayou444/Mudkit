"""Pont Python <-> interface web (pywebview js_api).

Chaque methode publique est appelable depuis le JS via
window.pywebview.api.methode(...). Les taches longues tournent dans un
thread et poussent des evenements au JS via window.mudkitEvent({...}).
"""
import base64
import io
import json
import logging
import os
import subprocess
import sys
import threading
import time

from . import history, logs, updater, utils, __version__
from . import notify as winnotify
from .core import compressor, converter, cutout, downloader, upscaler

IMAGE_FILTER = "Images (*.png;*.jpg;*.jpeg;*.webp;*.bmp)"
ALL_FILTER = "Tous les fichiers (*.*)"

log = logging.getLogger("mudkit.api")


def _throttle(fn, every=0.2):
    """Limite un callback de progression a ~5 appels/s (un modele de 1 Go
    en ferait sinon des milliers vers le JS). Le dernier (100 %) passe."""
    last = [0.0]

    def wrapped(done, total):
        now = time.monotonic()
        if now - last[0] >= every or (total and done >= total):
            last[0] = now
            fn(done, total)
    return wrapped


class Api:
    def __init__(self):
        self._window = None
        self._cancel = {}
        self._busy = set()
        self._update = None  # derniere reponse de updater.check()

    def attach(self, window):
        self._window = window

    # ------------------------------------------------------------ interne

    def _emit(self, evt):
        if self._window is None:
            return
        payload = json.dumps(evt, ensure_ascii=False)
        try:
            self._window.evaluate_js(
                f"window.mudkitEvent && window.mudkitEvent({payload})")
        except Exception:  # noqa: BLE001 - fenetre fermee
            pass

    def _spawn(self, task, fn, crash=None):
        """Lance fn dans un thread. Si fn retourne un evenement, il est
        emis APRES liberation de la tache (permet d'enchainer sans course).

        Si fn plante hors de ses propres try (bug), l'evenement `crash`
        (+ le message d'erreur) est emis pour que l'interface ne reste pas
        bloquee sur « en cours »."""
        if task in self._busy:
            return False
        self._busy.add(task)
        self._cancel[task] = False

        def run():
            final = None
            try:
                final = fn()
            except Exception as e:  # noqa: BLE001
                log.exception("tache %s : plantage", task)
                if crash:
                    final = dict(crash, error=f"erreur interne : {e}"[:300])
            finally:
                self._busy.discard(task)
                if final:
                    self._emit(final)
        threading.Thread(target=run, name=task, daemon=True).start()
        return True

    def _cancelled(self, task):
        return self._cancel.get(task, False)

    @staticmethod
    def _err(e, what):
        """Journalise l'exception complete, renvoie le message court pour
        l'interface."""
        log.error("%s : %s", what, e, exc_info=e)
        return str(e)[:300]

    # ------------------------------------------------------------ general

    def ui_ready(self):
        cfg = utils.load_config()
        return {
            "version": __version__,
            "dev": updater.is_dev(),
            "download_dir": cfg.get("download_dir",
                                    utils.DEFAULT_DOWNLOAD_DIR),
            "ffmpeg": utils.has_ffmpeg(),
            "realesrgan": utils.has_realesrgan(),
            "upscayl_models": utils.has_upscayl_models(),
            "models": upscaler.available_models(),
            "ytdlp": self._ytdlp_version(),
            "theme": cfg.get("theme", "light"),
            "page": cfg.get("page", "dl"),
        }

    def set_pref(self, key, value):
        """Memorise une preference d'interface (theme, dernier outil...)."""
        if key not in ("theme", "page"):
            return False
        utils.update_config(**{key: value})
        return True

    @staticmethod
    def _ytdlp_version():
        # lu sur le disque : juste apres une mise a jour, le module deja
        # importe en memoire donnerait encore l'ancienne version
        try:
            from importlib.metadata import version
            return version("yt-dlp")
        except Exception:  # noqa: BLE001
            return None

    @staticmethod
    def _dialog_types():
        import webview
        try:
            return webview.FileDialog.OPEN, webview.FileDialog.FOLDER
        except AttributeError:  # pywebview < 6
            return webview.OPEN_DIALOG, webview.FOLDER_DIALOG

    def pick_files(self, kind="any"):
        open_dlg, _ = self._dialog_types()
        filt = [IMAGE_FILTER] if kind == "images" else [ALL_FILTER]
        picked = self._window.create_file_dialog(
            open_dlg, allow_multiple=True, file_types=tuple(filt))
        return list(picked or [])

    def pick_folder(self):
        _, folder_dlg = self._dialog_types()
        picked = self._window.create_file_dialog(folder_dlg)
        return picked[0] if picked else None

    def open_path(self, path):
        if os.path.exists(path):
            os.startfile(path)  # noqa: S606 - action demandee par l'utilisateur
            return True
        return False

    def open_url(self, url):
        if isinstance(url, str) and url.startswith("https://"):
            os.startfile(url)  # noqa: S606 - navigateur par defaut
            return True
        return False

    def reveal_file(self, path):
        if os.path.exists(path):
            subprocess.Popen(["explorer", "/select,", path],
                             creationflags=utils.NO_WINDOW)
            return True
        return False

    def set_download_dir(self):
        picked = self.pick_folder()
        if picked:
            utils.update_config(download_dir=picked)
        return picked

    def file_infos(self, paths):
        """Nom + taille + categorie pour afficher une liste de fichiers."""
        out = []
        for p in paths:
            try:
                size = utils.human_size(os.path.getsize(p))
            except OSError:
                size = "?"
            out.append({"path": p, "name": os.path.basename(p),
                        "size": size, "category": converter.category(p)})
        return out

    def paste_files(self):
        """Contenu du presse-papiers : fichiers copies, ou image (capture).

        Une image bitmap est enregistree dans Images\\Mudkit puis renvoyee
        comme un fichier normal.
        """
        try:
            utils.pil_image()  # leve la limite anti-bombe avant ImageGrab
            from PIL import ImageGrab
            data = ImageGrab.grabclipboard()
        except Exception:  # noqa: BLE001 - presse-papiers illisible
            data = None
        if isinstance(data, list):
            return {"paths": [p for p in data if os.path.isfile(p)]}
        if data is not None and hasattr(data, "save"):
            folder = os.path.join(os.path.expanduser("~"), "Pictures",
                                  "Mudkit")
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(
                folder, time.strftime("capture_%Y%m%d_%H%M%S") + ".png")
            data.save(path)
            return {"paths": [path], "captured": True}
        return {"paths": []}

    def thumb(self, path, box=128):
        """Miniature base64 d'une image locale."""
        return self._jpeg_data_uri(path, box, 80)

    def preview(self, path, box=1600):
        """Grande previsualisation base64 d'une image locale."""
        return self._jpeg_data_uri(path, box, 87)

    def preview_png(self, path, box=1400):
        """Previsualisation base64 en PNG (conserve la transparence)."""
        try:
            Image = utils.pil_image()
            with Image.open(path) as img:
                img.thumbnail((box, box))
                buf = io.BytesIO()
                img.save(buf, "PNG")
            return ("data:image/png;base64,"
                    + base64.b64encode(buf.getvalue()).decode())
        except Exception:  # noqa: BLE001 - apercu facultatif
            return None

    @staticmethod
    def _jpeg_data_uri(path, box, quality):
        try:
            Image = utils.pil_image()
            with Image.open(path) as img:
                img.thumbnail((box, box))
                buf = io.BytesIO()
                img.convert("RGB").save(buf, "JPEG", quality=quality)
            return ("data:image/jpeg;base64,"
                    + base64.b64encode(buf.getvalue()).decode())
        except Exception:  # noqa: BLE001 - apercu facultatif
            return None

    # ------------------------------------------ diagnostic & notifications

    def log_js(self, msg):
        """Erreur remontee par l'interface (exception JS, appel rate)."""
        log.error("interface : %s", str(msg)[:2000])
        return True

    def error_report(self, context=None):
        return logs.report(context)

    def open_logs(self):
        os.makedirs(utils.LOG_DIR, exist_ok=True)
        os.startfile(utils.LOG_DIR)  # noqa: S606
        return True

    def notify(self, title, text):
        """Notification Windows, seulement si Mudkit est en arriere-plan."""
        return winnotify.notify(self._window, title, text)

    # ---------------------------------------------------------- historique

    def history_list(self):
        return history.items()

    def history_remove(self, entry_id):
        return history.remove(entry_id)

    def history_clear(self):
        return history.clear()

    # ------------------------------------------------------ mises a jour

    def update_check(self):
        if updater.is_dev():
            return {"dev": True, "current": __version__}
        try:
            self._update = updater.check()
            return self._update
        except Exception as e:  # noqa: BLE001 - hors ligne, GitHub indispo
            log.warning("verification des mises a jour impossible : %s", e)
            return {"error": str(e)[:200], "current": __version__}

    def update_start(self):
        info = self._update
        if not info or not info.get("available") or not info.get("asset"):
            return False

        def job():
            path = None
            try:
                path = updater.download(info["asset"], _throttle(
                    lambda done, total: self._emit(
                        {"type": "upd_progress",
                         "pct": done / total if total else None})))
                version = updater.apply(path)
                return {"type": "upd_done", "ok": True, "version": version,
                        "premiere": updater.premiere_running()}
            except updater.NeedFullInstall:
                return {"type": "upd_done", "ok": False, "full_only": True,
                        "page": info["page"]}
            except Exception as e:  # noqa: BLE001
                return {"type": "upd_done", "ok": False,
                        "error": self._err(e, "mise a jour")}
            finally:
                if path and os.path.exists(path):
                    os.remove(path)
        return self._spawn("update", job,
                           crash={"type": "upd_done", "ok": False})

    def update_restart(self):
        updater.restart()
        self._window.destroy()
        return True

    # ------------------------------------------------------------ moteurs

    def install_tool(self, name):
        fn = {"ffmpeg": utils.install_ffmpeg,
              "realesrgan": utils.install_realesrgan,
              "upscayl_models": utils.install_upscayl_models}.get(name)
        if fn is None:
            return False

        def job():
            def prog(done, total):
                self._emit({"type": "install", "name": name,
                            "pct": done / total if total else None,
                            "done": utils.human_size(done)})
            try:
                fn(_throttle(prog))
                self._emit({"type": "install_done", "name": name,
                            "ok": True})
            except Exception as e:  # noqa: BLE001
                self._emit({"type": "install_done", "name": name,
                            "ok": False,
                            "error": self._err(e, f"installation {name}")})
        return self._spawn(f"install_{name}", job,
                           crash={"type": "install_done", "name": name,
                                  "ok": False})

    def update_ytdlp(self):
        def job():
            r = utils.run_hidden(
                [sys.executable, "-c",
                 "import sys; sys.path.insert(0, r'" + utils.ROOT + "'); "
                 "from mudkit import dnsfix; dnsfix.activate_if_needed(); "
                 "sys.argv = ['pip', 'install', '-q', '-U', 'yt-dlp']; "
                 "from pip._internal.cli.main import main; sys.exit(main())"])
            if r.returncode != 0:
                log.error("mise a jour yt-dlp : code %s\n%s", r.returncode,
                          (r.stderr or r.stdout or "")[-2000:])
            return {"type": "ytdlp_updated", "ok": r.returncode == 0,
                    "version": self._ytdlp_version()}
        return self._spawn("update_ytdlp", job,
                           crash={"type": "ytdlp_updated", "ok": False})

    # ------------------------------------------------------- telechargeur

    def analyze_url(self, url):
        try:
            return {"ok": True, "info": downloader.analyze(url)}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": self._err(e, f"analyse {url}")}

    def start_download(self, opts):
        cfg = utils.load_config()
        dest = cfg.get("download_dir", utils.DEFAULT_DOWNLOAD_DIR)

        section = opts.get("section")
        sec = ((float(section["start"]), float(section["end"]))
               if section else None)

        def job():
            try:
                res = downloader.download(
                    opts["url"], opts["mode"], opts["quality"],
                    opts["format"], opts.get("playlist", False), dest,
                    lambda p: self._emit({"type": "dl_progress", **p}),
                    lambda: self._cancelled("download"), section=sec)
                entry = history.add({
                    "title": res["title"], "url": opts["url"],
                    "files": res["files"], "thumb": res["thumb"],
                    "mode": opts["mode"], "quality": opts["quality"],
                    "format": opts["format"],
                    "playlist": bool(opts.get("playlist"))})
                entry["exists"] = bool(res["files"])
                return {"type": "dl_done", "ok": True,
                        "title": res["title"], "dest": dest,
                        "history": entry}
            except utils.CancelledError:
                return {"type": "dl_done", "ok": False, "cancelled": True}
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                if "CancelledError" in msg:
                    return {"type": "dl_done", "ok": False,
                            "cancelled": True}
                return {"type": "dl_done", "ok": False,
                        "error": self._err(e, f"telechargement {opts['url']}")}
        return self._spawn("download", job,
                           crash={"type": "dl_done", "ok": False})

    def cancel(self, task):
        self._cancel[task] = True
        return True

    # ---------------------------------------------------------- upscaler

    def start_upscale(self, opts):
        files, model = opts["files"], opts["model"]
        scale = int(opts["scale"])
        fmt = opts.get("out_format", "png")

        def job():
            ok = 0
            for i, src in enumerate(files):
                self._emit({"type": "up_progress", "index": i, "pct": 0})
                try:
                    out = upscaler.upscale_one(
                        src, model, scale, fmt,
                        lambda p, i=i: self._emit(
                            {"type": "up_progress", "index": i, "pct": p}),
                        lambda: self._cancelled("upscale"))
                    ok += 1
                    self._emit({"type": "up_file_done", "index": i,
                                "ok": True, "out": out})
                except utils.CancelledError:
                    self._emit({"type": "up_done", "ok": ok,
                                "total": len(files), "cancelled": True})
                    return
                except Exception as e:  # noqa: BLE001
                    self._emit({"type": "up_file_done", "index": i,
                                "ok": False,
                                "error": self._err(e, f"upscale {src}")})
            self._emit({"type": "up_done", "ok": ok, "total": len(files)})
        return self._spawn("upscale", job, crash={
            "type": "up_done", "ok": 0, "total": len(files)})

    # ---------------------------------------------------------- detourage

    def start_cutout(self, opts):
        files, model = opts["files"], opts["model"]

        def job():
            ok = 0
            for i, src in enumerate(files):
                emit_model = _throttle(lambda pct, _, i=i: self._emit(
                    {"type": "bg_progress", "index": i, "phase": "model",
                     "pct": pct}))

                def on_phase(phase, pct, i=i, emit_model=emit_model):
                    if phase == "model" and pct is not None:
                        emit_model(pct, 1.0)  # telechargement du modele
                    else:
                        self._emit({"type": "bg_progress", "index": i,
                                    "phase": phase, "pct": pct})
                try:
                    out = cutout.cutout_one(
                        src, model, on_phase,
                        lambda: self._cancelled("cutout"))
                    ok += 1
                    self._emit({"type": "bg_file_done", "index": i,
                                "ok": True, "out": out})
                except utils.CancelledError:
                    self._emit({"type": "bg_done", "ok": ok,
                                "total": len(files), "cancelled": True})
                    return
                except Exception as e:  # noqa: BLE001
                    self._emit({"type": "bg_file_done", "index": i,
                                "ok": False,
                                "error": self._err(e, f"detourage {src}")})
            self._emit({"type": "bg_done", "ok": ok, "total": len(files)})
        return self._spawn("cutout", job, crash={
            "type": "bg_done", "ok": 0, "total": len(files)})

    # -------------------------------------------------------- compresseur

    def start_compress(self, opts):
        files = opts["files"]
        target_mb = float(opts["target_mb"])

        def job():
            ok = 0
            for i, src in enumerate(files):
                is_img = converter.category(src) == "image"
                self._emit({"type": "cp_progress", "index": i, "pct": 0,
                            "img": is_img})
                try:
                    orig = os.path.getsize(src)
                    out, size = compressor.compress_any(
                        src, target_mb,
                        lambda p, i=i, im=is_img: self._emit(
                            {"type": "cp_progress", "index": i, "pct": p,
                             "img": im}),
                        lambda: self._cancelled("compress"))
                    ok += 1
                    self._emit({"type": "cp_file_done", "index": i,
                                "ok": True, "out": out,
                                "orig": utils.human_size(orig),
                                "size": utils.human_size(size)})
                except utils.CancelledError:
                    self._emit({"type": "cp_done", "ok": ok,
                                "total": len(files), "cancelled": True})
                    return
                except Exception as e:  # noqa: BLE001
                    self._emit({"type": "cp_file_done", "index": i,
                                "ok": False,
                                "error": self._err(e, f"compression {src}")})
            self._emit({"type": "cp_done", "ok": ok, "total": len(files)})
        return self._spawn("compress", job, crash={
            "type": "cp_done", "ok": 0, "total": len(files)})

    # -------------------------------------------------------- convertisseur

    def detect_targets(self, paths):
        cats = {converter.category(p) for p in paths}
        cats.discard(None)
        if len(cats) != 1:
            return {"category": None, "targets": []}
        cat = cats.pop()
        return {"category": cat, "targets": converter.TARGETS[cat]}

    def start_convert(self, opts):
        files, target = opts["files"], opts["target"]

        def job():
            ok = 0
            for i, src in enumerate(files):
                self._emit({"type": "cv_progress", "index": i, "pct": 0})
                try:
                    out = converter.convert_one(
                        src, target,
                        lambda p, i=i: self._emit(
                            {"type": "cv_progress", "index": i, "pct": p}),
                        lambda: self._cancelled("convert"))
                    ok += 1
                    self._emit({"type": "cv_file_done", "index": i,
                                "ok": True, "out": out})
                except utils.CancelledError:
                    self._emit({"type": "cv_done", "ok": ok,
                                "total": len(files), "cancelled": True})
                    return
                except Exception as e:  # noqa: BLE001
                    self._emit({"type": "cv_file_done", "index": i,
                                "ok": False,
                                "error": self._err(e, f"conversion {src}")})
            self._emit({"type": "cv_done", "ok": ok, "total": len(files)})
        return self._spawn("convert", job, crash={
            "type": "cv_done", "ok": 0, "total": len(files)})
