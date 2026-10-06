"""Logique du telechargeur YouTube (yt-dlp), sans interface."""
import base64
import os
import time
import urllib.request

from .. import utils


Cancelled = utils.CancelledError

# cookies exportes par l'utilisateur (extension "Get cookies.txt LOCALLY")
COOKIES_FILE = os.path.join(utils.ROOT, "cookies.txt")

# Navigateurs dont yt-dlp sait lire les cookies (Parametres > Cookies).
# Firefox est le plus fiable sous Windows : depuis 2024, Chrome et Edge
# chiffrent leurs cookies d'une facon que yt-dlp ne sait pas toujours lire.
BROWSERS = ("firefox", "chrome", "edge", "brave", "opera", "vivaldi")

# Expressions entieres : l'ancien mot-cle "age" trouvait aussi "webpage" et
# "message", si bien qu'une simple erreur 404 ou une panne reseau etait
# presentee comme « ce lien demande d'etre connecte ».
_AUTH_HINTS = ("sign in", "log in", "login required", "logged in",
               "logged-in", "use --cookies", "cookies-from-browser",
               "private video", "video is private", "age-restricted",
               "age restricted", "confirm your age",
               "inappropriate for some users", "members-only",
               "members only", "join this channel", "subscriber",
               "requires authentication", "not a bot", "connexion")

_COOKIE_READ_HINTS = ("cookie database", "decrypt", "dpapi",
                      "could not find", "failed to load cookies")


def cookies_browser():
    b = (utils.load_config().get("cookies_browser") or "").lower()
    return b if b in BROWSERS else ""


def cookie_options():
    """Options yt-dlp pour les cookies : le navigateur choisi dans les
    Parametres d'abord, sinon cookies.txt s'il existe."""
    b = cookies_browser()
    if b:
        return {"cookiesfrombrowser": (b,)}
    if os.path.isfile(COOKIES_FILE):
        return {"cookiefile": COOKIES_FILE}
    return {}


def is_cookie_read_error(e):
    low = str(e).lower()
    return "cookie" in low and any(h in low for h in _COOKIE_READ_HINTS)


def with_cookie_fallback(opts, fn):
    """fn(opts) avec les cookies du navigateur SEULEMENT si le lien les
    demande. On essaie d'abord sans (cookies.txt garde, il ne coute rien) :
    lire les cookies de Chrome / Edge / Brave prend du temps et echoue
    souvent (navigateur ouvert, chiffrement depuis 2024), et une video
    publique n'en a pas besoin. Avant, chaque analyse et chaque
    telechargement commencaient par cette lecture, souvent ratee.
    Si le lien demande d'etre connecte, on recommence avec les cookies ; si
    ceux-ci sont illisibles, c'est cette erreur qui remonte (friendly_error
    en fait un message clair)."""
    import yt_dlp
    if "cookiesfrombrowser" not in opts:
        return fn(opts)
    plain = dict(opts)
    plain.pop("cookiesfrombrowser", None)
    if os.path.isfile(COOKIES_FILE):
        plain["cookiefile"] = COOKIES_FILE
    try:
        return fn(plain)
    except yt_dlp.utils.DownloadError as e:
        if not looks_like_auth_error(e):
            raise
        first = e
    try:
        return fn(opts)
    except yt_dlp.utils.DownloadError as e2:
        if is_cookie_read_error(e2):
            raise
        raise e2 from first


def looks_like_auth_error(msg):
    low = str(msg).lower()
    return any(h in low for h in _AUTH_HINTS)


def friendly_error(e):
    """Message clair quand l'utilisateur peut agir (cookies a fournir,
    cookies illisibles), sinon None. L'aide passe seule et en entier :
    avant, elle suivait l'erreur brute et sa fin (le chemin de cookies.txt)
    etait coupee a l'affichage."""
    low = str(e).lower()
    b = cookies_browser()
    if b and "cookie" in low and any(h in low for h in _COOKIE_READ_HINTS):
        return (f"Impossible de lire les cookies de {b.capitalize()}. "
                "Ferme le navigateur puis relance, ou choisis Firefox dans "
                "Paramètres > Cookies (Chrome et Edge chiffrent leurs "
                "cookies depuis 2024).")
    if not looks_like_auth_error(low):
        return None
    if b:
        return (f"Ce lien demande d'être connecté, et les cookies de "
                f"{b.capitalize()} n'ont pas suffi : vérifie que tu es "
                "connecté à ce site dans ce navigateur, puis relance.")
    return ("Ce lien demande d'être connecté. Dans Paramètres > Cookies, "
            "choisis le navigateur où tu es connecté au site (Firefox "
            f"conseillé), ou dépose un cookies.txt ici : {COOKIES_FILE}")


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


