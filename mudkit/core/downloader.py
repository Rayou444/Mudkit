"""Logique du telechargeur YouTube (yt-dlp), sans interface."""
import base64
import os
import time
import urllib.request

from .. import utils


Cancelled = utils.CancelledError

# cookies exportes par l'utilisateur (extension "Get cookies.txt LOCALLY")
COOKIES_FILE = os.path.join(utils.ROOT, "cookies.txt")

_AUTH_HINTS = ("sign in", "log in", "login", "logged", "cookies", "cookie",
               "private", "age", "account", "members", "subscriber",
               "authentication", "restricted", "connexion", "not a bot")

COOKIES_HELP = (
    "Ce lien semble demander une connexion. Solution : installe "
    "l'extension \u00ab Get cookies.txt LOCALLY \u00bb dans ton navigateur, "
    "va sur le site concerne (connecte), exporte, et enregistre le fichier "
    f"sous {COOKIES_FILE} — puis relance.")


def has_cookies():
    return os.path.isfile(COOKIES_FILE)


def looks_like_auth_error(msg):
    low = str(msg).lower()
    return any(h in low for h in _AUTH_HINTS)


def _fmt_duration(sec):
    if not sec:
        return ""
    sec = int(sec)
    h, r = divmod(sec, 3600)
    m, s = divmod(r, 60)
    return f"{h}:{m:02}:{s:02}" if h else f"{m}:{s:02}"


def thumb_data_uri(url):
    """Recupere une miniature cote Python (profite du secours DNS)."""
    if not url:
        return None
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = r.read(2_000_000)
        mime = "image/webp" if ".webp" in url else "image/jpeg"
        return f"data:{mime};base64,{base64.b64encode(data).decode()}"
    except Exception:  # noqa: BLE001 - miniature facultative
        return None


def analyze(url):
    """Retourne les infos d'une video ou d'une playlist (sans telecharger)."""
    import yt_dlp
    opts = {"quiet": True, "no_warnings": True,
            "extract_flat": "in_playlist", "playlist_items": "1:500"}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)

    if info.get("_type") == "playlist":
        entries = [e for e in (info.get("entries") or []) if e]
        thumb = None
        for e in entries[:3]:
            cand = e.get("thumbnails")
            cand = cand[-1]["url"] if cand else e.get("thumbnail")
            thumb = thumb_data_uri(cand)
            if thumb:
                break
        return {"kind": "playlist", "title": info.get("title") or "Playlist",
                "channel": info.get("uploader") or info.get("channel") or "",
                "count": len(entries), "thumb": thumb}

    return {"kind": "video", "title": info.get("title") or "?",
            "channel": info.get("uploader") or info.get("channel") or "",
            "duration": _fmt_duration(info.get("duration")),
            "duration_s": info.get("duration") or 0,
            "thumb": thumb_data_uri(info.get("thumbnail"))}


def build_options(mode, quality, container, playlist, dest, section=None):
    opts = {
        "outtmpl": os.path.join(dest, "%(title)s.%(ext)s"),
        "noplaylist": not playlist,
        "quiet": True,
        "noprogress": True,
        "no_warnings": True,
        "concurrent_fragment_downloads": 4,
    }
    if utils.has_ffmpeg():
        opts["ffmpeg_location"] = utils.BIN_DIR
        utils.ensure_ffmpeg_on_path()
    if has_cookies():  # debloque les liens qui demandent d'etre connecte
        opts["cookiefile"] = COOKIES_FILE
    if section:  # ne telecharge que le passage demande (start, end) en s
        from yt_dlp.utils import download_range_func
        opts["download_ranges"] = download_range_func([], [tuple(section)])
        opts["force_keyframes_at_cuts"] = True  # coupes exactes
    if mode == "video":
        if quality == "max":
            opts["format"] = "bestvideo+bestaudio/best"
        else:
            h = int(quality)
            opts["format"] = (f"bestvideo[height<={h}]+bestaudio"
                              f"/best[height<={h}]")
        opts["merge_output_format"] = container
    else:
        opts["format"] = "bestaudio/best"
        opts["postprocessors"] = [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": container,
            "preferredquality": "0",
        }]
    return opts


def download(url, mode, quality, container, playlist, dest,
             progress, is_cancelled, section=None):
    """Telecharge `url`. progress(dict) est appele regulierement.

    Leve Cancelled si is_cancelled() devient vrai.
    """
    import yt_dlp
    os.makedirs(dest, exist_ok=True)
    last_emit = [0.0]

    def hook(d):
        if is_cancelled():
            raise Cancelled()
        now = time.monotonic()
        if d["status"] == "downloading":
            if now - last_emit[0] < 0.15:
                return
            last_emit[0] = now
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes") or 0
            info = d.get("info_dict") or {}
            progress({
                "phase": "downloading",
                "pct": (done / total) if total else None,
                "done": utils.human_size(done),
                "total": utils.human_size(total) if total else "?",
                "speed": (utils.human_size(d["speed"]) + "/s")
                         if d.get("speed") else "",
                "eta": d.get("eta"),
                "item": info.get("playlist_index"),
                "item_count": info.get("n_entries"),
            })
        elif d["status"] == "finished":
            progress({"phase": "processing"})

    opts = build_options(mode, quality, container, playlist, dest, section)
    opts["progress_hooks"] = [hook]
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            # extraction puis telechargement en deux temps (comme le fait
            # extract_info) pour choisir un nom libre entre les deux
            info = ydl.extract_info(url, download=False, process=False)
            if info.get("_type", "video") == "video":
                _avoid_name_clash(ydl, info, dest)
            info = ydl.process_ie_result(info, download=True)
    except yt_dlp.utils.DownloadError as e:
        if looks_like_auth_error(e) and not has_cookies():
            raise RuntimeError(f"{str(e)[:150]}\n{COOKIES_HELP}") from e
        raise
    info = info or {}
    return {"title": info.get("title") or "?", "dest": dest,
            "files": _output_files(info), "thumb": info.get("thumbnail")}


def _avoid_name_clash(ydl, info, dest):
    """Deux videos au meme titre : yt-dlp croirait la 2e deja telechargee
    et ne ferait rien. Si le nom est pris (quelle que soit l'extension),
    on bascule sur « titre (2) », « titre (3) »..."""
    base = os.path.basename(ydl.prepare_filename(
        info, outtmpl=os.path.join(dest, "%(title)s")))
    try:
        taken = {os.path.splitext(n)[0].lower() for n in os.listdir(dest)}
    except OSError:
        return
    if base.lower() not in taken:
        return
    n = 2
    while f"{base} ({n})".lower() in taken:
        n += 1
    ydl.params["outtmpl"]["default"] = os.path.join(
        dest, f"%(title)s ({n}).%(ext)s")


def _output_files(info):
    """Chemins finaux (apres fusion / extraction audio) des fichiers crees."""
    entries = info.get("entries") if info.get("_type") == "playlist" else None
    out = []
    for it in (entries or [info]):
        for d in (it or {}).get("requested_downloads") or []:
            p = d.get("filepath")
            if p and p not in out:
                out.append(p)
    return out
