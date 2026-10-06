"""Logique de l'upscaler IA (Real-ESRGAN ncnn/Vulkan), sans interface.

Les modeles "pack upscayl" viennent du projet Upscayl
(github.com/upscayl/upscayl) et tournent sur le meme moteur.
"""
import os
import re
import subprocess
import tempfile

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
    """Chemin libre : un 2e upscale (autre modele) n'efface plus le 1er."""
    folder, name = os.path.split(src)
    base, _ = os.path.splitext(name)
    return utils.unique_path(os.path.join(folder, f"{scale}x_{base}.{fmt}"))


def _upright_copy(src, tmp):
    """Real-ESRGAN lit le fichier brut et ignore l'orientation EXIF : une
    photo de telephone en portrait ressortait couchee. Si l'image doit etre
    tournee, on lui passe une copie deja droite. Sinon None."""
    from PIL import ImageOps
    Image = utils.pil_image()
    try:
        with Image.open(src) as im:
            if im.getexif().get(0x0112, 1) in (None, 1):  # Orientation
                return None
            fixed = ImageOps.exif_transpose(im)
            path = os.path.join(tmp, "droit.png")
            fixed.save(path)
            return path
    except Exception:  # noqa: BLE001 - illisible par PIL : on laisse faire
        return None


def upscale_one(src, model_key, scale, fmt, progress, is_cancelled):
    """Upscale une image. progress(pct 0..1). Retourne le chemin de sortie."""
    m = MODELS[model_key]
    if fmt not in OUT_FORMATS:
        fmt = "png"
    native = scale if scale in m["scales"] else max(m["scales"])
    out = out_path(src, scale, fmt)

    with tempfile.TemporaryDirectory() as tmp:
        inp = _upright_copy(src, tmp) or src
        cmd = [utils.realesrgan_path(), "-i", inp, "-o", out,
               "-n", m["file"], "-s", str(native), "-f", fmt,
               "-m", utils.realesrgan_models_dir()]
        proc = subprocess.Popen(
            cmd, creationflags=utils.NO_WINDOW, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace")
        tail = []
        try:
            for line in proc.stderr:
                if is_cancelled():
                    raise utils.CancelledError()
                line = line.strip()
                if line:
                    tail.append(line)
                    match = _PCT_RE.search(line)
                    if match:
                        progress(min(float(match.group(1)) / 100.0, 1.0))
            proc.wait()
        except BaseException:
            # tue PUIS attend, et pas de fichier a moitie ecrit sous un nom
            # propre
            proc.kill()
            proc.wait()
            utils._remove_quietly(out)  # noqa: SLF001
            raise
        if proc.returncode != 0 or not os.path.isfile(out):
            utils._remove_quietly(out)  # noqa: SLF001
            raise RuntimeError(" | ".join(tail[-3:]) or "echec Real-ESRGAN")

        if native != scale:  # reduit vers l'echelle demandee
            Image = utils.pil_image()
            with Image.open(inp) as ref:
                w, h = ref.size
            with Image.open(out) as img:
                resized = img.resize((w * scale, h * scale),
                                     Image.Resampling.LANCZOS)
            if fmt == "jpg" and resized.mode != "RGB":
                resized = resized.convert("RGB")
            # qualite explicite : sans elle, PIL reenregistrait en 75 (JPG)
            # ou 80 (WebP), bien en dessous du resultat de Real-ESRGAN
            resized.save(out, quality=95)
    progress(1.0)
    return out
