# Construit le paquet d'installation autonome de Mudkit :
#   app + Python portable (aucune install requise) + panneau Premiere signe
#   + installateur double-clic. Resultat : packaging\dist\Mudkit-<version>.zip
#
#   powershell -ExecutionPolicy Bypass -File packaging\build.ps1 -Version v2.8.1
#
# Le Python embarque = le CPython de base du .venv (sans ses site-packages
# globaux ni les extras Doc/tcl/tests) + les site-packages du .venv.
param([string]$Version = "dev")
$ErrorActionPreference = "Stop"

$repo  = Split-Path $PSScriptRoot -Parent
$venv  = Join-Path $repo ".venv"
$base  = ((Get-Content (Join-Path $venv "pyvenv.cfg")) -match '^home\s*=')[0] -replace '^home\s*=\s*', ''
$dist  = Join-Path $PSScriptRoot "dist"
$name  = "Mudkit-$Version"
$stage = Join-Path $dist $name
$files = Join-Path $stage "fichiers"
$app   = Join-Path $files "Mudkit"
$zip   = Join-Path $dist "$name.zip"

function Copy-Tree($from, $to, [string[]]$extra) {
  robocopy $from $to /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP @extra | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $from -> $to (code $LASTEXITCODE)" }
}

Write-Output "Python de base : $base"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
if (Test-Path $zip)   { Remove-Item $zip -Force }
New-Item -ItemType Directory -Force $app | Out-Null

# 1. extension Premiere re-signee depuis src\ (et redeployee sur ce PC)
& (Join-Path $repo "premiere_ext\deployer.ps1") | Out-Null
$ext = Join-Path $files "com.mudkit.premiere"
$tmpZip = Join-Path $env:TEMP "mudkit_ext_pack.zip"
Copy-Item (Join-Path $repo "premiere_ext\Mudkit.zxp") $tmpZip -Force
Expand-Archive $tmpZip -DestinationPath $ext -Force
Remove-Item $tmpZip -Force

# 2. application (sans config.json / cookies.txt : propres a chaque PC)
foreach ($f in "main.py", "premiere_dl.py", "Mudkit.bat", "requirements.txt", "README.md") {
  Copy-Item (Join-Path $repo $f) $app
}
Copy-Tree (Join-Path $repo "mudkit") (Join-Path $app "mudkit") @("/XD", "__pycache__")
Copy-Tree (Join-Path $repo "assets") (Join-Path $app "assets")
Copy-Tree (Join-Path $repo "bin")    (Join-Path $app "bin") @("/XF", "input.jpg", "input2.jpg", "onepiece_demo.mp4")

# 3. Python portable
$py = Join-Path $app "python"
Copy-Tree $base $py @("/XD", (Join-Path $base "Lib\site-packages"), (Join-Path $base "Doc"),
  (Join-Path $base "include"), (Join-Path $base "libs"), (Join-Path $base "Scripts"),
  (Join-Path $base "share"), (Join-Path $base "tcl"), (Join-Path $base "Lib\test"),
  (Join-Path $base "Lib\idlelib"), (Join-Path $base "Lib\turtledemo"), "__pycache__",
  "/XF", "NEWS.txt")
Copy-Tree (Join-Path $venv "Lib\site-packages") (Join-Path $py "Lib\site-packages") @(
  "/XD", "__pycache__", "PyInstaller", "pyinstaller*", "_pyinstaller_hooks_contrib")

# 4. installateur + notice
Copy-Item (Join-Path $PSScriptRoot "installer\install.ps1")   $files
Copy-Item (Join-Path $PSScriptRoot "installer\uninstall.ps1") $files
Copy-Item (Join-Path $PSScriptRoot "installer\INSTALLER Mudkit.bat")    $stage
Copy-Item (Join-Path $PSScriptRoot "installer\Desinstaller Mudkit.bat") $stage
Copy-Item (Join-Path $PSScriptRoot "installer\LISEZ-MOI.txt") $stage
Set-Content (Join-Path $files "version.txt") $Version -Encoding ASCII

# 5. test : le Python embarque demarre seul et trouve toutes les dependances
# (-B : n'ecrit pas de __pycache__ dans le paquet)
$check = & (Join-Path $py "python.exe") -E -s -B -c "import sys, webview, yt_dlp, PIL, rembg, onnxruntime; print('PREFIX=' + sys.prefix)"
if ($LASTEXITCODE -ne 0) { throw "Python embarque KO" }
if (-not ($check -contains "PREFIX=$py")) { throw "Python embarque pointe ailleurs : $check" }
Write-Output "Python embarque OK"

# 6. zip
tar -a -c -f $zip -C $dist $name
if ($LASTEXITCODE -ne 0) { throw "zip echoue" }
Write-Output ("{0} ({1:N0} Mo)" -f $zip, ((Get-Item $zip).Length / 1MB))
