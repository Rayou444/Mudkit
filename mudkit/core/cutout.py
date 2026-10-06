"""Detourage d'images (suppression d'arriere-plan) en local, via onnxruntime.

Meme pretraitement que rembg, sans sa pile de dependances (scipy, numba,
scikit-image... ~290 Mo) : onnxruntime + numpy + Pillow suffisent.

Modeles (licence MIT, telecharges au premier usage a l'emplacement de rembg,
~/.rembg/models/<nom>/<nom>.onnx : ceux deja presents sont reutilises) :
  hair  BiRefNet matting : alpha fin (cheveux, poils, flou, transparences)
  best  BiRefNet general : objets, produits, contours nets
  hd    BiRefNet HR (2048 px) : grandes photos, details fins (4x plus lent)
  fast  IS-Net : leger et rapide

Apres le modele, la couleur des bords est corrigee (estimation du premier
plan par "blur fusion", Forte & Pitie 2021, comme le refine_foreground de
BiRefNet) : une meche de cheveux ne garde plus la teinte de l'ancien fond.

L'inference tourne dans un processus a part (cutout_worker) : annulation
immediate, memoire rendue a la fin, et un plantage de la carte graphique
n'emporte pas l'appli. Carte graphique via DirectML (onnxruntime-directml,
~25 Mo telecharges a la premiere utilisation), sinon processeur.
"""
import hashlib
import os
import re
import shutil
import subprocess
import zipfile

from .. import utils

_REMBG = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/"
_BIREF = "https://github.com/ZhengPeng7/BiRefNet/releases/download/v1/"
_IMAGENET = ((0.485, 0.456, 0.406), (0.229, 0.224, 0.225))

# cle -> nom, url, md5, cote d'entree, (moyenne, ecart-type), sigmoide ?
MODELS = {
    "hair": ("birefnet-matting", _BIREF + "BiRefNet-matting-epoch_100.onnx",
             "95d7129b7abd6120b571e848f269a8ab", 1024, _IMAGENET, True),
    "best": ("birefnet-general", _REMBG + "BiRefNet-general-epoch_244.onnx",
             "7a35a0141cbbc80de11d9c9a28f52697", 1024, _IMAGENET, True),
    "hd": ("birefnet-hr-general", _BIREF + "BiRefNet_HR-general-epoch_130.onnx",
           "2d3a1fbeb5c89fbb7c6c39af1e96eed3", 2048, _IMAGENET, True),
    "fast": ("isnet-general-use", _REMBG + "isnet-general-use.onnx",
             "fc16ebd8b0c10d971d3513d564d01e29",
             1024, ((0.5, 0.5, 0.5), (1.0, 1.0, 1.0)), False),
}
# modeles trop gros pour DirectML (le HD en 2048 px echoue meme avec 16 Go)
NO_GPU = {"hd"}
# anciennes cles (reglages memorises avant 2.12)
ALIASES = {"portrait": "hair"}
DEFAULT = "hair"


def key_of(key):
    key = ALIASES.get(key, key)
    return key if key in MODELS else DEFAULT


def _candidates(key):
    name = MODELS[key_of(key)][0]
    home = os.path.expanduser("~")
    return [os.path.join(home, ".rembg", "models", name, name + ".onnx"),
            os.path.join(home, ".u2net", name + ".onnx")]  # ancien rembg


def model_path(key):
    """Chemin du modele s'il est deja telecharge, sinon None."""
    return next((p for p in _candidates(key) if os.path.isfile(p)), None)


def model_cached(key):
    return model_path(key) is not None


def _md5(path):
    h = hashlib.md5()  # noqa: S324 - controle d'integrite, pas de securite
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download_model(key, progress=None):
    """Telecharge le modele (progress(fait, total) en octets), md5 verifie."""
    _, url, md5, _, _, _ = MODELS[key_of(key)]
    dest = _candidates(key)[0]
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    part = dest + ".part"
    utils._download(url, part, progress)  # noqa: SLF001
    if _md5(part) != md5:
        os.remove(part)
        raise RuntimeError("modèle téléchargé corrompu, réessaie")
    os.replace(part, dest)
    return dest


# ------------------------------------------------------------ carte graphique

DML_VERSION = "1.24.4"
DML_URL = ("https://files.pythonhosted.org/packages/88/ea/"
           "33814eb0ec96775eda4c1d30b0d86e91d7d2cd0d84c66d3915aef0e06fa3/"
           "onnxruntime_directml-1.24.4-cp312-cp312-win_amd64.whl")
