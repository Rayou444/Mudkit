"""Logique du convertisseur (images Pillow, audio/video ffmpeg), sans interface."""
import os
import subprocess

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
    base, old = os.path.splitext(src)
    if old.lower() == "." + ext:
        base += "_converti"
    return f"{base}.{ext}"


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
    cmd = _ffmpeg_args(src, target) + [out]
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
                progress(min(int(line.split("=")[1]) / 1e6 / duration, 1.0))
            except ValueError:
                pass
    _, err = proc.communicate()
    if proc.returncode != 0 or not os.path.isfile(out):
        tail = (err or "echec ffmpeg").strip().splitlines()
        raise RuntimeError(tail[-1][:300] if tail else "echec ffmpeg")
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
