# Construit les paquets d'une release de Mudkit (version lue dans
# mudkit\__init__.py) :
#   dist\Mudkit-vX.Y.Z.zip          installation complete (Python embarque,
#                                   bin\, panneau Premiere, installateur)
#   dist\Mudkit-update-vX.Y.Z.zip   le code seul + le panneau : mise a jour
#                                   automatique depuis l'appli
#   dist\Mudkit-Premiere-vX.Y.Z.zxp le panneau signe, seul
#
#   powershell -ExecutionPolicy Bypass -File packaging\build.ps1 [-Publish]
#
# -Publish cree la release GitHub (commit + push avant !), avec
# packaging\notes\vX.Y.Z.md comme texte s'il existe.
#
# Python embarque = le CPython de base du .venv (sans Doc/tcl/tests) dans
# lequel on installe requirements.txt, aux versions exactes du .venv
# (contraintes = pip freeze) : meme comportement que sur le PC de dev, sans
# les paquets de dev. Changer requirements.txt => incrementer
# packaging\runtime.txt : les installations existantes devront repasser
# par l'installateur complet (la mise a jour auto ne remplace que le code).
param([string]$Version, [switch]$Publish)
$ErrorActionPreference = "Stop"

$repo = Split-Path $PSScriptRoot -Parent
$ver  = [regex]::Match((Get-Content (Join-Path $repo "mudkit\__init__.py") -Raw),
                       '__version__\s*=\s*"([^"]+)"').Groups[1].Value
if (-not $ver) { throw "version introuvable dans mudkit\__init__.py" }
if ($Version -and $Version.TrimStart("v") -ne $ver) { throw "-Version $Version != mudkit\__init__.py ($ver)" }
$tag     = "v$ver"
$runtime = (Get-Content (Join-Path $PSScriptRoot "runtime.txt") -Raw).Trim()
$venv    = Join-Path $repo ".venv"
$base    = ((Get-Content (Join-Path $venv "pyvenv.cfg")) -match '^home\s*=')[0] -replace '^home\s*=\s*', ''
$dist    = Join-Path $PSScriptRoot "dist"
$name    = "Mudkit-$tag"
$stage   = Join-Path $dist $name
$files   = Join-Path $stage "fichiers"
$app     = Join-Path $files "Mudkit"
$upd     = Join-Path $dist "update-$tag"
$zip     = Join-Path $dist "$name.zip"
$updZip  = Join-Path $dist "Mudkit-update-$tag.zip"
$zxp     = Join-Path $dist "Mudkit-Premiere-$tag.zxp"

function Copy-Tree($from, $to, [string[]]$extra) {
  robocopy $from $to /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP @extra | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $from -> $to (code $LASTEXITCODE)" }
}

Write-Output "Mudkit $tag (runtime $runtime) | Python de base : $base"
foreach ($p in $stage, $upd) { if (Test-Path $p) { Remove-Item $p -Recurse -Force } }
foreach ($p in $zip, $updZip, $zxp) { if (Test-Path $p) { Remove-Item $p -Force } }
New-Item -ItemType Directory -Force $app | Out-Null

# 1. extension Premiere re-signee depuis src\ (et redeployee sur ce PC)
& (Join-Path $repo "premiere_ext\deployer.ps1") | Out-Null
Copy-Item (Join-Path $repo "premiere_ext\Mudkit.zxp") $zxp
$ext = Join-Path $files "com.mudkit.premiere"
$tmpZip = Join-Path $env:TEMP "mudkit_ext_pack.zip"
Copy-Item $zxp $tmpZip -Force
Expand-Archive $tmpZip -DestinationPath $ext -Force
Remove-Item $tmpZip -Force

# 2. code de l'application (sans config.json / cookies.txt : propres a
#    chaque PC) -> aussi le contenu du paquet de mise a jour
$code = Join-Path $upd "app"
New-Item -ItemType Directory -Force $code | Out-Null
foreach ($f in "main.py", "premiere_dl.py", "Mudkit.bat", "requirements.txt", "README.md") {
  Copy-Item (Join-Path $repo $f) $code
}
Copy-Tree (Join-Path $repo "mudkit") (Join-Path $code "mudkit") @("/XD", "__pycache__")
Copy-Tree (Join-Path $repo "assets") (Join-Path $code "assets")
Copy-Tree $code $app
Copy-Tree (Join-Path $repo "bin") (Join-Path $app "bin") @("/XF", "input.jpg", "input2.jpg", "onepiece_demo.mp4")
Copy-Tree $ext (Join-Path $upd "com.mudkit.premiere")
@{ version = $ver; runtime = [int]$runtime } | ConvertTo-Json |
  Set-Content (Join-Path $upd "update.json") -Encoding ASCII

