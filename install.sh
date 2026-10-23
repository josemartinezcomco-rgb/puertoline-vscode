#!/usr/bin/env bash
# Instala la última versión de Puertoline en VS Code.
# Uso: curl -fsSL https://raw.githubusercontent.com/josemartinezcomco-rgb/puertoline-vscode/main/install.sh | bash
set -euo pipefail
REPO="josemartinezcomco-rgb/puertoline-vscode"

if ! command -v code >/dev/null 2>&1; then
  echo "No se encontró el comando 'code'. En VS Code: Ctrl+Shift+P > 'Shell Command: Install code command in PATH'." >&2
  exit 1
fi

echo "Buscando la última versión de Puertoline..."
URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -o '"browser_download_url": *"[^"]*\.vsix"' | head -1 | cut -d'"' -f4)
if [ -z "$URL" ]; then
  echo "No se encontró ningún .vsix en la última release." >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP/puertoline.vsix"
code --install-extension "$TMP/puertoline.vsix" --force

echo
echo "Puertoline instalado. Recarga VS Code (Ctrl+Shift+P > Developer: Reload Window)."
