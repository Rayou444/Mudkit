"""Pont Mudkit <-> panneau Premiere Pro.

Telecharge une video ou l'audio et garantit un fichier importable dans
Premiere (H.264/AAC en mp4) : si YouTube livre de l'AV1/VP9 ou un mkv,
conversion automatique. Progression en lignes JSON sur stdout.

Usage : python -u premiere_dl.py <url> <h264|max|mp3>
"""
import glob
import json
import os
import re
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


def needs_transcode(path):
    if os.path.splitext(path)[1].lower() != ".mp4":
        return True
    v, a, trc = converter.probe_streams(path)
    if v and v not in VIDEO_OK:
        return True
    if a and a not in AUDIO_OK:
        return True
    return converter.is_hdr(trc)


def transcode_for_premiere(path):
    """Rend le fichier importable dans Premiere (mp4 H.264/AAC). Remplace
    l'original.

    Le moins de travail possible : si la video est deja en H.264 / HEVC et
    seul le conteneur (mkv, webm) ou l'audio (Opus) gene, on garde l'image
    telle quelle (quelques secondes au lieu de minutes, aucune perte). Sinon
    reencodage (GPU NVENC si dispo), avec conversion HDR -> SDR si besoin."""
    base, _ = os.path.splitext(path)
    out = base + "_h264.mp4"
    if os.path.isfile(out):
        # deja converti (meme video, meme mode, meme passage : le nom le
        # garantit). Le reecrire casserait le plan deja pose dans le projet.
        os.remove(path)
        return out
    duration = converter._duration_seconds(path)  # noqa: SLF001
    v, a, trc = converter.probe_streams(path)
    hdr = converter.is_hdr(trc)

    def on_time(t):
        if duration:
            emit({"pct": min(t / duration, 1.0), "transcode": True})

    def run(vcodec, acodec):
        utils.run_ffmpeg(
            [utils.ffmpeg_path(), "-y", "-v", "error",
             "-progress", "pipe:1", "-nostats", "-i", path]
            + vcodec + acodec + ["-movflags", "+faststart", out],
            on_time=on_time, partial=out)

    audio = (["-c:a", "copy"] if a in AUDIO_OK or a is None
             else ["-c:a", "aac", "-b:a", "320k"])
    copied = False
    if v in ("h264", "hevc", "mpeg4") and not hdr:   # acceptes tels quels en mp4
        try:
            run(["-c:v", "copy"] + (["-tag:v", "hvc1"] if v == "hevc" else []), audio)
            copied = True
        except RuntimeError:
            pass  # conteneur recalcitrant : on reencode
    if not copied:
        vf = ["-vf", converter.TONEMAP if hdr else "format=yuv420p"]
        x264 = ["-c:v", "libx264", "-preset", "medium", "-crf", "16"] + vf
        if utils.nvenc_available():
            try:
                run(["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr",
                     "-cq", "19", "-b:v", "0"] + vf, audio)
            except RuntimeError:
                # NVENC refuse certaines sources (au-dela de 4096 px, ex. 8K) :
                # on refait au processeur plutot que d'echouer
                run(x264, audio)
        else:
            run(x264, audio)
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


# ------------------------------------------------------------ sous-titres

SUB_LANGS = ["fr", "fr-FR", "en", "en-US", "en-GB"]   # par ordre de preference
_TS = re.compile(r"(\d+):(\d\d):(\d\d)[,.](\d{1,3})")


def _secs(m):
    h, mi, s, ms = m.groups()
    return int(h) * 3600 + int(mi) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000


def _ts(sec):
    ms = int(round(max(0.0, sec) * 1000))
    return (f"{ms // 3600000:02}:{ms // 60000 % 60:02}:"
            f"{ms // 1000 % 60:02},{ms % 1000:03}")


