# Desinstalle Mudkit + le panneau Premiere Pro. Garde les fichiers telecharges
# (Videos\Mudkit). Lance par "Desinstaller Mudkit.bat".
$ErrorActionPreference = "Stop"
$dest    = Join-Path $env:USERPROFILE "Mudkit"
$extDest = Join-Path $env:APPDATA "Adobe\CEP\extensions\com.mudkit.premiere"
$models  = Join-Path $env:USERPROFILE ".rembg"

if (Test-Path (Join-Path $dest ".git")) {
  Write-Host "$dest est le dossier de développement (git) : désinstallation refusée." -ForegroundColor Red
  exit 1
}

$r = Read-Host "Désinstaller Mudkit et son panneau Premiere Pro ? (O/N)"
if ($r -notmatch '^[oOyY]') { exit 0 }

while (Get-Process "Adobe Premiere Pro" -ErrorAction SilentlyContinue) {
  Write-Host "Premiere Pro est ouvert : ferme-le, puis appuie sur Entrée." -ForegroundColor Yellow
  [void](Read-Host)
}
Get-Process pythonw, python -ErrorAction SilentlyContinue | Where-Object {
  $_.Path -and $_.Path.StartsWith($dest, [StringComparison]::OrdinalIgnoreCase)
} | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

foreach ($p in $dest, $extDest, (Join-Path $env:LOCALAPPDATA "Mudkit"),
               (Join-Path ([Environment]::GetFolderPath("Desktop")) "Mudkit.lnk"),
               (Join-Path ([Environment]::GetFolderPath("Programs")) "Mudkit.lnk")) {
  if (Test-Path $p) { Remove-Item $p -Recurse -Force; Write-Host "supprimé : $p" }
}

if (Test-Path $models) {
  $r = Read-Host "Supprimer aussi les modèles de détourage IA téléchargés ($models, ~1 Go) ? (O/N)"
  if ($r -match '^[oOyY]') { Remove-Item $models -Recurse -Force; Write-Host "supprimé : $models" }
}

Write-Host ""
Write-Host "Mudkit est désinstallé. Tes téléchargements restent dans Videos\Mudkit." -ForegroundColor Green
