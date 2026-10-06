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


def _probe(src, entries):
    try:
        r = utils.run_hidden([utils.ffprobe_path(), "-v", "error",
                              "-show_entries", entries, "-of", "json", src])
        import json
        return json.loads(r.stdout or "{}")
    except (ValueError, OSError):
        return {}


def _duration_seconds(src):
    """Duree du conteneur, sinon celle du 1er flux : un WebM enregistre par
    un navigateur ou un mkv OBS interrompu n'ont pas de duree globale."""
    info = _probe(src, "format=duration:stream=duration")
    for v in [info.get("format", {}).get("duration")] + [
            s.get("duration") for s in info.get("streams", [])]:
        try:
            d = float(v)
            if d > 0:
                return d
        except (TypeError, ValueError):
            continue
    return None


def probe_streams(src):
    """(codec video, codec audio, transfert de couleur) du fichier."""
    return probe_streams_full(src)[:3]


def probe_streams_full(src):
    """(codec video, codec audio, transfert de couleur, format de pixels)."""
    v = a = trc = pix = None
    info = _probe(src, "stream=codec_type,codec_name,color_transfer,pix_fmt")
    for s in info.get("streams", []):
        if s.get("codec_type") == "video" and v is None:
            v, trc, pix = s.get("codec_name"), s.get("color_transfer"), s.get("pix_fmt")
        elif s.get("codec_type") == "audio" and a is None:
            a = s.get("codec_name")
    return v, a, trc, pix


def is_hdr(transfer):
    return transfer in ("smpte2084", "arib-std-b67")


# HDR (PQ / HLG, iPhone, GoPro) -> SDR BT.709 : sans ca, une video HDR
# reencodee en H.264 8 bits sortait delavee
TONEMAP = ("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
           "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,"
           "format=yuv420p")


def is_animated_gif(src):
    if os.path.splitext(src)[1].lower() != ".gif":
        return False
    try:
        Image = utils.pil_image()
        with Image.open(src) as im:
            return bool(getattr(im, "is_animated", False))
    except Exception:  # noqa: BLE001
        return False


def _mode_for(img, target):
    """Mode d'image accepte par le format cible. Avant : une image CMYK vers
    PNG / BMP, ou un PNG 16 bits vers JPG, echouait (« cannot write mode »)."""
    m = img.mode
    if m in ("I;16", "I;16B", "I;16L", "I"):  # 16 bits -> 8 bits
        img = (img if m == "I" else img.convert("I")).point(lambda v: v * (1 / 256))
        img = img.convert("L")
    elif m == "F":
        img = img.convert("L")
    if img.mode == "CMYK" and target != "jpg":
        img = img.convert("RGB")
    if target in ("jpg", "bmp") and img.mode not in ("RGB", "L", "CMYK"):
        img = img.convert("RGB")
    elif target in ("webp", "ico") and img.mode not in ("RGB", "RGBA"):
        alpha = "A" in img.mode or "transparency" in img.info
        img = img.convert("RGBA" if alpha or target == "ico" else "RGB")
    return img


def _convert_image(src, target):
    Image = utils.pil_image()
    from PIL import ImageOps
    out = out_path(src, target)
    with Image.open(src) as im:
        if target in ("webp", "gif") and getattr(im, "is_animated", False):
            # GIF anime -> WebP anime (avant : une seule image)
            im.save(out, save_all=True, quality=90,
                    loop=im.info.get("loop", 0),
                    duration=im.info.get("duration", 100))
            return out
        # photo de telephone en portrait : appliquer l'orientation EXIF,
        # sinon elle ressortait couchee
        img = _mode_for(ImageOps.exif_transpose(im), target)
        if target == "ico":
            img.save(out, sizes=[(16, 16), (32, 32), (48, 48), (64, 64),
                                 (128, 128), (256, 256)])
        else:
            img.save(out, quality=95)
    return out


# codecs qu'on peut garder tels quels (simple changement de conteneur :
# quelques secondes au lieu de minutes, et aucune perte de qualite)
_COPY_OK = {
    "mp4": ({"h264", "hevc"}, {"aac", "mp3", None}),
    "m4v": ({"h264", "hevc"}, {"aac", None}),
    "mov": ({"h264", "hevc", "prores"}, {"aac", "pcm_s16le", "pcm_s24le", None}),
    "webm": ({"vp8", "vp9", "av1"}, {"opus", "vorbis", None}),
    "mkv": (None, None),   # le mkv accepte a peu pres tout
}


def _ffmpeg_args(src, ext, streams=None):
    cmd = [utils.ffmpeg_path(), "-y", "-v", "error",
           "-progress", "pipe:1", "-nostats", "-i", src]
    v, a, trc, pix = streams or (None, None, None, None)
    copy = _COPY_OK.get(ext)
    # mp4 / m4v = le format « qui se lit partout » : on ne garde l'image
    # telle quelle que si elle est deja en 4:2:0 8 bits
    plain = pix in ("yuv420p", "yuvj420p") or ext not in ("mp4", "m4v")
    if copy and v and plain and (copy[0] is None or v in copy[0]) \
            and (copy[1] is None or a in copy[1]) and not is_hdr(trc):
        cmd += ["-c", "copy"]
        if v == "hevc" and ext in ("mp4", "m4v", "mov"):
            cmd += ["-tag:v", "hvc1"]  # lisible par QuickTime / Premiere
        if ext in ("mp4", "m4v", "mov"):
            cmd += ["-movflags", "+faststart"]
        return cmd
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
        # row-mt / cpu-used : plusieurs fois plus rapide, qualite proche
        cmd += ["-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0",
                "-row-mt", "1", "-cpu-used", "4", "-deadline", "good",
                "-c:a", "libopus"]
        if is_hdr(trc):
            cmd += ["-vf", TONEMAP]
    elif ext in ("mp4", "mkv", "mov", "avi", "m4v"):
        # yuv420p : sans lui, une source 10 bits donnait du H.264 High 10,
        # illisible dans les navigateurs, Discord et WhatsApp
        cmd += ["-c:v", "libx264", "-crf", "18", "-preset", "medium",
                "-vf", TONEMAP if is_hdr(trc) else "format=yuv420p",
                "-c:a", "aac", "-b:a", "256k"]
    return cmd


def _convert_media(src, target, progress, is_cancelled):
    out = out_path(src, target)
    duration = _duration_seconds(src)
    streams = probe_streams_full(src) if category(src) == "video" else None
    utils.run_ffmpeg(
        _ffmpeg_args(src, target, streams) + [out],
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