# 3. Python embarque
$py = Join-Path $app "python"
Copy-Tree $base $py @("/XD", (Join-Path $base "Lib\site-packages"), (Join-Path $base "Doc"),
  (Join-Path $base "include"), (Join-Path $base "libs"), (Join-Path $base "Scripts"),
  (Join-Path $base "share"), (Join-Path $base "tcl"), (Join-Path $base "Lib\test"),
  (Join-Path $base "Lib\idlelib"), (Join-Path $base "Lib\turtledemo"), "__pycache__",
  "/XF", "NEWS.txt")
$pyexe = Join-Path $py "python.exe"
& $pyexe -E -s -m ensurepip --default-pip | Out-Null
if ($LASTEXITCODE -ne 0) { throw "ensurepip a echoue" }
$constraints = Join-Path $env:TEMP "mudkit-constraints.txt"
& (Join-Path $venv "Scripts\python.exe") -m pip freeze --exclude-editable |
  Set-Content $constraints -Encoding ASCII
# pip passe par le resolveur DNS de secours de Mudkit (DNS de la box instable)
$req = Join-Path $repo "requirements.txt"
$pip = "import sys; sys.path.insert(0, r'$repo'); from mudkit import dnsfix; dnsfix.activate_if_needed(); " +
       "sys.argv = ['pip', 'install', '--disable-pip-version-check', '--no-warn-script-location', '--no-compile', " +
       "'-r', r'$req', '-c', r'$constraints']; from pip._internal.cli.main import main; sys.exit(main())"
& $pyexe -E -s -c $pip
if ($LASTEXITCODE -ne 0) { throw "pip install a echoue (reseau ?) : relance le build" }
Remove-Item $constraints
Remove-Item (Join-Path $py "Scripts") -Recurse -Force -ErrorAction SilentlyContinue  # .exe aux chemins en dur
Get-ChildItem $py -Recurse -Directory -Filter __pycache__ | Remove-Item -Recurse -Force
Set-Content (Join-Path $py "mudkit-runtime.txt") $runtime -Encoding ASCII

# 4. installateur + notice
Copy-Item (Join-Path $PSScriptRoot "installer\install.ps1")   $files
Copy-Item (Join-Path $PSScriptRoot "installer\uninstall.ps1") $files
Copy-Item (Join-Path $PSScriptRoot "installer\INSTALLER Mudkit.bat")    $stage
Copy-Item (Join-Path $PSScriptRoot "installer\Desinstaller Mudkit.bat") $stage
Copy-Item (Join-Path $PSScriptRoot "installer\LISEZ-MOI.txt") $stage
Set-Content (Join-Path $files "version.txt") $tag -Encoding ASCII

# 5. test : le Python embarque demarre seul, trouve ses dependances et le
#    code de Mudkit, sans les paquets de dev (-B : pas de __pycache__)
$check = & $pyexe -E -s -B -c ("import sys; sys.path.insert(0, r'$app'); " +
  "import webview, yt_dlp, PIL, numpy, onnxruntime; from mudkit.core import cutout; from mudkit import updater; " +
  "import importlib.util as u; assert u.find_spec('rembg') is None and u.find_spec('scipy') is None; " +
  "print('PREFIX=' + sys.prefix); print('RUNTIME=' + str(updater.runtime()))")
if ($LASTEXITCODE -ne 0) { throw "Python embarque KO" }
if (-not ($check -contains "PREFIX=$py")) { throw "Python embarque pointe ailleurs : $check" }
if (-not ($check -contains "RUNTIME=$runtime")) { throw "runtime illisible : $check" }
Write-Output "Python embarque OK"

# 6. zips
tar -a -c -f $zip -C $dist $name
if ($LASTEXITCODE -ne 0) { throw "zip complet echoue" }
tar -a -c -f $updZip -C $upd app com.mudkit.premiere update.json
if ($LASTEXITCODE -ne 0) { throw "zip de mise a jour echoue" }
foreach ($f in $zip, $updZip, $zxp) {
  Write-Output ("{0,-40} {1,8:N1} Mo" -f (Split-Path $f -Leaf), ((Get-Item $f).Length / 1MB))
}

# 7. release GitHub
if ($Publish) {
  $notes = Join-Path $PSScriptRoot "notes\$tag.md"
  $gh = @("release", "create", $tag, $zip, $updZip, $zxp, "--title", "Mudkit $tag",
          "--target", "master", "--latest")
  if (Test-Path $notes) { $gh += @("--notes-file", $notes) } else { $gh += "--generate-notes" }
  Push-Location $repo  # gh deduit le depot GitHub du dossier courant
  try { gh @gh } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw "gh release create a echoue" }
}
