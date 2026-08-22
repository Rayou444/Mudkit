"""Lanceur Mudkit.exe : demarre l'app depuis le dossier d'installation.

Compile en Mudkit.exe (PyInstaller --onefile --windowed). Son seul role
est de lancer le moteur Python embarque sans fenetre console, avec la
bonne icone au niveau de l'executable.
"""
import os
import subprocess
import sys

if getattr(sys, "frozen", False):
    ROOT = os.path.dirname(os.path.abspath(sys.executable))
else:
    ROOT = os.path.dirname(os.path.abspath(__file__))

pythonw = os.path.join(ROOT, ".venv", "Scripts", "pythonw.exe")
main_py = os.path.join(ROOT, "main.py")

if not os.path.isfile(pythonw) or not os.path.isfile(main_py):
    import ctypes
    ctypes.windll.user32.MessageBoxW(
        0,
        "Mudkit.exe doit rester dans son dossier d'installation "
        "(C:\\Users\\Rayan\\Mudkit).\nUtilise un raccourci pour le Bureau.",
        "Mudkit", 0x10)
    sys.exit(1)

DETACHED = 0x00000008 | 0x00000200  # DETACHED_PROCESS | NEW_PROCESS_GROUP
subprocess.Popen([pythonw, main_py], cwd=ROOT, creationflags=DETACHED,
                 close_fds=True)
