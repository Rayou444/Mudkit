"""Detourage d'images (suppression d'arriere-plan) en local, via onnxruntime.

Meme pipeline que rembg (memes modeles, meme pretraitement, meme decoupe
"naive"), sans sa pile de dependances : scipy, numba, llvmlite,
scikit-image... (~290 Mo) n'y servaient qu'a des options jamais utilisees
ici. Restent onnxruntime + numpy + Pillow.

Modeles : BiRefNet (le meilleur open source, licence MIT) et IS-Net (plus
leger). Telecharges au premier usage a l'emplacement de rembg
(~/.rembg/models/<nom>/<nom>.onnx) : ceux deja presents sont reutilises.
"""
import hashlib
import os

from .. import utils

_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/"
_IMAGENET = ((0.485, 0.456, 0.406), (0.229, 0.224, 0.225))

# cle -> nom, fichier distant, md5, (moyenne, ecart-type), sigmoide ?
MODELS = {
    "best": ("birefnet-general", "BiRefNet-general-epoch_244.onnx",
             "7a35a0141cbbc80de11d9c9a28f52697", _IMAGENET, True),
    "portrait": ("birefnet-portrait", "BiRefNet-portrait-epoch_150.onnx",
                 "c3a64a6abf20250d090cd055f12a3b67", _IMAGENET, True),
    "fast": ("isnet-general-use", "isnet-general-use.onnx",
             "fc16ebd8b0c10d971d3513d564d01e29",
             ((0.5, 0.5, 0.5), (1.0, 1.0, 1.0)), False),
}
SIZE = (1024, 1024)

_sessions = {}


def _candidates(key):
    name = MODELS[key][0]
    home = os.path.expanduser("~")
    return [os.path.join(home, ".rembg", "models", name, name + ".onnx"),
            os.path.join(home, ".u2net", name + ".onnx")]  # ancien rembg


def model_path(key):
    """Chemin du modele s'il est deja telecharge, sinon None."""
    return next((p for p in _candidates(key) if os.path.isfile(p)), None)


def model_cached(key):
    return model_path(key) is not None


def download_model(key, progress=None):
    """Telecharge le modele (progress(fait, total) en octets), md5 verifie."""
    _, remote, md5, _, _ = MODELS[key]
    dest = _candidates(key)[0]
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    part = dest + ".part"
    utils._download(_URL + remote, part, progress)  # noqa: SLF001
    h = hashlib.md5()  # noqa: S324 - controle d'integrite, pas de securite
    with open(part, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest() != md5:
        os.remove(part)
        raise RuntimeError("modele telecharge corrompu, reessaie")
    os.replace(part, dest)
    return dest


def _session(key):
    if key not in _sessions:
        import onnxruntime as ort
        _sessions[key] = ort.InferenceSession(
            model_path(key), providers=["CPUExecutionProvider"])
    return _sessions[key]


def predict_mask(img, key):
    """Masque de premier plan (image L, taille de `img`)."""
    import numpy as np
    Image = utils.pil_image()
    _, _, _, (mean, std), sigmoid = MODELS[key]
    sess = _session(key)

    im = np.array(img.convert("RGB").resize(SIZE, Image.Resampling.LANCZOS))
    im = im / max(np.max(im), 1e-6)
    x = ((im - mean) / std).transpose((2, 0, 1))[None].astype(np.float32)

    pred = sess.run(None, {sess.get_inputs()[0].name: x})[0][:, 0, :, :]
    if sigmoid:
        pred = 1 / (1 + np.exp(-pred))
    pred = np.squeeze((pred - pred.min()) / (pred.max() - pred.min()))
    mask = Image.fromarray((pred * 255).astype("uint8"))
    return mask.resize(img.size, Image.Resampling.LANCZOS)


def cutout_image(img, key):
    """Image RGBA detouree (decoupe "naive" de rembg : pas d'alpha matting)."""
    Image = utils.pil_image()
    mask = predict_mask(img, key)
    return Image.composite(img, Image.new("RGBA", img.size, 0), mask)


def out_path(src):
    folder, name = os.path.split(src)
    base, _ = os.path.splitext(name)
    return utils.unique_path(os.path.join(folder, f"{base}_detoure.png"))


def cutout_one(src, model_key, notify, is_cancelled):
    """Detoure une image -> PNG transparent a cote de l'originale.

    notify(phase, pct) : 'model' (telechargement du modele, pct 0..1 ou
    None) puis 'run'. L'inference elle-meme est un seul appel bloquant.
    """
    if is_cancelled():
        raise utils.CancelledError()
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
        img = ImageOps.exif_transpose(im)
        img.load()
    out = out_path(src)
    cutout_image(img, model_key).save(out, "PNG")
    return out
