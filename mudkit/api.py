"""Pont Python <-> interface web (pywebview js_api).

Chaque methode publique est appelable depuis le JS via
window.pywebview.api.methode(...). Les taches longues tournent dans un
thread et poussent des evenements au JS via window.mudkitEvent({...}).
"""
import base64
import io
import json
import os
import subprocess
import sys
import threading

from . import utils, __version__
from .core import compressor, converter, cutout, downloader, upscaler

IMAGE_FILTER = "Images (*.png;*.jpg;*.jpeg;*.webp;*.bmp)"
ALL_FILTER = "Tous les fichiers (*.*)"


class Api:
    def __init__(self):
        self._window = None
        self._cancel = {}
        self._busy = set()

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

    def _spawn(self, task, fn):
        """Lance fn dans un thread. Si fn retourne un evenement, il est
        emis APRES liberation de la tache (permet d'enchainer sans course)."""
        if task in self._busy:
            return False
        self._busy.add(task)
        self._cancel[task] = False

        def run():
            final = None
            try:
                final = fn()
            finally:
                self._busy.discard(task)
                if final:
                    self._emit(final)
        threading.Thread(target=run, daemon=True).start()
        return True

    def _cancelled(self, task):
        return self._cancel.get(task, False)

    # ------------------------------------------------------------ general

    def ui_ready(self):
        cfg = utils.load_config()
        return {
            "version": __version__,
            "download_dir": cfg.get("download_dir",
                                    utils.DEFAULT_DOWNLOAD_DIR),
            "ffmpeg": utils.has_ffmpeg(),
            "realesrgan": utils.has_realesrgan(),
            "upscayl_models": utils.has_upscayl_models(),
            "models": upscaler.available_models(),
            "ytdlp": self._ytdlp_version(),
            "theme": cfg.get("theme", "dark"),
        }

    def set_pref(self, key, value):
        """Memorise une preference d'interface (theme, ...)."""
        if key not in ("theme",):
            return False
        cfg = utils.load_config()
        cfg[key] = value
        utils.save_config(cfg)
        return True

    @staticmethod
    def _ytdlp_version():
        try:
            import yt_dlp
            return yt_dlp.version.__version__
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

    def reveal_file(self, path):
        if os.path.exists(path):
            subprocess.Popen(["explorer", "/select,", path],
                             creationflags=utils.NO_WINDOW)
            return True
        return False

    def set_download_dir(self):
        picked = self.pick_folder()
        if picked:
            cfg = utils.load_config()
            cfg["download_dir"] = picked
            utils.save_config(cfg)
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
            import time
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
                fn(prog)
                self._emit({"type": "install_done", "name": name,
                            "ok": True})
            except Exception as e:  # noqa: BLE001
                self._emit({"type": "install_done", "name": name,
                            "ok": False, "error": str(e)[:300]})
        return self._spawn(f"install_{name}", job)

    def update_ytdlp(self):
        def job():
            code = subprocess.call(
                [sys.executable, "-c",
                 "import sys; sys.path.insert(0, r'" + utils.ROOT + "'); "
                 "from mudkit import dnsfix; dnsfix.activate_if_needed(); "
                 "sys.argv = ['pip', 'install', '-q', '-U', 'yt-dlp']; "
                 "from pip._internal.cli.main import main; sys.exit(main())"],
                creationflags=utils.NO_WINDOW)
            self._emit({"type": "ytdlp_updated", "ok": code == 0,
                        "version": self._ytdlp_version()})
        return self._spawn("update_ytdlp", job)

    # ------------------------------------------------------- telechargeur

    def analyze_url(self, url):
        try:
            return {"ok": True, "info": downloader.analyze(url)}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)[:300]}

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
                return {"type": "dl_done", "ok": True,
                        "title": res["title"], "dest": dest}
            except utils.CancelledError:
                return {"type": "dl_done", "ok": False, "cancelled": True}
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                if "CancelledError" in msg:
                    return {"type": "dl_done", "ok": False,
                            "cancelled": True}
                return {"type": "dl_done", "ok": False, "error": msg[:300]}
        return self._spawn("download", job)

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
                                "ok": False, "error": str(e)[:300]})
            self._emit({"type": "up_done", "ok": ok, "total": len(files)})
        return self._spawn("upscale", job)

    # ---------------------------------------------------------- detourage

    def start_cutout(self, opts):
        files, model = opts["files"], opts["model"]

        def job():
            ok = 0
            for i, src in enumerate(files):
                try:
                    out = cutout.cutout_one(
                        src, model,
                        lambda phase, i=i: self._emit(
                            {"type": "bg_progress", "index": i,
                             "phase": phase}),
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
                                "ok": False, "error": str(e)[:300]})
            self._emit({"type": "bg_done", "ok": ok, "total": len(files)})
        return self._spawn("cutout", job)

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
                                "ok": False, "error": str(e)[:300]})
            self._emit({"type": "cp_done", "ok": ok, "total": len(files)})
        return self._spawn("compress", job)

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
            outs = []
            for i, src in enumerate(files):
                self._emit({"type": "cv_progress", "index": i, "pct": 0})
                try:
                    out = converter.convert_one(
                        src, target,
                        lambda p, i=i: self._emit(
                            {"type": "cv_progress", "index": i, "pct": p}),
                        lambda: self._cancelled("convert"))
                    ok += 1
                    outs.append(out)
                    self._emit({"type": "cv_file_done", "index": i,
                                "ok": True, "out": out})
                except utils.CancelledError:
                    self._emit({"type": "cv_done", "ok": ok,
                                "total": len(files), "cancelled": True})
                    return
                except Exception as e:  # noqa: BLE001
                    self._emit({"type": "cv_file_done", "index": i,
                                "ok": False, "error": str(e)[:300]})
            self._emit({"type": "cv_done", "ok": ok, "total": len(files)})
        return self._spawn("convert", job)
