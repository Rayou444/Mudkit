"""Lanceur Mudkit.exe : demarre l'app depuis le dossier d'installation.

Compile en Mudkit.exe (PyInstaller --onefile --windowed). Son seul role
est de lancer le moteur Python sans fenetre console, avec la bonne icone au
niveau de l'executable. Meme recherche de Python que Mudkit.bat :
python\\ (version installee) d'abord, sinon .venv (PC de dev).
"""
import os
import subprocess
import sys

if getattr(sys, "frozen", False):
    ROOT = os.path.dirname(os.path.abspath(sys.executable))
else:
    ROOT = os.path.dirname(os.path.abspath(__file__))

main_py = os.path.join(ROOT, "main.py")
pythonw = next((p for p in (os.path.join(ROOT, "python", "pythonw.exe"),
                            os.path.join(ROOT, ".venv", "Scripts", "pythonw.exe"))
                if os.path.isfile(p)), None)

if not pythonw or not os.path.isfile(main_py):
    import ctypes
    ctypes.windll.user32.MessageBoxW(
        0,
        "Mudkit.exe doit rester dans son dossier d'installation "
        f"({ROOT}).\nUtilise un raccourci pour le Bureau.",
        "Mudkit", 0x10)
    sys.exit(1)

DETACHED = 0x00000008 | 0x00000200  # DETACHED_PROCESS | NEW_PROCESS_GROUP
subprocess.Popen([pythonw, "-E", "-s", main_py], cwd=ROOT,
                 creationflags=DETACHED, close_fds=True)
