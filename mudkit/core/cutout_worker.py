"""Processus de detourage, lance par l'appli (cutout.spawn_worker).

    python -m mudkit.core.cutout_worker '{"files": [...], "model": "hair",
                                          "gpu": true, "crop": false}'

Une ligne JSON par evenement sur stdout :
    {"i": 0, "phase": "model", "pct": 0.4}   telechargement du modele
    {"i": 0, "phase": "gpu", "pct": 0.4}     module carte graphique (1re fois)
    {"i": 0, "phase": "run"}
    {"i": 0, "ok": true, "out": "...", "gpu": true, "secs": 4.2}
    {"i": 0, "ok": false, "error": "...", "detail": "trace"}
    {"note": "..."}                          (journalise par l'appli)
    {"end": true}
Annuler = tuer ce processus (l'appli le fait) : rien a surveiller ici.
"""
import json
import sys
import time
import traceback


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    job = json.loads(sys.argv[1])
    from mudkit.core import cutout
    gpu = bool(job.get("gpu"))
    if gpu:
        try:
            if not cutout.gpu_runtime_ready():
                last = [0.0]

                def prog(done, total):
                    now = time.monotonic()
                    if total and now - last[0] > 0.2:
                        last[0] = now
                        emit({"i": 0, "phase": "gpu", "pct": done / total})
                emit({"i": 0, "phase": "gpu", "pct": 0.0})
                cutout.install_gpu_runtime(prog)
            # avant tout import d'onnxruntime : la version DirectML passe devant
            sys.path.insert(0, cutout.DML_DIR)
        except Exception as e:  # noqa: BLE001 - on detoure sur le processeur
            emit({"note": f"carte graphique indisponible : {e}"})
            gpu = False

    for i, src in enumerate(job["files"]):
        last = [0.0]

        def notify(phase, pct, i=i):
            now = time.monotonic()
            if phase == "model" and pct not in (None, 0.0) and now - last[0] < 0.2:
                return
            last[0] = now
            emit({"i": i, "phase": phase, "pct": pct})
        try:
            t = time.monotonic()
            out, used = cutout.cutout_one(src, job.get("model"), notify,
                                          lambda: False, gpu=gpu,
                                          crop=bool(job.get("crop")))
            emit({"i": i, "ok": True, "out": out, "gpu": used,
                  "secs": round(time.monotonic() - t, 1)})
        except MemoryError:
            emit({"i": i, "ok": False,
                  "error": "mémoire insuffisante pour cette image (essaie le modèle Rapide)"})
        except Exception as e:  # noqa: BLE001
            emit({"i": i, "ok": False, "error": str(e)[:300],
                  "detail": traceback.format_exc()[-2000:]})
    emit({"end": True})


if __name__ == "__main__":
    main()