def cut_srt(path, start, end):
    """Garde les sous-titres du passage [start, end] et les recale a 0 : le
    fichier de YouTube couvre toute la video, l'extrait commence a 0."""
    with open(path, encoding="utf-8", errors="replace") as f:
        blocks = re.split(r"\r?\n\s*\r?\n", f.read().strip())
    out = []
    for b in blocks:
        lines = b.splitlines()
        i = next((k for k, line in enumerate(lines) if "-->" in line), None)
        if i is None:
            continue
        a, z = lines[i].split("-->", 1)
        ma, mz = _TS.search(a), _TS.search(z)
        if not (ma and mz):
            continue
        s, e = _secs(ma), _secs(mz)
        if e <= start or s >= end:
            continue
        out.append(f"{len(out) + 1}\n{_ts(max(s, start) - start)} --> "
                   f"{_ts(min(e, end) - start)}\n" + "\n".join(lines[i + 1:]))
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n\n".join(out) + "\n")
    return bool(out)


def pick_subtitles(info, video_path):
    """Le .srt telecharge avec la video, francais d'abord, sinon None."""
    found = {}
    for lang, sub in (info.get("requested_subtitles") or {}).items():
        p = (sub or {}).get("filepath")
        if p:
            p = os.path.splitext(p)[0] + ".srt"
            if os.path.isfile(p):
                found[lang] = p
    if not found:  # filepath pas mis a jour apres conversion : on cherche
        base = os.path.splitext(video_path)[0]
        for p in glob.glob(glob.escape(base) + ".*.srt"):
            found[p.rsplit(".", 2)[-2]] = p
    for lang in SUB_LANGS + sorted(found):
        if lang in found:
            return found[lang]
    return None


def main():
    argv = [a for a in sys.argv[1:] if a != "--subs"]
    want_subs = "--subs" in sys.argv[1:]
    if len(argv) < 2:
        raise RuntimeError(
            "usage: premiere_dl.py <url> <h264|max|mp3> [debut fin] [--subs]")
    url, mode = argv[0], argv[1]
    section = None
    if len(argv) >= 4:
        section = (float(argv[2]), float(argv[3]))
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
    # un lien de playlist ou un carrousel : seulement le 1er element (avant,
    # tout le lot partait puis « fichier telecharge introuvable »)
    opts["playlist_items"] = "1"
    if want_subs and mode != "mp3":
        # sous-titres du site (sinon ceux generes automatiquement), en .srt
        opts.update({"writesubtitles": True, "writeautomaticsub": True,
                     "subtitleslangs": SUB_LANGS, "subtitlesformat": "srt/vtt/best"})
        opts.setdefault("postprocessors", []).append(
            {"key": "FFmpegSubtitlesConvertor", "format": "srt"})
    opts["progress_hooks"] = [hook]

    def attempt(o):
        with yt_dlp.YoutubeDL(o) as ydl:
            return ydl.extract_info(url, download=True)

    try:
        # cookies du navigateur illisibles : on reessaie sans (lien public)
        info = downloader.with_cookie_fallback(opts, attempt)
    except yt_dlp.utils.DownloadError as e:
        msg = downloader.friendly_error(e)
        if msg:
            raise RuntimeError(msg) from e
        raise

    if info.get("_type") == "playlist":
        info = next((e for e in info.get("entries") or [] if e), {})
    requested = info.get("requested_downloads") or [{}]
    path = requested[0].get("filepath")
    if not path or not os.path.isfile(path):
        raise RuntimeError("fichier telecharge introuvable")

    subs = pick_subtitles(info, path) if want_subs and mode != "mp3" else None
    if subs and section and not cut_srt(subs, *section):
        subs = None  # aucun sous-titre dans le passage

    if mode != "mp3" and needs_transcode(path):
        emit({"transcode_start": True})
        path = transcode_for_premiere(path)

    emit({"done": True, "path": path, "title": info.get("title") or "",
          "subs": subs, "nosubs": bool(want_subs and mode != "mp3" and not subs)})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 - remonte au panneau
        emit({"error": str(e)[:300]})
        sys.exit(1)
