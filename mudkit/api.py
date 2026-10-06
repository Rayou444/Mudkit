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
        self._busy_lock = threading.Lock()
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
        # verrou : deux clics tres rapprochés (deux fils pywebview) ne
        # lancent plus deux fois la meme tache
        with self._busy_lock:
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
            "ui": cfg.get("ui") or {},  # derniers reglages de chaque outil
            "cookies_browser": downloader.cookies_browser(),
            "cookies_file": os.path.isfile(downloader.COOKIES_FILE),
        }

    def set_pref(self, key, value):
        """Memorise une preference d'interface (theme, dernier outil...)."""
        if key not in ("theme", "page", "cookies_browser", "ui"):
            return False
        if key == "ui" and not isinstance(value, dict):
            return False
        utils.update_config(**{key: value})
        return True

    @staticmethod
    def _ytdlp_version():
        # lu sur le disque : juste apres une mise a jour, le module deja
        # importe en memoire donnerait encore l'ancienne version
        return updater.ytdlp_version()

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

    # Jamais d'executable ou de script, meme si on le demande : la page ne
    # doit pas pouvoir lancer un programme (defense en profondeur, en plus
    # de l'echappement des textes cote interface).
    _RISKY_EXTS = {".exe", ".bat", ".cmd", ".com", ".ps1", ".psm1", ".vbs",
                   ".vbe", ".js", ".jse", ".wsf", ".wsh", ".msi", ".msp",
                   ".scr", ".hta", ".lnk", ".url", ".cpl", ".jar", ".reg",
                   ".pif", ".appref-ms", ".py", ".pyw"}

    def _safe_target(self, path):
        if not isinstance(path, str) or not os.path.exists(path):
            return False
        if os.path.isdir(path):
            return True
        return os.path.splitext(path)[1].lower() not in self._RISKY_EXTS

    def open_path(self, path):
        if self._safe_target(path):
            os.startfile(path)  # noqa: S606 - action demandee par l'utilisateur
            return True
        return False

    def open_url(self, url):
        if isinstance(url, str) and url.startswith("https://"):
            os.startfile(url)  # noqa: S606 - navigateur par defaut
            return True
        return False

    def reveal_file(self, path):
        if isinstance(path, str) and os.path.exists(path):
            # une seule chaine, chemin entre guillemets : sinon une virgule
            # dans le nom coupait l'argument /select et ouvrait autre chose
            subprocess.Popen(f'explorer /select,"{path}"',
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
            cat = converter.category(p)
            out.append({"path": p, "name": os.path.basename(p),
                        "size": size, "category": cat,
                        "dims": self._dims(p) if cat == "image" else None})
        return out

    @staticmethod
    def _dims(path):
        """« 1920×1080 » lu dans l'en-tete de l'image (rapide, sans tout
        decoder) : l'Upscaler et le Detourage l'affichent, et « x4 » en
        deduit la taille finale."""
        try:
            Image = utils.pil_image()
            with Image.open(path) as im:
                w, h = im.size
            return f"{w}×{h}"
        except Exception:  # noqa: BLE001 - format illisible : pas de taille
            return None

    def shutdown(self):
        """Fenetre fermee : on annule tout ce qui tourne et on arrete les
        ffmpeg / Real-ESRGAN lances par Mudkit, qui continuaient sinon en
        arriere-plan apres la fermeture."""
        for task in list(self._busy):
            self._cancel[task] = True
        worker = getattr(self, "_cutout_proc", None)
        if worker is not None and worker.poll() is None:
            utils.kill_tree(worker.pid)   # processus de detourage (Python)
        try:
            n = utils.kill_tool_children()
            if n:
                log.info("fermeture : %d outil(s) arrete(s)", n)
        except Exception as e:  # noqa: BLE001 - jamais bloquant
            log.warning("fermeture : %s", e)

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
        """Un seul clic : telecharge, installe (appli + panneau Premiere)
        puis redemarre Mudkit tout seul. Le redemarrage attend la fin des
        taches en cours : une mise a jour ne coupe jamais un telechargement."""
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
            except updater.NeedFullInstall:
                return {"type": "upd_done", "ok": False, "full_only": True,
                        "page": info["page"]}
            except Exception as e:  # noqa: BLE001
                return {"type": "upd_done", "ok": False,
                        "error": self._err(e, "mise a jour")}
            finally:
                if path and os.path.exists(path):
                    os.remove(path)
            self._restart_when_idle(version)
            return None
        return self._spawn("update", job,
                           crash={"type": "upd_done", "ok": False})

    def _restart_when_idle(self, version):
        others = lambda: self._busy - {"update"}  # noqa: E731
        if others():
            self._emit({"type": "upd_waiting", "version": version})
            while others():
                time.sleep(1)
        self._emit({"type": "upd_done", "ok": True, "version": version})
        time.sleep(1.5)  # le temps de lire « redemarrage... »
        self.update_restart()

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
        """Bouton des Parametres : mise a jour immediate."""
        def job():
            ok = updater.ytdlp_update(force=True)
            return {"type": "ytdlp_updated", "ok": ok,
                    "version": self._ytdlp_version()}
        return self._spawn("update_ytdlp", job,
                           crash={"type": "ytdlp_updated", "ok": False})

    def ytdlp_auto(self):
        """Mise a jour silencieuse, au plus une fois par jour : appelee par
        l'interface peu apres le demarrage. Rien n'est affiche si rien n'a
        change ; un echec (hors ligne) est seulement journalise."""
        if self._busy:
            return False  # jamais pendant un telechargement en cours
        def job():
            ok = updater.ytdlp_update()
            if ok:
                return {"type": "ytdlp_updated", "ok": True, "auto": True,
                        "version": self._ytdlp_version()}
            return None
        return self._spawn("update_ytdlp", job)

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
            # pip est en train de remplacer yt-dlp : on attend qu'il ait fini
            # plutot que de charger un melange des deux versions
            while "update_ytdlp" in self._busy:
                time.sleep(0.5)
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
                        "title": res["title"], "dest": res["dest"],
                        "total": res["total"], "failed": res["failed"],
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
        # Un passage (ou une fusion) est fait par un ffmpeg que lance yt-dlp
        # et qui ne regarde pas l'annulation : on l'arrete. Sauf si un autre
        # outil de Mudkit tourne aussi (on ne saurait pas lequel est lequel).
        if task == "download" and not (self._busy & {"convert", "compress", "upscale"}):
            try:
                utils.kill_tool_children()
            except Exception:  # noqa: BLE001
                pass
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
        """Detourage dans un processus a part (cutout_worker) : annuler le
        tue aussitot (avant, il fallait attendre la fin de l'image), la
        memoire du modele (~1 Go) est rendue a la fin, et un souci de pilote
        graphique ne fait pas tomber l'appli."""
        files, model = opts["files"], cutout.key_of(opts.get("model"))
        gpu = bool(opts.get("gpu")) and model not in cutout.NO_GPU
        utils.update_config(cutout_gpu=bool(opts.get("gpu")))
        job_json = json.dumps({"files": files, "model": model, "gpu": gpu,
                               "crop": bool(opts.get("crop"))})

        def job():
            ok, seen, err_tail = 0, set(), []
            proc = self._cutout_proc = cutout.spawn_worker(job_json)
            stop = threading.Event()

            def watch():   # annulation : on tue le processus et ses enfants
                while not stop.wait(0.2):
                    if self._cancelled("cutout") and proc.poll() is None:
                        utils.kill_tree(proc.pid)
                        return
            threading.Thread(target=watch, daemon=True).start()

            def drain():   # stderr lu a part : un tampon plein bloquerait
                for line in proc.stderr:
                    err_tail.append(line.decode("utf-8", "replace"))
                    del err_tail[:-30]
            threading.Thread(target=drain, daemon=True).start()
            try:
                for raw in proc.stdout:
                    try:
                        e = json.loads(raw)
                    except ValueError:
                        continue
                    if "note" in e:
                        log.warning("detourage : %s", e["note"])
                    elif "ok" in e:
                        seen.add(e["i"])
                        if e["ok"]:
                            ok += 1
                            log.info("detoure %s en %s s (%s)", files[e["i"]], e.get("secs"),
                                     "carte graphique" if e.get("gpu") else "processeur")
                            self._emit({"type": "bg_file_done", "index": e["i"],
                                        "ok": True, "out": e["out"],
                                        "gpu": e.get("gpu", False)})
                        else:
                            log.error("detourage %s : %s %s", files[e["i"]],
                                      e.get("error"), e.get("detail", ""))
                            self._emit({"type": "bg_file_done", "index": e["i"],
                                        "ok": False, "error": e.get("error")})
                    elif "phase" in e:
                        self._emit({"type": "bg_progress", "index": e["i"],
                                    "phase": e["phase"], "pct": e.get("pct")})
                proc.wait()
            finally:
                stop.set()
            if self._cancelled("cutout"):
                return {"type": "bg_done", "ok": ok, "total": len(files),
                        "cancelled": True}
            if proc.returncode != 0:
                # processus tombe (memoire, pilote) : les images restantes
                # sont marquees en erreur au lieu de rester « en cours »
                why = "".join(err_tail).strip().splitlines()
                log.error("processus de detourage tombe (code %s) : %s",
                          proc.returncode, "".join(err_tail))
                msg = ("le détourage s'est arrêté"
                       + (f" : {why[-1][:200]}" if why else f" (code {proc.returncode})"))
                for i in range(len(files)):
                    if i not in seen:
                        self._emit({"type": "bg_file_done", "index": i,
                                    "ok": False, "error": msg})
            return {"type": "bg_done", "ok": ok, "total": len(files)}
        return self._spawn("cutout", job, crash={
            "type": "bg_done", "ok": 0, "total": len(files)})

    def cutout_setup(self):
        """Etat du detourage pour l'interface : modeles deja telecharges et
        carte graphique utilisable (dernier choix memorise, sinon oui des
        qu'une vraie carte graphique est la)."""
        name = cutout.gpu_name()
        cfg = utils.load_config()
        return {"gpu_name": name,
                "gpu": bool(cfg.get("cutout_gpu", bool(name))) and bool(name),
                "gpu_ready": cutout.gpu_runtime_ready(),
                "cached": {k: cutout.model_cached(k) for k in cutout.MODELS}}

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
