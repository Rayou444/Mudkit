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

Une seule mise a jour pour les deux outils : le meme zip remplace le code de
l'appli ET le panneau Premiere, qu'elle soit lancee depuis l'appli (bouton
« Mettre a jour ») ou depuis le panneau (python -m mudkit.updater apply,
voir main() en bas).
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
import time
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


def installed_version():
    """Version du code PRESENT SUR LE DISQUE, qui peut etre plus recente que
    celle qui tourne : le panneau Premiere a pu appliquer une mise a jour
    pendant que l'appli etait ouverte (ou l'inverse)."""
    try:
        with open(os.path.join(utils.ROOT, "mudkit", "__init__.py"),
                  encoding="utf-8") as f:
            m = re.search(r'__version__\s*=\s*"([^"]+)"', f.read())
        return m.group(1) if m else __version__
    except OSError:
        return __version__


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
    installed = installed_version()
    return {
        "current": __version__,
        "installed": installed,
        # deja installee sur le disque, il ne manque qu'un redemarrage
        "pending_restart": _ver(installed) > _ver(__version__),
        "latest": latest,
        "available": _ver(latest) > _ver(installed),
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
        _install(tmp)
    log.info("mise a jour appliquee : %s -> %s", __version__,
             meta.get("version"))
    return meta.get("version")


# ---------------------------------------------- copie avec retour arriere
#
# Avant, les fichiers etaient ecrases un par un sans filet : un antivirus qui
# bloque un .py, un disque plein ou un PC qui s'eteint en pleine copie
# laissait une appli moitie ancienne moitie nouvelle, qui ne demarrait plus
# (et ne pouvait donc plus se mettre a jour). Maintenant :
#   - chaque fichier remplace est d'abord sauvegarde dans BACKUP_DIR ;
#   - chaque ecriture passe par un fichier temporaire renomme (os.replace) :
#     un fichier est toujours entier, ancien ou nouveau ;
#   - un manifeste note ce qui est en cours ; erreur -> recover() tout de
#     suite ; coupure de courant -> recover() au demarrage suivant (main.py).

BACKUP_DIR = os.path.join(utils.DATA_DIR, "update-backup")


def _manifest_path():
    return os.path.join(BACKUP_DIR, "en-cours.json")


def _save_manifest(m):
    # pas utils.write_json, qui avale les erreurs : ici, ne pas pouvoir noter
    # ce qu'on va faire doit arreter la mise a jour avant qu'elle commence
    tmp = _manifest_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(m, f)
    os.replace(tmp, _manifest_path())


def _copy_atomic(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".mkupd"
    shutil.copy2(src, tmp)
    os.replace(tmp, dst)


def _install(tmp):
    shutil.rmtree(BACKUP_DIR, ignore_errors=True)
    os.makedirs(BACKUP_DIR)
    m = {"ext": False, "added": []}
    _save_manifest(m)
    try:
        # Le panneau d'abord : c'est la copie qui peut echouer (fichier
        # verrouille par Premiere) ; on s'arrete alors avant de toucher a
        # l'appli, et le panneau d'avant est remis.
        ext = os.path.join(tmp, "com.mudkit.premiere")
        if os.path.isdir(ext):
            if os.path.isdir(EXT_DIR):
                shutil.copytree(EXT_DIR, os.path.join(BACKUP_DIR, "ext"))
                m["ext"] = True
                _save_manifest(m)
            # remplacement complet (la signature couvre la liste des
            # fichiers) ; si Premiere en verrouille un, on ecrase par-dessus
            shutil.rmtree(EXT_DIR, ignore_errors=True)
            try:
                shutil.copytree(ext, EXT_DIR, dirs_exist_ok=True)
            except (shutil.Error, OSError) as e:
                raise RuntimeError(
                    "le panneau Premiere n'a pas pu être remplacé (fichier "
                    "verrouillé) : ferme Premiere Pro puis relance la mise "
                    "à jour") from e

        app = os.path.join(tmp, "app")
        files = [os.path.relpath(os.path.join(d, n), app)
                 for d, _, names in os.walk(app) for n in names]
        # main.py en dernier : c'est lui qui relance recover() au demarrage,
        # il doit rester celui d'avant tant que la copie n'est pas finie
        files.sort(key=lambda rel: rel == "main.py")
        for rel in files:
            dst = os.path.join(utils.ROOT, rel)
            if os.path.exists(dst):
                _copy_atomic(dst, os.path.join(BACKUP_DIR, "app", rel))
            else:
                m["added"].append(rel)
                _save_manifest(m)  # AVANT d'ecrire : recover() saura l'effacer
            _copy_atomic(os.path.join(app, rel), dst)
    except BaseException as e:
        log.error("mise a jour interrompue, retour a la version d'avant : %s",
                  e, exc_info=e)
        try:
            recover()
        except Exception as e2:  # noqa: BLE001 - garder l'erreur d'origine
            log.error("retour arriere impossible : %s", e2, exc_info=e2)
        raise
    shutil.rmtree(BACKUP_DIR, ignore_errors=True)


def recover():
    """Remet la version d'avant si une mise a jour n'est pas allee au bout.

    Sans effet (et quasi gratuit) s'il n'y a rien en cours. Renvoie True si
    quelque chose a ete restaure : l'appelant doit alors redemarrer, les
    modules deja charges pouvant venir de la version abandonnee.
    """
    if not os.path.isdir(BACKUP_DIR) or is_dev():
        return False
    try:
        with open(_manifest_path(), encoding="utf-8") as f:
            m = json.load(f)
    except (OSError, ValueError):
        # pas de manifeste = coupure avant la moindre modification
        shutil.rmtree(BACKUP_DIR, ignore_errors=True)
        return False
    bk = os.path.join(BACKUP_DIR, "app")
    touched = list(m.get("added", []))
    for d, _, names in os.walk(bk):
        for n in names:
            if n.endswith(".mkupd"):  # sauvegarde coupee : original intact
                continue
            src = os.path.join(d, n)
            rel = os.path.relpath(src, bk)
            _copy_atomic(src, os.path.join(utils.ROOT, rel))
            touched.append(rel)
    for rel in m.get("added", []):
        try:
            os.remove(os.path.join(utils.ROOT, rel))
        except OSError:
            pass
    for rel in touched:  # temporaires d'une ecriture coupee
        try:
            os.remove(os.path.join(utils.ROOT, rel) + ".mkupd")
        except OSError:
            pass
    if m.get("ext") and os.path.isdir(os.path.join(BACKUP_DIR, "ext")):
        shutil.rmtree(EXT_DIR, ignore_errors=True)
        shutil.copytree(os.path.join(BACKUP_DIR, "ext"), EXT_DIR,
                        dirs_exist_ok=True)
    shutil.rmtree(BACKUP_DIR, ignore_errors=True)
    log.warning("mise a jour inachevee : version precedente restauree")
    return True


# ------------------------------------------------------------- yt-dlp
#
# YouTube & co changent souvent leur site : un yt-dlp de plus de quelques
# semaines est la premiere cause de « ca ne telecharge plus ». On le met donc
# a jour tout seul, au plus une fois par jour, quand rien ne tourne (appli
# au demarrage, ou panneau Premiere via `python -m mudkit.updater ytdlp`).

YTDLP_STAMP = os.path.join(utils.DATA_DIR, "ytdlp-update.json")
YTDLP_EVERY = 24 * 3600


def _console_python():
    # pip sous pythonw.exe (pas de console) ecrit dans le vide : python.exe
    exe = sys.executable
    alt = os.path.join(os.path.dirname(exe), "python.exe")
    return alt if os.path.basename(exe).lower() == "pythonw.exe" and os.path.isfile(alt) else exe


def ytdlp_update(force=False):
    """pip install -U yt-dlp. Sans `force` : jamais sur le PC de dev (le
    .venv reste celui qu'on a choisi), et au plus une fois par 24 h.
    Renvoie None si rien n'a ete tente, sinon True / False."""
    if not force:
        if is_dev():
            return None
        try:
            with open(YTDLP_STAMP, encoding="utf-8") as f:
                if time.time() - float(json.load(f)["ts"]) < YTDLP_EVERY:
                    return None
        except (OSError, ValueError, KeyError, TypeError):
            pass
    # note AVANT d'essayer : hors ligne, on ne relance pas pip a chaque
    # ouverture du panneau
    utils.write_json(YTDLP_STAMP, {"ts": time.time()})
    # ROOT passe en argument, pas colle dans le code : un profil Windows
    # avec apostrophe (C:\Users\D'Angelo) cassait la commande
    code = ("import sys; sys.path.insert(0, sys.argv[1]); "
            "from mudkit import dnsfix; dnsfix.activate_if_needed(); "
            "sys.argv = ['pip', 'install', '-q', '--disable-pip-version-check', "
            "'-U', 'yt-dlp']; "
            "from pip._internal.cli.main import main; sys.exit(main())")
    try:
        r = utils.run_hidden([_console_python(), "-E", "-s", "-c", code,
                              utils.ROOT], timeout=600)
    except Exception as e:  # noqa: BLE001 - delai depasse, python absent
        log.error("mise a jour yt-dlp : %s", e)
        return False
    if r.returncode != 0:
        log.error("mise a jour yt-dlp : code %s\n%s", r.returncode,
                  (r.stderr or r.stdout or "")[-2000:])
    return r.returncode == 0


def ytdlp_version():
    """Version de yt-dlp lue sur le disque (pas celle deja importee)."""
    try:
        from importlib import metadata
        return metadata.version("yt-dlp")
    except Exception:  # noqa: BLE001
        return None


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


# ------------------------------------------------- commande pour le panneau

def _emit(obj):
    # ensure_ascii : stdout d'un Python lance par le panneau est en cp1252,
    # le panneau lit de l'UTF-8 ; en ASCII pur les accents survivent.
    print(json.dumps(obj), flush=True)


def main(argv=None):
    """Mise a jour en un clic depuis le panneau Premiere.

      python -E -s -m mudkit.updater check   une ligne JSON : l'etat
      python -E -s -m mudkit.updater apply   {"pct": ..}* puis une ligne
                                             finale : done / full_only / error
      python -E -s -m mudkit.updater ytdlp   met yt-dlp a jour (1 fois / jour)

    (lance avec le dossier Mudkit comme repertoire courant). Toujours une
    ligne JSON finale sur stdout, jamais une trace Python.
    """
    from . import dnsfix
    dnsfix.activate_if_needed()  # meme resolveur de secours que l'appli
    recover()  # une mise a jour precedente coupee en pleine copie
    args = sys.argv[1:] if argv is None else argv
    cmd = args[0] if args else "check"
    if cmd == "ytdlp":  # au plus une fois par jour, cf. ytdlp_update()
        r = ytdlp_update()
        _emit({"ytdlp": "skipped" if r is None else "updated" if r else "failed",
               "version": ytdlp_version()})
        return 0
    if is_dev():
        _emit({"dev": True, "current": installed_version()})
        return 0
    try:
        info = check()
    except Exception as e:  # noqa: BLE001 - hors ligne, GitHub indispo
        _emit({"error": f"vérification impossible : {e}"[:300]})
        return 1
    if cmd == "check":
        _emit(info)
        return 0
    if cmd != "apply":
        _emit({"error": f"commande inconnue : {cmd}"})
        return 2
    if not info["available"]:
        _emit({"done": True, "version": info["installed"], "uptodate": True})
        return 0
    if info["full_only"]:
        _emit({"full_only": True, "page": info["page"]})
        return 0

    last = [0.0]

    def progress(done, total):
        now = time.monotonic()
        if total and (now - last[0] >= 0.25 or done >= total):
            last[0] = now
            _emit({"pct": done / total})

    path = None
    try:
        path = download(info["asset"], progress)
        _emit({"done": True, "version": apply(path)})
        return 0
    except NeedFullInstall:
        _emit({"full_only": True, "page": info["page"]})
        return 0
    except Exception as e:  # noqa: BLE001
        log.error("mise a jour depuis le panneau : %s", e, exc_info=e)
        _emit({"error": str(e)[:300]})
        return 1
    finally:
        if path and os.path.exists(path):
            os.remove(path)


if __name__ == "__main__":
    sys.exit(main())