DML_SHA256 = "f2ecb68b7b7b259d2ef3112ae760149f9b5a1e7c0fbb73d539da6250a648a614"
DML_DIR = os.path.join(utils.DATA_DIR, "onnxruntime-dml", DML_VERSION)

_VIRTUAL = re.compile(r"virtual|parsec|basic|remote|mirror|displaylink|"
                      r"citrix|vmware|hyper-v|indirect", re.I)
_DISCRETE = re.compile(r"nvidia|geforce|quadro|rtx|radeon|amd|intel\(r\) arc|"
                       r"\barc\b", re.I)
_gpu_cache = []


def gpu_names():
    """Noms des cartes graphiques (WMI), memorises pour la session."""
    if not _gpu_cache:
        try:
            out = utils.run_hidden(
                ["powershell", "-NoProfile", "-Command",
                 "(Get-CimInstance Win32_VideoController).Name"],
                timeout=20).stdout
            _gpu_cache.append([n.strip() for n in out.splitlines() if n.strip()])
        except Exception:  # noqa: BLE001 - pas de WMI : pas de carte connue
            _gpu_cache.append([])
    return _gpu_cache[0]


def gpu_name():
    """La carte qui vaut le coup (NVIDIA / AMD / Intel Arc), sinon None :
    sur une puce graphique integree, le processeur va aussi vite."""
    for n in gpu_names():
        if _DISCRETE.search(n) and not _VIRTUAL.search(n):
            return n
    return None


def gpu_runtime_ready():
    return os.path.isfile(os.path.join(DML_DIR, "onnxruntime", "capi",
                                       "onnxruntime_pybind11_state.pyd"))