def analyze(url, single=False):
    """Retourne les infos d'une video ou d'une playlist (sans telecharger).
    single : un lien « video + playlist » (Mix YouTube) = la video seule."""
    import yt_dlp
    opts = {"quiet": True, "no_warnings": True, "noplaylist": single,
            "extract_flat": "in_playlist", "playlist_items": "1:500",
            # memes cookies que le telechargement : sinon une video +18 ou
            # reservee aux membres echouait des l'analyse
            **cookie_options()}
    def extract(o):
        with yt_dlp.YoutubeDL(o) as ydl:
            return ydl.extract_info(url, download=False)
    try:
        info = with_cookie_fallback(opts, extract)
    except yt_dlp.utils.DownloadError as e:
        msg = friendly_error(e)
        if msg:
            raise RuntimeError(msg) from e
        raise

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
            "thumb": thumb_data_uri(info.get("thumbnail")),
            "preview": preview_streams(info)}


# ------------------------------------------------- apercu avant passage

_DIRECT = ("https", "http")


def _direct(f):
    """Format lisible tel quel par un lecteur web : un seul fichier en
    http(s) (pas de m3u8 / DASH en morceaux), sans DRM, ni cookies requis."""
    return (f.get("protocol") in _DIRECT and f.get("url")
            and not f.get("has_drm") and f.get("ext") in ("mp4", "webm", "m4a")
            and "Cookie" not in (f.get("http_headers") or {})
            and f.get("format_note") != "storyboard")


def _has(f, kind):
    c = f.get(kind)
    return bool(c) and c != "none"


def _vscore(f):
    """Petite image d'abord (360-480p : apercu fluide, charge vite), H.264
    de preference (lu partout), VP9 ensuite."""
    h = f.get("height") or 0
    codec = (f.get("vcodec") or "").lower()
    pref = 0 if codec.startswith(("avc", "h264")) else (
        1 if codec.startswith(("vp9", "vp09", "vp8")) else 3)
    size = abs(h - 400) if h else 300
    return (pref, size)


def preview_streams(info):
    """Flux pour l'apercu du passage : image (basse definition) + son si
    l'image est muette (YouTube separe les deux), et planche de vignettes
    pour la barre de temps. None si le site n'offre rien de lisible
    directement : on peut alors toujours taper les temps."""
    fmts = [f for f in (info.get("formats") or []) if isinstance(f, dict)]
    out = {"fps": info.get("fps") or None, "storyboard": _storyboard(fmts)}
    both = [f for f in fmts if _direct(f) and _has(f, "vcodec") and _has(f, "acodec")]
    if both:
        out["video"] = min(both, key=_vscore)["url"]
        out["audio"] = None
        return out
    vid = [f for f in fmts if _direct(f) and _has(f, "vcodec") and not _has(f, "acodec")
           and (f.get("height") or 0) <= 1080]
    aud = [f for f in fmts if _direct(f) and _has(f, "acodec") and not _has(f, "vcodec")]
    if not vid:
        return out if out["storyboard"] else None
    out["video"] = min(vid, key=_vscore)["url"]
    if aud:
        # AAC (m4a) d'abord, lu partout ; puis le debit le plus bas suffisant
        def ascore(f):
            codec = (f.get("acodec") or "").lower()
            return (0 if codec.startswith("mp4a") else 1, abs((f.get("abr") or 128) - 128))
        out["audio"] = min(aud, key=ascore)["url"]
    else:
        out["audio"] = None
    return out


def _storyboard(fmts):
    """Planche de vignettes YouTube (format "sb") la plus proche de 160 px de
    large : images de la video regulierement espacees, en mosaique."""
    sbs = [f for f in fmts if f.get("format_note") == "storyboard"
           and f.get("fragments") and f.get("rows") and f.get("columns")
           and f.get("width") and f.get("fps")]
    if not sbs:
        return None
    f = min(sbs, key=lambda f: abs((f.get("width") or 0) - 160))
    return {"sheets": [fr["url"] for fr in f["fragments"] if fr.get("url")],
            "w": f["width"], "h": f["height"], "rows": f["rows"],
            "cols": f["columns"], "fps": f["fps"]}


TITLE = "%(title).150B"


