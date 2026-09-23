@echo off
title Desinstallation de Mudkit
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fichiers\uninstall.ps1"
pause
