@echo off
rem Lance Mudkit sans fenetre console (python\ = version installee, .venv = dev)
set "PYW=%~dp0.venv\Scripts\pythonw.exe"
if exist "%~dp0python\pythonw.exe" set "PYW=%~dp0python\pythonw.exe"
start "" "%PYW%" -E -s "%~dp0main.py"
