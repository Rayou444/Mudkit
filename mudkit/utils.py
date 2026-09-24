"""Outils communs : chemins, config, telechargement des binaires embarques."""
import json
import os
import subprocess
import sys
import tempfile
import threading
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN_DIR = os.path.join(ROOT, "bin")
CONFIG_PATH = os.path.join(ROOT, "config.json")

# Donnees par utilisateur (journal, historique) : hors du dossier
# d'installation, que les mises a jour reecrivent. Le panneau Premiere
# range deja son cache dans lib-cache\ ici.
DATA_DIR = os.path.join(
    os.environ.get("LOCALAPPDATA")
    or os.path.join(os.path.expanduser("~"), "AppData", "Local"), "Mudkit")
LOG_DIR = os.path.join(DATA_DIR, "logs")

DEFAULT_DOWNLOAD_DIR = os.path.join(os.path.expanduser("~"), "Videos", "Mudkit")

# Miroir GitHub d'abord (plus fiable sur ce reseau), gyan.dev en secours
FFMPEG_URLS = [
    "https://github.com/GyanD/codexffmpeg/releases/download/"
    "9.0.1/ffmpeg-9.0.1-essentials_build.zip",
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
]
REALESRGAN_URL = (
    "https://github.com/xinntao/Real-ESRGAN/releases/download/"
    "v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip"
)

# Modeles d'upscale du projet Upscayl (github.com/upscayl/upscayl),
# compatibles realesrgan-ncnn-vulkan.
UPSCAYL_MODELS_BASE = ("https://raw.githubusercontent.com/upscayl/upscayl/"
                       "main/resources/models/")
UPSCAYL_MODEL_FILES = [
    "upscayl-standard-4x.param", "upscayl-standard-4x.bin",
    "upscayl-lite-4x.param", "upscayl-lite-4x.bin",
    "ultrasharp-4x.param", "ultrasharp-4x.bin",
    "remacri-4x.param", "remacri-4x.bin",
    "digital-art-4x.param", "digital-art-4x.bin",
]

# Evite qu'une console clignote quand on lance ffmpeg & co depuis pythonw
NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


class CancelledError(Exception):
    """Tache annulee par l'utilisateur."""


def pil_image():
    """Retourne PIL.Image sans la limite anti-bombe de decompression.

    Les fichiers sont choisis localement par l'utilisateur, et un simple
    upscale x4 d'une photo 12 Mpx depasse deja la limite par defaut.
    """
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
    return Image


# ---------------------------------------------------------------- chemins

def ffmpeg_path():
    return os.path.join(BIN_DIR, "ffmpeg.exe")


def ffprobe_path():
    return os.path.join(BIN_DIR, "ffprobe.exe")


def realesrgan_dir():
    return os.path.join(BIN_DIR, "realesrgan")


def realesrgan_path():
    return os.path.join(realesrgan_dir(), "realesrgan-ncnn-vulkan.exe")


def has_ffmpeg():
    return os.path.isfile(ffmpeg_path())


def nvenc_available():
    """Vrai si le GPU encode le H.264 (NVENC). Teste une fois, puis cache."""
    cfg = load_config()
    if "nvenc" in cfg:
        return cfg["nvenc"]
    ok = False
    if has_ffmpeg():
        r = run_hidden([ffmpeg_path(), "-v", "error", "-f", "lavfi", "-i",
                        "color=black:s=256x256:d=0.3", "-c:v", "h264_nvenc",
                        "-f", "null", "-"])
        ok = r.returncode == 0
    update_config(nvenc=ok)
    return ok


def ensure_ffmpeg_on_path():
    """Expose bin/ dans le PATH du processus : certains controles de
    yt-dlp (telechargement partiel) ignorent ffmpeg_location."""
    if has_ffmpeg() and BIN_DIR not in os.environ.get("PATH", ""):
        os.environ["PATH"] = BIN_DIR + os.pathsep + os.environ.get("PATH", "")


def has_realesrgan():
    return os.path.isfile(realesrgan_path())


# ---------------------------------------------------------------- config

_config_lock = threading.Lock()


