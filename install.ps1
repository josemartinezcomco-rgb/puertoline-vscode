# Instala la última versión de Puertoline en VS Code.
# Uso: irm https://raw.githubusercontent.com/josemartinezcomco-rgb/puertoline-vscode/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$repo = 'josemartinezcomco-rgb/puertoline-vscode'

$code = Get-Command code -ErrorAction SilentlyContinue
if (-not $code) {
  $candidates = @(
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
    "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd"
  )
  $code = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $code) { throw 'No se encontró VS Code (comando "code"). Instálalo desde https://code.visualstudio.com' }
} else {
  $code = $code.Source
}

Write-Host 'Buscando la última versión de Puertoline...'
$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'puertoline-installer' }
$asset = $release.assets | Where-Object { $_.name -like '*.vsix' } | Select-Object -First 1
if (-not $asset) { throw "La release $($release.tag_name) no contiene un .vsix" }

$file = Join-Path $env:TEMP $asset.name
Invoke-WebRequest $asset.browser_download_url -OutFile $file -UseBasicParsing
& $code --install-extension $file --force
Remove-Item $file -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Puertoline $($release.tag_name) instalado. Recarga VS Code (Ctrl+Shift+P > Developer: Reload Window)." -ForegroundColor Green
