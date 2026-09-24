"""Mise a jour automatique depuis les releases GitHub (depot public).

Chaque release publie :
  - Mudkit-vX.Y.Z.zip         installation complete (Python embarque, bin/)
  - Mudkit-update-vX.Y.Z.zip  le code seul (~1 Mo) + le panneau Premiere,
                              applique en place par l'appli.
Le zip de mise a jour contient update.json : version + numero de "runtime"
(le jeu de dependances du Python embarque, cf. packaging/runtime.txt). Si
la release demande un runtime plus recent que celui installe, le code seul
ne suffit pas : on renvoie vers l'installateur complet.

Jamais actif sur le PC de dev (depot git / .venv) : tout passe par git.
"""
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

from . import __version__, utils

REPO = "Rayou444/Mudkit"
API_LATEST = f"https://api.github.com/repos/{REPO}/releases/latest"
RELEASES_PAGE = f"https://github.com/{REPO}/releases/latest"
EXT_DIR = os.path.join(os.environ.get("APPDATA", ""), "Adobe", "CEP",
                       "extensions", "com.mudkit.premiere")

log = logging.getLogger("mudkit.update")


class NeedFullInstall(Exception):
    """La release change les dependances Python : installateur complet."""


def runtime():
    """Numero du runtime Python embarque, None hors installation."""
    try:
        with open(os.path.join(sys.prefix, "mudkit-runtime.txt"),
                  encoding="utf-8") as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None


def is_dev():
    return (os.path.isdir(os.path.join(utils.ROOT, ".git"))
            or runtime() is None)


def _ver(s):
    nums = [int(n) for n in re.findall(r"\d+", s or "")][:3]
    return tuple(nums + [0] * (3 - len(nums)))


def check():
    """Interroge la derniere release. Leve une exception si hors ligne."""
    req = urllib.request.Request(API_LATEST, headers={
        "User-Agent": f"Mudkit/{__version__}",
        "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.load(r)
    latest = (data.get("tag_name") or "").lstrip("vV")
    asset = next((a for a in data.get("assets") or []
                  if a.get("name", "").startswith("Mudkit-update-")
                  and a["name"].endswith(".zip")), None)
    return {
        "current": __version__,
        "latest": latest,
        "available": _ver(latest) > _ver(__version__),
        "full_only": asset is None,
        "notes": (data.get("body") or "")[:3000],
        "page": data.get("html_url") or RELEASES_PAGE,
        "asset": asset and {"url": asset["browser_download_url"],
                            "size": asset.get("size"),
                            "digest": asset.get("digest")},
    }


def download(asset, progress=None):
    """Telecharge le zip de mise a jour et verifie son empreinte SHA-256
    (fournie par GitHub). Renvoie le chemin du fichier temporaire."""
    fd, path = tempfile.mkstemp(prefix="mudkit-update-", suffix=".zip")
    os.close(fd)
    utils._download(asset["url"], path, progress)  # noqa: SLF001
    digest = asset.get("digest") or ""
    if digest.startswith("sha256:"):
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        if h.hexdigest() != digest.split(":", 1)[1]:
            os.remove(path)
            raise RuntimeError("fichier de mise à jour corrompu, réessaie")
    return path


def apply(zip_path):
    """Remplace le code de Mudkit (et le panneau Premiere) par celui du zip.

    Les .py et l'interface peuvent etre ecrases pendant que l'appli tourne
    (Windows ne les verrouille pas) ; python\\, bin\\, config.json et
    cookies.txt ne sont pas touches. Renvoie la nouvelle version.
    """
    if is_dev():
        raise RuntimeError("pas de mise à jour automatique sur le PC de dev")
    with tempfile.TemporaryDirectory() as tmp:
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(tmp)
        with open(os.path.join(tmp, "update.json"), encoding="utf-8") as f:
            meta = json.load(f)
        if int(meta.get("runtime", 0)) > (runtime() or 0):
            raise NeedFullInstall(meta.get("version"))

        shutil.copytree(os.path.join(tmp, "app"), utils.ROOT,
                        dirs_exist_ok=True)
        ext = os.path.join(tmp, "com.mudkit.premiere")
        if os.path.isdir(ext):
            # remplacement complet (la signature couvre la liste des
            # fichiers) ; si Premiere en verrouille un, on ecrase par-dessus
            shutil.rmtree(EXT_DIR, ignore_errors=True)
            shutil.copytree(ext, EXT_DIR, dirs_exist_ok=True)
    log.info("mise a jour appliquee : %s -> %s", __version__,
             meta.get("version"))
    return meta.get("version")


def premiere_running():
    r = utils.run_hidden(["tasklist", "/FI",
                          "IMAGENAME eq Adobe Premiere Pro.exe", "/NH"])
    return "adobe premiere pro.exe" in (r.stdout or "").lower()


def restart():
    """Relance Mudkit avec les memes options de Python (-E / -s)."""
    args = [sys.executable]
    if sys.flags.ignore_environment:
        args.append("-E")
    if sys.flags.no_user_site:
        args.append("-s")
    args.append(os.path.join(utils.ROOT, "main.py"))
    DETACHED = 0x00000008 | 0x00000200  # DETACHED_PROCESS | NEW_PROCESS_GROUP
    subprocess.Popen(args, cwd=utils.ROOT, creationflags=DETACHED,
                     close_fds=True)
