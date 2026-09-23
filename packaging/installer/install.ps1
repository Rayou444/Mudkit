# Installe Mudkit + le panneau Premiere Pro pour l'utilisateur Windows courant.
# Lance par "INSTALLER Mudkit.bat". Rien a installer a cote : Python est embarque.
$ErrorActionPreference = "Stop"
$here    = $PSScriptRoot
$dest    = Join-Path $env:USERPROFILE "Mudkit"
$extDest = Join-Path $env:APPDATA "Adobe\CEP\extensions\com.mudkit.premiere"
$pyw     = Join-Path $dest "python\pythonw.exe"
$mainPy  = Join-Path $dest "main.py"

function Step($t) { Write-Host ""; Write-Host "==> $t" -ForegroundColor Cyan }
function Fail($t) { Write-Host ""; Write-Host "ERREUR : $t" -ForegroundColor Red; exit 1 }

$version = (Get-Content (Join-Path $here "version.txt") -ErrorAction SilentlyContinue) -join ""
Write-Host "Installation de Mudkit $version" -ForegroundColor White
Write-Host "Dossier : $dest"

if (Test-Path (Join-Path $dest ".git")) {
  Fail "$dest est le dossier de développement (git) : rien à installer sur ce PC."
}

# Premiere garde les fichiers du panneau ouverts
while (Get-Process "Adobe Premiere Pro" -ErrorAction SilentlyContinue) {
  Write-Host ""
  Write-Host "Premiere Pro est ouvert : ferme-le, puis appuie sur Entrée." -ForegroundColor Yellow
  [void](Read-Host)
}

# Mudkit deja lance (mise a jour) : on le ferme
Get-Process pythonw, python -ErrorAction SilentlyContinue | Where-Object {
  $_.Path -and $_.Path.StartsWith($dest, [StringComparison]::OrdinalIgnoreCase)
} | Stop-Process -Force -ErrorAction SilentlyContinue

Step "Copie de Mudkit (1 à 2 minutes)"
$src = Join-Path $here "Mudkit"
robocopy $src $dest /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP /XD (Join-Path $src "python") | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "copie de l'application impossible (robocopy $LASTEXITCODE)" }
# /MIR pour le Python embarque : pas de vieux paquets qui trainent apres une mise a jour
robocopy (Join-Path $src "python") (Join-Path $dest "python") /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "copie de Python impossible (robocopy $LASTEXITCODE)" }
# fichiers venus d'un zip telecharge : on retire la marque "provient d'Internet"
Get-ChildItem $dest -Recurse -File -Include *.exe, *.dll, *.pyd -ErrorAction SilentlyContinue |
  Unblock-File -ErrorAction SilentlyContinue

Step "Installation du panneau Premiere Pro"
if (Test-Path $extDest) { Remove-Item $extDest -Recurse -Force }
New-Item -ItemType Directory -Force (Split-Path $extDest) | Out-Null
Copy-Item (Join-Path $here "com.mudkit.premiere") $extDest -Recurse
# Certificat auto-signe sans horodatage : PlayerDebugMode evite que Premiere
# refuse le panneau (meme reglage que sur le PC de dev)
foreach ($v in 9..16) {
  $k = "HKCU:\Software\Adobe\CSXS.$v"
  if (-not (Test-Path $k)) { New-Item $k -Force | Out-Null }
  Set-ItemProperty $k -Name PlayerDebugMode -Value "1" -Type String
}

Step "Raccourcis (Bureau + menu Démarrer)"
$ws = New-Object -ComObject WScript.Shell
foreach ($folder in [Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs")) {
  if (-not $folder -or -not (Test-Path $folder)) { continue }
  $s = $ws.CreateShortcut((Join-Path $folder "Mudkit.lnk"))
  $s.TargetPath       = $pyw
  $s.Arguments        = "-E -s `"$mainPy`""
  $s.WorkingDirectory = $dest
  $s.IconLocation     = (Join-Path $dest "assets\mudkit.ico") + ",0"
  $s.Description      = "Mudkit"
  $s.Save()
}

# L'interface de Mudkit s'affiche via WebView2 (inclus dans Windows 11)
$wv = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
$hasWebView2 = @(
  "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$wv",
  "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$wv",
  "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$wv"
) | Where-Object {
  $pv = (Get-ItemProperty $_ -Name pv -ErrorAction SilentlyContinue).pv
  $pv -and $pv -ne "0.0.0.0"
}

Write-Host ""
Write-Host "Mudkit est installé !" -ForegroundColor Green
Write-Host " - Application : raccourci « Mudkit » sur le Bureau / menu Démarrer"
Write-Host " - Premiere Pro : Fenêtre > Extensions > Mudkit"
Write-Host " - Téléchargements : $(Join-Path $env:USERPROFILE 'Videos\Mudkit')"
if (-not $hasWebView2) {
  Write-Host ""
  Write-Host "ATTENTION : Microsoft WebView2 n'a pas été trouvé. Si la fenêtre de Mudkit" -ForegroundColor Yellow
  Write-Host "reste vide, installe-le : https://developer.microsoft.com/microsoft-edge/webview2/" -ForegroundColor Yellow
}

Write-Host ""
$r = Read-Host "Lancer Mudkit maintenant ? (O/N)"
if ($r -match '^[oOyY]') {
  Start-Process $pyw -ArgumentList "-E", "-s", "`"$mainPy`"" -WorkingDirectory $dest
}
