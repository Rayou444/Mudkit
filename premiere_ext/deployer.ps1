# Signe l'extension Premiere (source: src\) et la deploie dans CEP\extensions.
# A relancer apres CHAQUE modification de src\ (la signature couvre les fichiers).
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$src  = Join-Path $root "src"
$zxp  = Join-Path $root "Mudkit.zxp"
$cert = Join-Path $root "mudkit-cert.p12"
$pass = "mudkit-local"
$dest = "$env:APPDATA\Adobe\CEP\extensions\com.mudkit.premiere"

if (-not (Test-Path $cert)) {
  & (Join-Path $root "ZXPSignCmd.exe") -selfSignedCert FR IDF Mudkit Rayan $pass $cert
  Write-Output "certificat auto-signe cree"
}

Remove-Item $zxp -Force -ErrorAction SilentlyContinue
& (Join-Path $root "ZXPSignCmd.exe") -sign $src $zxp $cert $pass
if (-not (Test-Path $zxp)) { throw "signature echouee" }

Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
$zip = Join-Path $env:TEMP "mudkit_ext.zip"
Copy-Item $zxp $zip -Force
Expand-Archive -Path $zip -DestinationPath $dest -Force
Remove-Item $zip -Force

Write-Output "deploye dans $dest"
Get-ChildItem $dest -Recurse -Name
