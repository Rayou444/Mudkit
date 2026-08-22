"""Logique de l'upscaler IA (Real-ESRGAN ncnn/Vulkan), sans interface.

Les modeles "pack upscayl" viennent du projet Upscayl
(github.com/upscayl/upscayl) et tournent sur le meme moteur.
"""
import os
import re
import subprocess

from .. import utils

# cle -> fichier modele, echelles natives, pack d'origine
MODELS = {
    "standard":   {"file": "upscayl-standard-4x",     "scales": (4,),
                   "pack": "upscayl"},
    "ultrasharp": {"file": "ultrasharp-4x",           "scales": (4,),
                   "pack": "upscayl"},
    "remacri":    {"file": "remacri-4x",              "scales": (4,),
                   "pack": "upscayl"},
    "digital":    {"file": "digital-art-4x",          "scales": (4,),
                   "pack": "upscayl"},
    "lite":       {"file": "upscayl-lite-4x",         "scales": (4,),
                   "pack": "upscayl"},
    "photo":      {"file": "realesrgan-x4plus",       "scales": (4,),
                   "pack": "builtin"},
    "anime":      {"file": "realesrgan-x4plus-anime", "scales": (4,),
                   "pack": "builtin"},
    "fast":       {"file": "realesr-animevideov3",    "scales": (2, 3, 4),
                   "pack": "builtin"},
}

OUT_FORMATS = ("png", "jpg", "webp")

_PCT_RE = re.compile(r"(\d+(?:\.\d+)?)%")


def model_available(key):
    m = MODELS[key]
    name = m["file"]
    if key == "fast":  # fichiers suffixes par echelle
        name += "-x4"
    return os.path.isfile(
        os.path.join(utils.realesrgan_models_dir(), name + ".param"))


def available_models():
    return [{"key": k, "pack": m["pack"], "available": model_available(k)}
            for k, m in MODELS.items()]


def out_path(src, scale, fmt="png"):
    folder, name = os.path.split(src)
    base, _ = os.path.splitext(name)
    return os.path.join(folder, f"{scale}x_{base}.{fmt}")


def upscale_one(src, model_key, scale, fmt, progress, is_cancelled):
    """Upscale une image. progress(pct 0..1). Retourne le chemin de sortie."""
    m = MODELS[model_key]
    if fmt not in OUT_FORMATS:
        fmt = "png"
    native = scale if scale in m["scales"] else max(m["scales"])
    out = out_path(src, scale, fmt)

    cmd = [utils.realesrgan_path(), "-i", src, "-o", out,
           "-n", m["file"], "-s", str(native), "-f", fmt,
           "-m", utils.realesrgan_models_dir()]
    proc = subprocess.Popen(
        cmd, creationflags=utils.NO_WINDOW,
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace")
    tail = []
    for line in proc.stderr:
        if is_cancelled():
            proc.kill()
            raise utils.CancelledError()
        line = line.strip()
        if line:
            tail.append(line)
            match = _PCT_RE.search(line)
            if match:
                progress(min(float(match.group(1)) / 100.0, 1.0))
    proc.wait()
    if proc.returncode != 0 or not os.path.isfile(out):
        raise RuntimeError(" | ".join(tail[-3:]) or "echec Real-ESRGAN")

    if native != scale:  # reduit vers l'echelle demandee
        Image = utils.pil_image()
        with Image.open(src) as ref:
            w, h = ref.size
        with Image.open(out) as img:
            resized = img.resize((w * scale, h * scale),
                                 Image.Resampling.LANCZOS)
            if fmt == "jpg" and resized.mode != "RGB":
                resized = resized.convert("RGB")
            resized.save(out)
    progress(1.0)
    return out
