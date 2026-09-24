"""Historique des telechargements (%LOCALAPPDATA%\\Mudkit\\history.json).

Survit aux fermetures de l'appli, contrairement a la file d'attente.
Les plus recents en tete, plafonne a MAX_ITEMS.
"""
import json
import os
import threading
import time

from . import utils

PATH = os.path.join(utils.DATA_DIR, "history.json")
MAX_ITEMS = 300
_lock = threading.Lock()


def _load():
    try:
        with open(PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _save(items):
    os.makedirs(utils.DATA_DIR, exist_ok=True)
    utils.write_json(PATH, items[:MAX_ITEMS])


def add(entry):
    """Ajoute une entree (dict) et la renvoie completee (id, date)."""
    entry = dict(entry, id=f"{time.time_ns():x}", ts=int(time.time()))
    with _lock:
        items = _load()
        items.insert(0, entry)
        _save(items)
    return entry


def items():
    """Entrees, avec `exists` : le fichier est-il encore sur le disque ?"""
    with _lock:
        data = _load()
    for it in data:
        it["exists"] = any(os.path.exists(p) for p in it.get("files") or [])
    return data


def remove(entry_id):
    with _lock:
        _save([it for it in _load() if it.get("id") != entry_id])
    return True


def clear():
    with _lock:
        _save([])
    return True
