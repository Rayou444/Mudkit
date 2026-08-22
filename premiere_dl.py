"""Pont Mudkit <-> panneau Premiere Pro.

Telecharge une video ou l'audio et garantit un fichier importable dans
Premiere (H.264/AAC en mp4) : si YouTube livre de l'AV1/VP9 ou un mkv,
conversion automatique. Progression en lignes JSON sur stdout.

Usage : python -u premiere_dl.py <url> <h264|max|mp3>
"""
import json
import os
import subprocess
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
    duration = converter._duration_seconds(path)  # noqa: SLF001
    base, _ = os.path.splitext(path)
    out = base + "_h264.mp4"
    if utils.nvenc_available():
        vcodec = ["-c:v", "h264_nvenc", "-preset", "p5",
                  "-rc", "vbr", "-cq", "19", "-b:v", "0"]
    else:
        vcodec = ["-c:v", "libx264", "-preset", "medium", "-crf", "16"]
    cmd = ([utils.ffmpeg_path(), "-y", "-v", "error",
            "-progress", "pipe:1", "-nostats", "-i", path]
           + vcodec
           + ["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "320k",
              "-movflags", "+faststart", out])
    proc = subprocess.Popen(
        cmd, creationflags=utils.NO_WINDOW,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace")
    for line in proc.stdout:
        line = line.strip()
        if duration and line.startswith("out_time_us="):
            try:
                pct = min(int(line.split("=")[1]) / 1e6 / duration, 1.0)
                emit({"pct": pct, "transcode": True})
            except ValueError:
                pass
    _, err = proc.communicate()
    if proc.returncode != 0 or not os.path.isfile(out):
        tail = (err or "echec ffmpeg").strip().splitlines()
        raise RuntimeError(tail[-1][:300] if tail else "echec ffmpeg")
    os.remove(path)
    return out


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