def install_gpu_runtime(progress=None):
    """onnxruntime-directml (roue officielle Microsoft sur PyPI), seulement
    son dossier onnxruntime/, dans DATA_DIR. Le runtime Python embarque
    n'est pas touche : le processus de detourage l'importe a la place."""
    if gpu_runtime_ready():
        return DML_DIR
    parent = os.path.dirname(DML_DIR)
    os.makedirs(parent, exist_ok=True)
    whl = os.path.join(parent, "ort-dml.whl.part")
    utils._download(DML_URL, whl, progress)  # noqa: SLF001
    h = hashlib.sha256()
    with open(whl, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest() != DML_SHA256:
        os.remove(whl)
        raise RuntimeError("module carte graphique corrompu, réessaie")
    tmp = DML_DIR + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    with zipfile.ZipFile(whl) as z:
        z.extractall(tmp, [n for n in z.namelist()
                           if n.startswith("onnxruntime/")])
    os.remove(whl)
    shutil.rmtree(DML_DIR, ignore_errors=True)
    os.replace(tmp, DML_DIR)
    return DML_DIR


# ---------------------------------------------------------------- inference

_sessions = {}
_used_gpu = {}
_gpu_failed = set()


def _new_session(key, gpu):
    import onnxruntime as ort
    so = ort.SessionOptions()
    # "etendu" : chargement ~40 % plus court que "tout", inference identique
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
    if (gpu and key not in NO_GPU and key not in _gpu_failed
            and "DmlExecutionProvider" in ort.get_available_providers()):
        so.enable_mem_pattern = False          # exige par DirectML
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        prov = [("DmlExecutionProvider", {"performance_preference": "high_performance",
                                          "device_filter": "gpu"}),
                "CPUExecutionProvider"]
        try:
            return ort.InferenceSession(model_path(key), so, providers=prov), True
        except Exception:  # noqa: BLE001 - pilote, memoire : processeur
            _gpu_failed.add(key)
            so = ort.SessionOptions()
            so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
    return ort.InferenceSession(model_path(key), so, providers=["CPUExecutionProvider"]), False


def _run(key, x, gpu):
    """Inference ; si la carte graphique echoue (memoire pleine : le modele
    HD en 2048 px demande beaucoup), on refait sur le processeur."""
    k = (key, gpu)
    if k not in _sessions:
        _sessions[k], _used_gpu[k] = _new_session(key, gpu)
    sess = _sessions[k]
    try:
        return sess.run(None, {sess.get_inputs()[0].name: x})[0], _used_gpu[k]
    except Exception:
        if not _used_gpu[k]:
            raise
        # une fois rate sur la carte graphique, ce modele reste au processeur
        _sessions.pop(k, None)
        _gpu_failed.add(key)
        return _run(key, x, False)


def release():
    _sessions.clear()
    import gc
    gc.collect()


def predict_alpha(img, key, gpu=False):
    """Alpha du premier plan (float32 0..1, taille de `img`) + carte
    graphique utilisee ou non."""
    import numpy as np
    Image = utils.pil_image()
    key = key_of(key)
    _, _, _, side, (mean, std), sigmoid = MODELS[key]
    im = np.asarray(img.convert("RGB").resize((side, side), Image.Resampling.BILINEAR),
                    dtype=np.float32) / 255.0
    x = ((im - np.array(mean, np.float32)) / np.array(std, np.float32))
    x = x.transpose((2, 0, 1))[None].astype(np.float32)
    out, used_gpu = _run(key, x, gpu)
    pred = out[0, 0].astype(np.float32)
    if sigmoid:
        pred = 1.0 / (1.0 + np.exp(-pred))
    else:  # IS-Net : sortie a renormaliser
        lo, hi = float(pred.min()), float(pred.max())
        pred = (pred - lo) / max(hi - lo, 1e-6)
    a = Image.fromarray(np.clip(pred, 0, 1), "F").resize(img.size, Image.Resampling.LANCZOS)
    a = np.clip(np.asarray(a, dtype=np.float32), 0.0, 1.0)
    # voile quasi invisible -> transparent, quasi plein -> opaque
    a[a < 1.5 / 255] = 0.0
    a[a > 253.5 / 255] = 1.0
    return a, used_gpu


# ------------------------------------------------------ couleur des bords

def _box(x, r):
    """Moyenne glissante sur (2r+1)^2 px, bords en miroir, en O(N)."""
    import numpy as np
    for ax in (0, 1):
        n = x.shape[ax]
        pad = [(0, 0)] * x.ndim
        pad[ax] = (r + 1, r)
        p = np.pad(x, pad, mode="reflect" if n > r + 1 else "edge")
        c = np.cumsum(p, axis=ax, dtype=np.float32)
        k = 2 * r + 1
        hi = [slice(None)] * x.ndim
        lo = [slice(None)] * x.ndim
        hi[ax] = slice(k, k + n)
        lo[ax] = slice(0, n)
        x = (c[tuple(hi)] - c[tuple(lo)]) / k
    return x


def _fb_pass(I, F, B, a, r):
    """Une passe de "blur fusion" : premier plan F et fond B estimes."""
    import numpy as np
    a3 = a[..., None]
    bA = _box(a, r)[..., None]
    bF = _box(F * a3, r) / (bA + 1e-5)
    bB = _box(B * (1 - a3), r) / ((1 - bA) + 1e-5)
    return np.clip(bF + a3 * (I - a3 * bF - (1 - a3) * bB), 0, 1), bB


def _up_window(lo, H, W, y0, y1, x0, x1):
    """Fenetre [y0:y1, x0:x1] d'un agrandissement bilineaire de `lo`
    (h, w, c) en (H, W, c), sans construire l'image entiere."""
    import numpy as np
    h, w = lo.shape[:2]
    ys = np.clip((np.arange(y0, y1) + 0.5) * h / H - 0.5, 0, h - 1)
    xs = np.clip((np.arange(x0, x1) + 0.5) * w / W - 0.5, 0, w - 1)
    y_i = np.minimum(ys.astype(int), h - 2)
    x_i = np.minimum(xs.astype(int), w - 2)
    wy = (ys - y_i)[:, None, None].astype(np.float32)
    wx = (xs - x_i)[None, :, None].astype(np.float32)
    rows_a, rows_b = lo[y_i], lo[y_i + 1]
    top = rows_a[:, x_i] * (1 - wx) + rows_a[:, x_i + 1] * wx
    bot = rows_b[:, x_i] * (1 - wx) + rows_b[:, x_i + 1] * wx
    return top * (1 - wy) + bot * wy


def decontaminate(rgb, alpha, strip=256):
    """Couleur du premier plan la ou l'alpha est partiel. Passe large en
    basse definition (le flou de 90 px n'a pas besoin de plus), passe fine
    en pleine definition, seulement autour des bords, par bandes : memoire
    bornee meme sur 50 Mpx."""
    import numpy as np
    Image = utils.pil_image()
    H, W = alpha.shape
    s = min(1.0, 1024.0 / max(H, W))
    w, h = max(2, round(W * s)), max(2, round(H * s))
    I_lo = np.asarray(Image.fromarray(rgb).resize((w, h), Image.Resampling.BOX),
                      dtype=np.float32) / 255.0
    a_lo = np.asarray(Image.fromarray(alpha, "F").resize((w, h), Image.Resampling.BOX),
                      dtype=np.float32)
    F_lo, B_lo = _fb_pass(I_lo, I_lo, I_lo, a_lo, max(2, round(45 * s)))

    out = rgb.copy()
    r = 3
    soft = (alpha > 0) & (alpha < 1)
    for y0 in range(0, H, strip):
        y1 = min(H, y0 + strip)
        cols = np.flatnonzero(soft[y0:y1].any(axis=0))
        if not len(cols):
            continue
        # seulement les colonnes qui ont des bords (+ la marge du flou)
        x0, x1 = max(0, cols[0] - r - 1), min(W, cols[-1] + r + 2)
        a0, a1 = max(0, y0 - r - 1), min(H, y1 + r + 1)
        I = rgb[a0:a1, x0:x1].astype(np.float32) / 255.0
        F1 = _up_window(F_lo, H, W, a0, a1, x0, x1)
        B1 = _up_window(B_lo, H, W, a0, a1, x0, x1)
        F, _ = _fb_pass(I, F1, B1, alpha[a0:a1, x0:x1], r)
        F = F[y0 - a0:y0 - a0 + (y1 - y0)]
        m = soft[y0:y1, x0:x1]
        out[y0:y1, x0:x1][m] = (F[m] * 255.0 + 0.5).astype(np.uint8)
    return out


# ----------------------------------------------------------------- sortie

def cutout_image(img, key, gpu=False, colors=True):
    """Image RGBA detouree + carte graphique utilisee ou non."""
    import numpy as np
    Image = utils.pil_image()
    rgb = np.asarray(img.convert("RGB"), dtype=np.uint8)
    alpha, used_gpu = predict_alpha(img, key, gpu)
    if colors:
        rgb = decontaminate(rgb, alpha)
    a8 = (alpha * 255.0 + 0.5).astype(np.uint8)
    return Image.fromarray(np.dstack([rgb, a8]), "RGBA"), used_gpu


def crop_to_subject(img, margin=0.02):
    """Recadre au sujet (pixels visibles), avec une petite marge."""
    a = img.getchannel("A").point(lambda v: 255 if v > 8 else 0)
    box = a.getbbox()
    if not box:
        return img
    m = round(max(img.size) * margin)
    x0, y0, x1, y1 = box
    return img.crop((max(0, x0 - m), max(0, y0 - m),
                     min(img.width, x1 + m), min(img.height, y1 + m)))


def out_path(src):
    folder, name = os.path.split(src)
    base, _ = os.path.splitext(name)
    return utils.unique_path(os.path.join(folder, f"{base}_detoure.png"))


def cutout_one(src, model_key, notify, is_cancelled, gpu=False, crop=False):
    """Detoure une image -> PNG transparent a cote de l'originale.

    notify(phase, pct) : 'model' (telechargement du modele, pct 0..1 ou
    None) puis 'run'. Renvoie (chemin, carte graphique utilisee)."""
    if is_cancelled():
        raise utils.CancelledError()
    if not os.path.isfile(src):
        raise RuntimeError("fichier introuvable (déplacé ou supprimé ?)")
    if not model_cached(model_key):
        notify("model", 0.0)
        download_model(model_key, lambda done, total: notify(
            "model", done / total if total else None))
    if is_cancelled():
        raise utils.CancelledError()
    notify("run", None)

    from PIL import ImageOps
    Image = utils.pil_image()
    with Image.open(src) as im:
        # profil couleur garde seulement s'il reste valable (RVB -> RVBA)
        icc = im.info.get("icc_profile") if im.mode in ("RGB", "RGBA") else None
        img = ImageOps.exif_transpose(im)
        img.load()
    if img.mode not in ("RGB", "RGBA", "L"):
        img = img.convert("RGB")
    res, used_gpu = cutout_image(img, model_key, gpu)
    if crop:
        res = crop_to_subject(res)
    out = out_path(src)
    part = out + ".part"
    # compression 3 : 2 fois plus rapide que le defaut, fichier ~6 % plus gros
    extra = {"icc_profile": icc} if icc else {}
    res.save(part, "PNG", compress_level=3, **extra)
    os.replace(part, out)
    return out, used_gpu


# ------------------------------------------------- processus de detourage

def worker_command(job_json):
    """Commande du processus de detourage (meme Python que l'appli)."""
    import sys
    exe = sys.executable
    # pythonw (appli sans console) : son python.exe voisin ecrit sur stdout
    cand = os.path.join(os.path.dirname(exe), "python.exe")
    if os.path.basename(exe).lower() == "pythonw.exe" and os.path.isfile(cand):
        exe = cand
    return [exe, "-E", "-s", "-X", "utf8", "-m", "mudkit.core.cutout_worker", job_json]


def spawn_worker(job_json):
    return subprocess.Popen(
        worker_command(job_json), cwd=utils.ROOT, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
