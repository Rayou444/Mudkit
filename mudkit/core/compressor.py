"""Compression a taille cible : videos (ffmpeg deux passes) et images."""
import io
import os
import tempfile

from . import converter
from .. import utils


def out_path(src, target_mb):
    folder, name = os.path.split(src)
    base, _ = os.path.splitext(name)
    label = f"{target_mb:g}Mo"
    return utils.unique_path(os.path.join(folder, f"{base}_{label}.mp4"))


def _run_pass(cmd, duration, progress, is_cancelled, base, span, partial=None):
    """Execute une passe ffmpeg en remontant la progression [base, base+span]."""
    utils.run_ffmpeg(
        cmd, is_cancelled=is_cancelled, partial=partial,
        on_time=lambda t: progress(base + min(t / duration, 1.0) * span))


def compress_image_to_size(src, target_mb, progress, is_cancelled):
    """Compresse une image sous target_mb. Retourne (sortie, taille octets).

    Baisse d'abord la qualite, puis la definition si necessaire. Sortie en
    JPEG, ou WebP si l'image a de la transparence (pour la conserver).
    """
    Image = utils.pil_image()
    target = int(target_mb * 1024 * 1024)
    orig = os.path.getsize(src)
    if orig <= target:
        raise RuntimeError(
            f"déjà sous la cible ({utils.human_size(orig)}), rien à faire")

    from PIL import ImageOps
    with Image.open(src) as im:
        # photo de telephone en portrait : appliquer l'orientation EXIF
        im = ImageOps.exif_transpose(im)
        if im.mode.startswith("I") or im.mode == "F":  # 16 bits -> 8 bits
            im = converter._mode_for(im, "jpg")  # noqa: SLF001 - meme paquet
        has_alpha = (im.mode in ("RGBA", "LA")
                     or (im.mode == "P" and "transparency" in im.info))
        img = im.convert("RGBA" if has_alpha else "RGB")
    fmt, ext = ("WEBP", "webp") if has_alpha else ("JPEG", "jpg")

    folder, name = os.path.split(src)
    base, _ = os.path.splitext(name)
    out = utils.unique_path(os.path.join(folder, f"{base}_{target_mb:g}Mo.{ext}"))

    # garde la definition tant que possible, puis reduit progressivement
    steps = [(scale, q)
             for scale in (1.0, 0.85, 0.7, 0.55, 0.4, 0.3, 0.2)
             for q in (85, 70, 55, 40, 30)]
    resized, last_scale = img, 1.0
    for i, (scale, q) in enumerate(steps):
        if is_cancelled():
            raise utils.CancelledError()
        if scale != last_scale:
            w, h = img.size
            resized = img.resize((max(1, int(w * scale)),
                                  max(1, int(h * scale))),
                                 Image.Resampling.LANCZOS)
            last_scale = scale
        kw = {"quality": q}
        if fmt == "JPEG":
            kw["optimize"] = True
        buf = io.BytesIO()
        resized.save(buf, fmt, **kw)
        progress(min((i + 1) / len(steps), 0.98))
        if buf.tell() <= target:
            with open(out, "wb") as f:
                f.write(buf.getvalue())
            progress(1.0)
            return out, buf.tell()
    raise RuntimeError("impossible de descendre sous la cible, "
                       "vise une taille plus grande")


def compress_any(src, target_mb, progress, is_cancelled):
    """Compresse une video ou une image selon le type du fichier."""
    if converter.category(src) == "image" and not converter.is_animated_gif(src):
        return compress_image_to_size(src, target_mb, progress, is_cancelled)
    # un GIF anime part en mp4 : avant, il devenait un JPEG d'une seule image
    if converter.category(src) == "video" or converter.is_animated_gif(src):
        return compress_to_size(src, target_mb, progress, is_cancelled)
    raise RuntimeError("ce type de fichier ne se compresse pas ici "
                       "(videos et images seulement)")


def compress_to_size(src, target_mb, progress, is_cancelled):
    """Compresse src en mp4 sous target_mb. Retourne (sortie, taille octets).

    Deux passes x264 : la 1re analyse la video, la 2e encode au debit
    calcule pour viser la taille cible (marge de 6 % pour le conteneur).
    Si le resultat depasse quand meme (conteneur, pics), on recommence avec
    un debit reduit d'autant : la video « 10 Mo » doit vraiment passer.
    """
    if not utils.has_ffmpeg():
        raise RuntimeError("ffmpeg n'est pas installé")
    target = target_mb * 1024 * 1024
    orig = os.path.getsize(src)
    if orig <= target:
        raise RuntimeError(
            f"déjà sous la cible ({utils.human_size(orig)}), rien à faire")
    duration = converter._duration_seconds(src)  # noqa: SLF001 - meme paquet
    if not duration:
        raise RuntimeError("durée de la vidéo introuvable")
    _, acodec, trc = converter.probe_streams(src)

    total_kbps = target_mb * 8192 * 0.94 / duration
    audio_kbps = 0 if acodec is None else (
        128 if total_kbps > 1000 else 96 if total_kbps > 400 else 64)
    video_kbps = total_kbps - audio_kbps
    if video_kbps < 30:
        raise RuntimeError(
            f"cible trop petite pour {duration:.0f} s de vidéo, "
            "vise une taille plus grande")

    out = out_path(src, target_mb)
    for attempt in range(3):
        _two_pass(src, out, duration, video_kbps, audio_kbps, trc,
                  progress, is_cancelled)
        size = os.path.getsize(out)
        if size <= target:
            break
        video_kbps *= target / size * 0.97
        if video_kbps < 30:
            break
    progress(1.0)
    return out, os.path.getsize(out)


def _two_pass(src, out, duration, video_kbps, audio_kbps, trc, progress,
              is_cancelled):
    # definition reduite si le debit est trop maigre pour la source. Sur le
    # PETIT cote : avant, une video portrait 1080x1920 tombait en 608x1080
    scale = None
    if video_kbps < 300:
        scale = 480
    elif video_kbps < 800:
        scale = 720
    elif video_kbps < 2200:
        scale = 1080
    filters = []
    if converter.is_hdr(trc):
        filters.append(converter.TONEMAP)   # HDR iPhone : plus de couleurs delavees
    if scale:
        filters.append(f"scale=w='if(gt(iw,ih),-2,min(iw,{scale}))'"
                       f":h='if(gt(iw,ih),min(ih,{scale}),-2)'")
    # yuv420p : sinon une source 10 bits donne du H.264 High 10, illisible
    # dans Discord, WhatsApp et les navigateurs
    filters.append("format=yuv420p")

    with tempfile.TemporaryDirectory() as tmp:
        common = [utils.ffmpeg_path(), "-y", "-v", "error",
                  "-progress", "pipe:1", "-nostats", "-i", src,
                  "-c:v", "libx264", "-b:v", f"{video_kbps:.0f}k",
                  "-preset", "medium", "-vf", ",".join(filters),
                  "-passlogfile", os.path.join(tmp, "ff2pass")]
        audio = (["-an"] if not audio_kbps
                 else ["-c:a", "aac", "-b:a", f"{audio_kbps}k"])
        _run_pass(common + ["-pass", "1", "-an", "-f", "null", "-"],
                  duration, progress, is_cancelled, 0.0, 0.5)
        _run_pass(common + ["-pass", "2"] + audio
                  + ["-movflags", "+faststart", out],
                  duration, progress, is_cancelled, 0.5, 0.5, partial=out)
    if not os.path.isfile(out):
        raise RuntimeError("fichier de sortie manquant")
