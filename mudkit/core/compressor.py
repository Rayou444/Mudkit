"""Compression a taille cible : videos (ffmpeg deux passes) et images."""
import io
import os
import subprocess
import tempfile

from . import converter
from .. import utils


def out_path(src, target_mb):
    folder, name = os.path.split(src)
    base, _ = os.path.splitext(name)
    label = f"{target_mb:g}Mo"
    return os.path.join(folder, f"{base}_{label}.mp4")


def _run_pass(cmd, duration, progress, is_cancelled, base, span):
    """Execute une passe ffmpeg en remontant la progression [base, base+span]."""
    proc = subprocess.Popen(
        cmd, creationflags=utils.NO_WINDOW,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace")
    for line in proc.stdout:
        if is_cancelled():
            proc.kill()
            raise utils.CancelledError()
        line = line.strip()
        if duration and line.startswith("out_time_us="):
            try:
                done = int(line.split("=")[1]) / 1e6 / duration
                progress(base + min(done, 1.0) * span)
            except ValueError:
                pass
    _, err = proc.communicate()
    if proc.returncode != 0:
        tail = (err or "echec ffmpeg").strip().splitlines()
        raise RuntimeError(tail[-1][:300] if tail else "echec ffmpeg")


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
            f"deja sous la cible ({utils.human_size(orig)}) — rien a faire")

    with Image.open(src) as im:
        has_alpha = (im.mode in ("RGBA", "LA")
                     or (im.mode == "P" and "transparency" in im.info))
        img = im.convert("RGBA" if has_alpha else "RGB")
    fmt, ext = ("WEBP", "webp") if has_alpha else ("JPEG", "jpg")

    folder, name = os.path.split(src)
    base, _ = os.path.splitext(name)
    out = os.path.join(folder, f"{base}_{target_mb:g}Mo.{ext}")

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
    raise RuntimeError("impossible de descendre sous la cible — "
                       "vise une taille plus grande")


def compress_any(src, target_mb, progress, is_cancelled):
    """Compresse une video ou une image selon le type du fichier."""
    if converter.category(src) == "image":
        return compress_image_to_size(src, target_mb, progress, is_cancelled)
    if converter.category(src) == "video":
        return compress_to_size(src, target_mb, progress, is_cancelled)
    raise RuntimeError("ce type de fichier ne se compresse pas ici "
                       "(videos et images seulement)")


def compress_to_size(src, target_mb, progress, is_cancelled):
    """Compresse src en mp4 sous target_mb. Retourne (sortie, taille octets).

    Deux passes x264 : la 1re analyse la video, la 2e encode au debit
    calcule pour viser la taille cible (marge de 6 % pour le conteneur).
    """
    if not utils.has_ffmpeg():
        raise RuntimeError("ffmpeg n'est pas installe")
    orig = os.path.getsize(src)
    if orig <= target_mb * 1024 * 1024:
        raise RuntimeError(
            f"deja sous la cible ({utils.human_size(orig)}) — rien a faire")
    duration = converter._duration_seconds(src)  # noqa: SLF001 - meme paquet
    if not duration:
        raise RuntimeError("duree de la video introuvable")

    total_kbps = target_mb * 8192 * 0.94 / duration
    audio_kbps = 128 if total_kbps > 1000 else 96 if total_kbps > 400 else 64
    video_kbps = total_kbps - audio_kbps
    if video_kbps < 30:
        raise RuntimeError(
            f"cible trop petite pour {duration:.0f}s de video — "
            "vise une taille plus grande")

    # reduit la definition si le debit est trop maigre pour la source
    scale = None
    if video_kbps < 300:
        scale = 480
    elif video_kbps < 800:
        scale = 720
    elif video_kbps < 2200:
        scale = 1080

    out = out_path(src, target_mb)
    with tempfile.TemporaryDirectory() as tmp:
        common = [utils.ffmpeg_path(), "-y", "-v", "error",
                  "-progress", "pipe:1", "-nostats", "-i", src,
                  "-c:v", "libx264", "-b:v", f"{video_kbps:.0f}k",
                  "-preset", "medium",
                  "-passlogfile", os.path.join(tmp, "ff2pass")]
        if scale:
            common += ["-vf", f"scale=-2:'min(ih,{scale})'"]
        _run_pass(common + ["-pass", "1", "-an", "-f", "null", "-"],
                  duration, progress, is_cancelled, 0.0, 0.5)
        _run_pass(common + ["-pass", "2", "-c:a", "aac",
                            "-b:a", f"{audio_kbps}k",
                            "-movflags", "+faststart", out],
                  duration, progress, is_cancelled, 0.5, 0.5)

    if not os.path.isfile(out):
        raise RuntimeError("fichier de sortie manquant")
    progress(1.0)
    return out, os.path.getsize(out)
