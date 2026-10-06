"""Pont Mudkit <-> panneau Premiere Pro.

Telecharge une video ou l'audio et garantit un fichier importable dans
Premiere (H.264/AAC en mp4) : si YouTube livre de l'AV1/VP9 ou un mkv,
conversion automatique. Progression en lignes JSON sur stdout.

Usage : python -u premiere_dl.py <url> <h264|max|mp3>
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mudkit import dnsfix, utils
dnsfix.activate_if_needed()

from mudkit.core import converter, downloader

DEST = os.path.join(os.path.expanduser("~"), "Videos", "Mudkit", "Premiere")

# codecs que Premiere importe sans broncher
VIDEO_OK = {"h264", "hevc", "mpeg4", "mpeg2video", "prores", "dnxhd"}
AUDIO_OK = {"aac", "mp3", "pcm_s16le", "pcm_s24le"}


def emit(obj):
    print(json.dumps(obj), flush=True)


def probe_codecs(path):
    """Retourne (codec video, codec audio) du fichier (None si absent)."""
    r = utils.run_hidden([utils.ffprobe_path(), "-v", "error",
                          "-show_entries", "stream=codec_type,codec_name",
                          "-of", "json", path])
    v = a = None
    for s in json.loads(r.stdout or "{}").get("streams", []):
        if s.get("codec_type") == "video" and v is None:
            v = s.get("codec_name")
        elif s.get("codec_type") == "audio" and a is None:
            a = s.get("codec_name")
    return v, a


def needs_transcode(path):
    if os.path.splitext(path)[1].lower() != ".mp4":
        return True
    v, a = probe_codecs(path)
    if v and v not in VIDEO_OK:
        return True
    if a and a not in AUDIO_OK:
        return True
    return False


def transcode_for_premiere(path):
    """Reencode en H.264/AAC mp4 (GPU NVENC si dispo). Remplace l'original."""
    base, _ = os.path.splitext(path)
    out = base + "_h264.mp4"
    if os.path.isfile(out):
        # deja converti (meme video, meme mode, meme passage : le nom le
        # garantit). Le reecrire casserait le plan deja pose dans le projet.
        os.remove(path)
        return out
    duration = converter._duration_seconds(path)  # noqa: SLF001

    def on_time(t):
        if duration:
            emit({"pct": min(t / duration, 1.0), "transcode": True})

    def run(vcodec):
        utils.run_ffmpeg(
            [utils.ffmpeg_path(), "-y", "-v", "error",
             "-progress", "pipe:1", "-nostats", "-i", path]
            + vcodec
            + ["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "320k",
               "-movflags", "+faststart", out],
            on_time=on_time, partial=out)

    x264 = ["-c:v", "libx264", "-preset", "medium", "-crf", "16"]
    if utils.nvenc_available():
        try:
            run(["-c:v", "h264_nvenc", "-preset", "p5",
                 "-rc", "vbr", "-cq", "19", "-b:v", "0"])
        except RuntimeError:
            # NVENC refuse certaines sources (au-dela de 4096 px, ex. 8K) :
            # on refait au processeur plutot que d'echouer
            run(x264)
    else:
        run(x264)
    if not os.path.isfile(out):
        raise RuntimeError("echec ffmpeg : fichier de sortie manquant")
    os.remove(path)
    return out


def _clock(sec):
    """90 -> 1m30, 90.5 -> 1m30.5 (pas de deux-points : interdit sous Windows)."""
    m, s = divmod(sec, 60)
    return f"{int(m)}m{s:02.0f}" if s == int(s) else f"{int(m)}m{s:04.1f}"


def outtmpl(mode, section):
    """Un nom DIFFERENT par video, par mode et par passage.

    Avant : `%(title)s.%(ext)s`. Un 2e extrait de la meme video (ou une
    autre video au meme titre) tombait sur le meme nom ; yt-dlp repondait
    « deja telecharge » et le panneau posait l'ANCIEN plan, sans erreur.
    Meme video + meme mode + meme passage = meme fichier, reutilise : normal.
    Titre coupe a 150 octets : les titres tres longs depassent la limite
    de Windows.
    """
    tag = " (max)" if mode == "max" else ""
    if section:
        tag += f" ({_clock(section[0])}-{_clock(section[1])})"
    return os.path.join(DEST, "%(title).150B [%(id)s]" + tag + ".%(ext)s")


def main():
    if len(sys.argv) < 3:
        raise RuntimeError(
            "usage: premiere_dl.py <url> <h264|max|mp3> [debut fin]")
    url, mode = sys.argv[1], sys.argv[2]
    section = None
    if len(sys.argv) >= 5:
        section = (float(sys.argv[3]), float(sys.argv[4]))
    os.makedirs(DEST, exist_ok=True)

    import yt_dlp
    last = [0.0]

    def hook(d):
        now = time.monotonic()
        if d["status"] == "downloading" and now - last[0] > 0.25:
            last[0] = now
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes") or 0
            emit({"pct": (done / total) if total else None,
                  "speed": (utils.human_size(d["speed"]) + "/s")
                           if d.get("speed") else ""})
        elif d["status"] == "finished":
            emit({"processing": True})

    if mode == "mp3":
        opts = downloader.build_options("audio", "max", "mp3", False, DEST,
                                        section)
    elif mode == "h264":
        opts = downloader.build_options("video", "1080", "mp4", False, DEST,
                                        section)
        # privilegie H.264 (avc1) : import direct dans Premiere
        opts["format"] = (
            "bestvideo[vcodec^=avc1][height<=1080]+bestaudio[ext=m4a]"
            "/bestvideo[vcodec^=avc1][height<=1080]+bestaudio"
            "/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best")
    else:  # max
        opts = downloader.build_options("video", "max", "mp4", False, DEST,
                                        section)
    opts["outtmpl"] = outtmpl(mode, section)
    opts["progress_hooks"] = [hook]

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as e:
        if downloader.looks_like_auth_error(e) and not downloader.has_cookies():
            raise RuntimeError(
                f"{str(e)[:120]} | {downloader.COOKIES_HELP}") from e
        raise

    requested = info.get("requested_downloads") or [{}]
    path = requested[0].get("filepath")
    if not path or not os.path.isfile(path):
        raise RuntimeError("fichier telecharge introuvable")

    if mode != "mp3" and needs_transcode(path):
        emit({"transcode_start": True})
        path = transcode_for_premiere(path)

    emit({"done": True, "path": path, "title": info.get("title") or ""})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 - remonte au panneau
        emit({"error": str(e)[:300]})
        sys.exit(1)
