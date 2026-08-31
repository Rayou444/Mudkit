"""Detourage d'images (suppression d'arriere-plan) via rembg, en local.

Modeles : BiRefNet (le meilleur open source, licence MIT) et IS-Net
(plus leger, plus rapide). Telecharges automatiquement au premier usage
dans ~/.u2net, puis mis en cache en memoire pour la session.
"""
import os

from .. import utils

# cle -> nom de modele rembg
MODELS = {
    "best": "birefnet-general",
    "portrait": "birefnet-portrait",
    "fast": "isnet-general-use",
}

_sessions = {}


def model_cached(key):
    """Vrai si le fichier du modele est deja telecharge sur le disque."""
    name = MODELS[key]
    home = os.path.expanduser("~")
    for d in (os.path.join(home, ".rembg", "models", name),
              os.path.join(home, ".u2net")):
        if os.path.isdir(d) and any(
                f.startswith(name) and f.endswith(".onnx")
                for f in os.listdir(d)):
            return True
    return False


def _session(key):
    if key not in _sessions:
        from rembg import new_session
        _sessions[key] = new_session(MODELS[key])
    return _sessions[key]


def out_path(src):
    folder, name = os.path.split(src)
    base, _ = os.path.splitext(name)
    return os.path.join(folder, f"{base}_detoure.png")


def cutout_one(src, model_key, notify, is_cancelled):
    """Detoure une image -> PNG transparent. notify(phase) : 'model'|'run'.

    Pas de progression fine : l'inference est un seul appel bloquant.
    """
    if is_cancelled():
        raise utils.CancelledError()
    if not model_cached(model_key):
        notify("model")  # premier usage : telechargement du modele
    sess = _session(model_key)
    if is_cancelled():
        raise utils.CancelledError()
    notify("run")

    from rembg import remove
    utils.pil_image()  # leve la limite anti-bombe de Pillow
    with open(src, "rb") as f:
        data = f.read()
    result = remove(data, session=sess)
    out = out_path(src)
    with open(out, "wb") as f:
        f.write(result)
    return out