def build_options(mode, quality, container, playlist, dest, section=None):
    opts = {
        # titre coupe a 150 octets : un titre de 300 caracteres (Reddit...)
        # depassait la limite de Windows et l'ecriture echouait
        "outtmpl": os.path.join(dest, TITLE + ".%(ext)s"),
        "noplaylist": not playlist,
        "quiet": True,
        "noprogress": True,
        "no_warnings": True,
        "concurrent_fragment_downloads": 4,
    }
    if playlist:  # une video supprimee / bloquee ne stoppe pas la playlist
        opts["ignoreerrors"] = True
    if utils.has_ffmpeg():
        opts["ffmpeg_location"] = utils.BIN_DIR
        utils.ensure_ffmpeg_on_path()
    opts.update(cookie_options())  # liens qui demandent d'etre connecte
    if section:  # ne telecharge que le passage demande (start, end) en s
        from yt_dlp.utils import download_range_func
        opts["download_ranges"] = download_range_func([], [tuple(section)])
        opts["force_keyframes_at_cuts"] = True  # coupes exactes
    if mode == "video":
        if quality == "max":
            opts["format"] = "bestvideo+bestaudio/best"
        else:
            h = int(quality)
            # "<=?" : un format sans hauteur connue (lien direct vers un
            # .mp4) n'est plus exclu ; "/best" en dernier recours
            opts["format"] = (f"bestvideo[height<=?{h}]+bestaudio"
                              f"/best[height<=?{h}]/best")
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
        if is_cancelled():  # le seul type que yt-dlp ne rattrape jamais
            raise yt_dlp.utils.DownloadCancelled()
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

    def pp_hook(d):
        # Annuler pendant la fusion / l'extraction audio : on s'arrete a
        # l'etape suivante au lieu d'aller au bout
        if is_cancelled():
            raise yt_dlp.utils.DownloadCancelled()

    opts = build_options(mode, quality, container, playlist, dest, section)
    opts["progress_hooks"] = [hook]
    opts["postprocessor_hooks"] = [pp_hook]
    if section:
        # un passage est telecharge par ffmpeg, sans progression detaillee :
        # l'interface affiche une barre d'attente plutot que rien
        progress({"phase": "section"})
    def attempt(o, dest=dest):
        with yt_dlp.YoutubeDL(o) as ydl:
            # extraction puis telechargement en deux temps (comme le fait
            # extract_info) pour choisir un nom libre entre les deux
            info = ydl.extract_info(url, download=False, process=False)
            # un lien « video + Mix » renvoie d'abord un simple renvoi vers
            # la video : on le suit, sinon l'anti-doublon de nom etait saute
            for _ in range(3):
                if info.get("_type") != "url" or not info.get("url"):
                    break
                info = ydl.extract_info(info["url"], download=False,
                                        process=False)
            kind = info.get("_type", "video")
            # n'ignorer les erreurs (video supprimee...) que pour une vraie
            # playlist : sur une video seule, l'erreur doit remonter au lieu
            # d'un « termine » sans fichier
            ydl.params["ignoreerrors"] = playlist and kind == "playlist"
            if kind == "video":
                _avoid_name_clash(ydl, info, dest)
            elif playlist and kind == "playlist":
                dest = _playlist_folder(ydl, info, dest)
            return ydl.process_ie_result(info, download=True), dest

    try:
        info, dest = with_cookie_fallback(opts, attempt)
    except yt_dlp.utils.DownloadCancelled:
        raise Cancelled() from None
    except yt_dlp.utils.DownloadError as e:
        msg = friendly_error(e)
        if msg:
            raise RuntimeError(msg) from e
        raise
    if not info:
        raise RuntimeError("rien n'a pu être téléchargé (lien privé, "
                           "supprimé ou coupure réseau)")
    files = _output_files(info)
    total = failed = 0
    if info.get("_type") == "playlist":
        entries = info.get("entries") or []
        total = len(entries)
        failed = sum(1 for e in entries
                     if not (e or {}).get("requested_downloads"))
        if total and failed == total:
            raise RuntimeError("Aucune vidéo de la playlist n'a pu être "
                               "téléchargée (supprimées ou bloquées).")
    return {"title": info.get("title") or "?", "dest": dest,
            "files": files, "thumb": info.get("thumbnail"),
            "total": total, "failed": failed}


def _avoid_name_clash(ydl, info, dest):
    """Deux videos au meme titre : yt-dlp croirait la 2e deja telechargee
    et ne ferait rien. Si le nom est pris (quelle que soit l'extension),
    on bascule sur « titre (2) », « titre (3) »..."""
    base = os.path.basename(ydl.prepare_filename(
        info, outtmpl=os.path.join(dest, TITLE)))
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
        dest, f"{TITLE} ({n}).%(ext)s")


def _playlist_folder(ydl, info, dest):
    """Une playlist va dans son propre sous-dossier, au nom de la playlist.
    Si le dossier existe deja (meme playlist relancee), on le reutilise :
    les videos deja presentes sont sautees par yt-dlp."""
    folder = ydl.prepare_filename(
        info, outtmpl=os.path.join(dest, "%(title,id).120B"))
    # numero devant le titre : des videos au meme titre (stories Instagram
    # « Video by X », plusieurs « Intro ») n'etaient telechargees qu'une
    # fois, les autres comptees comme reussies. Garde aussi l'ordre.
    ydl.params["outtmpl"]["default"] = os.path.join(
        folder, "%(playlist_index)03d - " + TITLE + ".%(ext)s")
    return folder


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
