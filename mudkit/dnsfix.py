"""Resolveur DNS de secours (DNS-over-HTTPS).

Le DNS de la box peut etre en panne (UDP 53 muet) alors qu'Internet
fonctionne. Si le DNS systeme ne repond pas, on resout les noms via
DoH (Google puis Cloudflare, joints par IP directe) en remplacant
socket.getaddrinfo. Aucun reglage systeme n'est modifie.
"""
import json
import socket
import threading
import time
import urllib.request

_real_getaddrinfo = socket.getaddrinfo
_cache = {}          # host -> (ips, expiration) ; ips vide = echec memorise
_lock = threading.Lock()

DOH_ENDPOINTS = [
    "https://8.8.8.8/resolve",       # Google (API JSON)
    "https://1.1.1.1/dns-query",     # Cloudflare (API JSON)
]
CACHE_TTL = 30 * 60     # une adresse resolue sert 30 min
FAIL_TTL = 60           # un echec est retenu 1 min : pas 20 s d'attente a chaque appel
PREFER_TTL = 10 * 60    # apres une panne du DNS systeme, on le reessaie au bout de 10 min


def _is_ip(host):
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            socket.inet_pton(family, host)
            return True
        except OSError:
            pass
    return False


def _doh_resolve(host):
    now = time.monotonic()
    with _lock:
        hit = _cache.get(host)
        if hit and hit[1] > now:
            return hit[0]
    ips = []
    for base in DOH_ENDPOINTS * 2:  # deux tours : le reseau peut etre flaky
        try:
            req = urllib.request.Request(
                f"{base}?name={host}&type=A",
                headers={"Accept": "application/dns-json",
                         "User-Agent": "Mudkit/1.0"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.load(resp)
            ips = [a["data"] for a in data.get("Answer", [])
                   if a.get("type") == 1]
            if ips or data.get("Status") == 3:   # 3 = NXDOMAIN : inutile d'insister
                break
        except Exception:  # noqa: BLE001 - on passe au serveur suivant
            continue
    with _lock:
        _cache[host] = (ips, now + (CACHE_TTL if ips else FAIL_TTL))
    return ips


_prefer_doh_until = 0.0


def _via_ips(ips, port, family, type, proto, flags):
    results = []
    for ip in ips:
        try:
            results.extend(_real_getaddrinfo(
                ip, port, family, type, proto, flags))
        except OSError:
            pass
    return results


def _patched_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    global _prefer_doh_until
    host_s = host.decode() if isinstance(host, bytes) else host
    if (not host_s or not isinstance(host_s, str) or _is_ip(host_s)
            or host_s.lower() == "localhost"):
        return _real_getaddrinfo(host, port, family, type, proto, flags)

    if time.monotonic() < _prefer_doh_until:
        results = _via_ips(_doh_resolve(host_s), port, family, type,
                           proto, flags)
        if results:
            return results
        return _real_getaddrinfo(host, port, family, type, proto, flags)

    try:
        return _real_getaddrinfo(host, port, family, type, proto, flags)
    except OSError:
        results = _via_ips(_doh_resolve(host_s), port, family, type,
                           proto, flags)
        if results:
            # Le DNS systeme a echoue LA ou DoH reussit : il est malade, on
            # passe par DoH un moment. Avant, un seul nom introuvable (lien
            # mal tape, Wi-Fi pas encore pret) basculait toute la session.
            _prefer_doh_until = time.monotonic() + PREFER_TTL
            return results
        raise


def activate_if_needed():
    """Installe le resolveur tolerant aux pannes (toujours actif :
    DNS systeme d'abord, bascule DoH automatique au premier echec)."""
    if socket.getaddrinfo is not _patched_getaddrinfo:
        socket.getaddrinfo = _patched_getaddrinfo
    return True
