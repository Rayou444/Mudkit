@echo off
title Installation de Mudkit
if not exist "%~dp0fichiers\install.ps1" goto :pas_extrait
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fichiers\install.ps1"
pause
exit /b

:pas_extrait
echo.
echo Il faut d'abord EXTRAIRE le zip : clic droit sur le zip, "Extraire tout",
echo puis relance "INSTALLER Mudkit.bat" depuis le dossier extrait.
echo.
pause
