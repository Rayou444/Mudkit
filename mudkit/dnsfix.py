"""Resolveur DNS de secours (DNS-over-HTTPS).

Le DNS de la box peut etre en panne (UDP 53 muet) alors qu'Internet
fonctionne. Si le DNS systeme ne repond pas, on resout les noms via
DoH (Google puis Cloudflare, joints par IP directe) en remplacant
socket.getaddrinfo. Aucun reglage systeme n'est modifie.
"""
import json
import socket
import threading
import urllib.request

_real_getaddrinfo = socket.getaddrinfo
_cache = {}
_lock = threading.Lock()

DOH_ENDPOINTS = [
    "https://8.8.8.8/resolve",       # Google (API JSON)
    "https://1.1.1.1/dns-query",     # Cloudflare (API JSON)
]


def _is_ip(host):
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            socket.inet_pton(family, host)
            return True
        except OSError:
            pass
    return False


def _doh_resolve(host):
    with _lock:
        if host in _cache:
            return _cache[host]
    for base in DOH_ENDPOINTS * 2:  # deux tours : le reseau peut etre flaky
        try:
            req = urllib.request.Request(
                f"{base}?name={host}&type=A",
                headers={"Accept": "application/dns-json",
                         "User-Agent": "Mudkit/1.0"})
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.load(resp)
            ips = [a["data"] for a in data.get("Answer", [])
                   if a.get("type") == 1]
            if ips:
                with _lock:
                    _cache[host] = ips
                return ips
        except Exception:  # noqa: BLE001 - on passe au serveur suivant
            continue
    return []


_prefer_doh = False


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
    global _prefer_doh
    host_s = host.decode() if isinstance(host, bytes) else host
    if not host_s or not isinstance(host_s, str) or _is_ip(host_s) \
            or host_s.lower() == "localhost":
        return _real_getaddrinfo(host, port, family, type, proto, flags)

    if _prefer_doh:
        results = _via_ips(_doh_resolve(host_s), port, family, type,
                           proto, flags)
        if results:
            return results
        return _real_getaddrinfo(host, port, family, type, proto, flags)

    try:
        return _real_getaddrinfo(host, port, family, type, proto, flags)
    except OSError:
        _prefer_doh = True  # DNS systeme malade : DoH d'abord desormais
        results = _via_ips(_doh_resolve(host_s), port, family, type,
                           proto, flags)
        if results:
            return results
        raise


def activate_if_needed():
    """Installe le resolveur tolerant aux pannes (toujours actif :
    DNS systeme d'abord, bascule DoH automatique au premier echec)."""
    if socket.getaddrinfo is not _patched_getaddrinfo:
        socket.getaddrinfo = _patched_getaddrinfo
    return True