def load_config():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_config(cfg):
    """Ecriture atomique : plusieurs threads (geometrie, preferences, test
    NVENC) ecrivent ce fichier, un json a moitie ecrit serait perdu."""
    with _config_lock:
        write_json(CONFIG_PATH, cfg)


def update_config(**values):
    """Lire-modifier-ecrire sous verrou : deux threads qui changent chacun
    une cle ne s'ecrasent plus mutuellement."""
    with _config_lock:
        cfg = load_config()
        cfg.update(values)
        write_json(CONFIG_PATH, cfg)


def write_json(path, data):
    """Ecrit via un fichier temporaire puis os.replace (jamais a moitie)."""
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
    except OSError:
        pass


def unique_path(path):
    """`path` s'il est libre, sinon `nom (2).ext`, `nom (3).ext`..."""
    if not os.path.exists(path):
        return path
    base, ext = os.path.splitext(path)
    n = 2
    while os.path.exists(f"{base} ({n}){ext}"):
        n += 1
    return f"{base} ({n}){ext}"


# ---------------------------------------------------------------- helpers

def human_size(n):
    for unit in ("o", "Ko", "Mo", "Go"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} To"


def run_hidden(cmd, **kwargs):
    """subprocess.run sans fenetre console."""
    return subprocess.run(
        cmd, creationflags=NO_WINDOW, capture_output=True, text=True,
        encoding="utf-8", errors="replace", **kwargs
    )


def _download(url, dest, progress=None):
    """Telecharge url vers dest, progress(fait, total) optionnel."""
    req = urllib.request.Request(url, headers={"User-Agent": "Mudkit/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp, open(dest, "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            out.write(chunk)
            done += len(chunk)
            if progress:
                progress(done, total)


def install_ffmpeg(progress=None):
    """Telecharge ffmpeg portable (gyan.dev) et place ffmpeg/ffprobe dans bin/."""
    os.makedirs(BIN_DIR, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        zip_path = os.path.join(tmp, "ffmpeg.zip")
        last_err = None
        for url in FFMPEG_URLS:
            try:
                _download(url, zip_path, progress)
                last_err = None
                break
            except Exception as e:  # noqa: BLE001 - on tente le miroir suivant
                last_err = e
        if last_err is not None:
            raise last_err
        with zipfile.ZipFile(zip_path) as zf:
            for member in zf.namelist():
                base = os.path.basename(member)
                if base in ("ffmpeg.exe", "ffprobe.exe"):
                    with zf.open(member) as src, \
                            open(os.path.join(BIN_DIR, base), "wb") as dst:
                        dst.write(src.read())
    if not has_ffmpeg():
        raise RuntimeError("ffmpeg.exe introuvable dans l'archive")


def realesrgan_models_dir():
    return os.path.join(realesrgan_dir(), "models")


def has_upscayl_models():
    d = realesrgan_models_dir()
    return all(os.path.isfile(os.path.join(d, f))
               for f in UPSCAYL_MODEL_FILES)


def install_upscayl_models(progress=None):
    """Telecharge les modeles Upscayl dans le dossier models de Real-ESRGAN.

    progress(fait, total) est exprime en nombre de fichiers (fractionnaire).
    """
    d = realesrgan_models_dir()
    os.makedirs(d, exist_ok=True)
    n = len(UPSCAYL_MODEL_FILES)
    for i, name in enumerate(UPSCAYL_MODEL_FILES):
        dest = os.path.join(d, name)
        if os.path.isfile(dest) and os.path.getsize(dest) > 0:
            if progress:
                progress(i + 1, n)
            continue

        def sub(done, total, i=i):
            if progress and total:
                progress(i + done / total, n)
        _download(UPSCAYL_MODELS_BASE + name, dest + ".part", sub)
        os.replace(dest + ".part", dest)
        if progress:
            progress(i + 1, n)


def install_realesrgan(progress=None):
    """Telecharge Real-ESRGAN (ncnn/vulkan) dans bin/realesrgan/."""
    os.makedirs(realesrgan_dir(), exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        zip_path = os.path.join(tmp, "realesrgan.zip")
        _download(REALESRGAN_URL, zip_path, progress)
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(realesrgan_dir())
    if not has_realesrgan():
        raise RuntimeError("realesrgan-ncnn-vulkan.exe introuvable dans l'archive")
