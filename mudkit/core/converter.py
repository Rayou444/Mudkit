"""Logique du convertisseur (images Pillow, audio/video ffmpeg), sans interface."""
import os

from .. import utils

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".gif",
              ".ico"}
AUDIO_EXTS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".opus", ".aac",
              ".wma"}
VIDEO_EXTS = {".mp4", ".mkv", ".webm", ".avi", ".mov", ".wmv", ".flv",
              ".m4v"}

TARGETS = {
    "image": ["png", "jpg", "webp", "bmp", "ico", "tiff"],
    "audio": ["mp3", "wav", "flac", "ogg", "m4a", "opus"],
    "video": ["mp4", "mkv", "webm", "mov", "avi", "gif", "mp3"],
}


def category(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in AUDIO_EXTS:
        return "audio"
    if ext in VIDEO_EXTS:
        return "video"
    return None


def out_path(src, ext):
    """Chemin de sortie LIBRE : jamais ecraser un fichier existant (le
    `chanson.wav` d'origine a cote du `chanson.flac` qu'on convertit, ou
    `a.jpg` deja produit par `a.png` dans le meme lot)."""
    base, old = os.path.splitext(src)
    if old.lower() == "." + ext:
        base += "_converti"
    return utils.unique_path(f"{base}.{ext}")


def _duration_seconds(src):
    try:
        r = utils.run_hidden([utils.ffprobe_path(), "-v", "error",
                              "-show_entries", "format=duration",
                              "-of", "csv=p=0", src])
        return float(r.stdout.strip())
    except (ValueError, OSError):
        return None


def _convert_image(src, target):
    Image = utils.pil_image()
    out = out_path(src, target)
    with Image.open(src) as img:
        if target in ("jpg", "bmp") and img.mode in ("RGBA", "P", "LA"):
            img = img.convert("RGB")
        if target == "ico":
            img.save(out, sizes=[(16, 16), (32, 32), (48, 48), (64, 64),
                                 (128, 128), (256, 256)])
        else:
            img.save(out, quality=95)
    return out


def _ffmpeg_args(src, ext):
    cmd = [utils.ffmpeg_path(), "-y", "-v", "error",
           "-progress", "pipe:1", "-nostats", "-i", src]
    if ext == "gif":
        cmd += ["-vf",
                "fps=12,scale=480:-1:flags=lanczos,split[s0][s1];"
                "[s0]palettegen[p];[s1][p]paletteuse"]
    elif ext == "mp3":
        cmd += ["-vn", "-b:a", "320k"]
    elif ext == "m4a":
        cmd += ["-vn", "-c:a", "aac", "-b:a", "256k"]
    elif ext in ("opus", "ogg"):
        cmd += ["-vn", "-b:a", "192k"]
    elif ext in ("wav", "flac"):
        cmd += ["-vn"]
    elif ext == "webm":
        cmd += ["-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0",
                "-c:a", "libopus"]
    elif ext in ("mp4", "mkv", "mov", "avi", "m4v"):
        cmd += ["-c:v", "libx264", "-crf", "18", "-preset", "medium",
                "-c:a", "aac", "-b:a", "256k"]
    return cmd


def _convert_media(src, target, progress, is_cancelled):
    out = out_path(src, target)
    duration = _duration_seconds(src)
    utils.run_ffmpeg(
        _ffmpeg_args(src, target) + [out],
        on_time=(lambda t: progress(min(t / duration, 1.0))) if duration else None,
        is_cancelled=is_cancelled, partial=out)
    if not os.path.isfile(out):
        raise RuntimeError("echec ffmpeg : fichier de sortie manquant")
    progress(1.0)
    return out


def convert_one(src, target, progress, is_cancelled):
    """Convertit un fichier. progress(pct 0..1). Retourne le chemin de sortie."""
    cat = category(src)
    if cat == "image":
        out = _convert_image(src, target)
        progress(1.0)
        return out
    if cat in ("audio", "video"):
        if not utils.has_ffmpeg():
            raise RuntimeError("ffmpeg n'est pas installe")
        return _convert_media(src, target, progress, is_cancelled)
    raise RuntimeError("format non reconnu")
