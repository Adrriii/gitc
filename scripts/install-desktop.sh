#!/usr/bin/env bash
# Gives gitc its own icon and taskbar entry on Linux.
#
#   ./scripts/install-desktop.sh
#   ./scripts/install-desktop.sh --remove
#
# Why this is needed: gitc's window is a Chromium window started with --app=,
# and a Linux window manager identifies windows by WM_CLASS. Without help the
# window reports the browser's class, so it gets the browser's icon and groups
# into the browser's taskbar button.
#
# gitc launches the browser with --class=gitc, and this installs a .desktop
# file whose StartupWMClass matches - which is what lets the desktop attach
# gitc's icon and its own entry to that window.
#
# Everything goes under $HOME. No root, no system directories.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
icons="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
desktop="$apps/gitc.desktop"

if [ "${1:-}" = "--remove" ]; then
    rm -f "$desktop"
    for size in 16 24 32 48 64 128 256; do
        rm -f "$icons/${size}x${size}/apps/gitc.png"
    done
    command -v update-desktop-database >/dev/null && update-desktop-database "$apps" || true
    echo "Removed $desktop and its icons."
    exit 0
fi

exe="${1:-$root/dist/gitc}"
if [ ! -x "$exe" ]; then
    echo "gitc binary not found at $exe" >&2
    echo "Build it first (npm run build), or pass the path as an argument." >&2
    exit 1
fi
exe="$(cd "$(dirname "$exe")" && pwd)/$(basename "$exe")"

# The icon has to live in the hicolor theme for the desktop to find it by
# name; referencing a path works in some environments and not others.
for size in 16 24 32 48 64 128 256; do
    src="$root/icons/gitc-${size}.png"
    [ -f "$src" ] || continue
    install -Dm644 "$src" "$icons/${size}x${size}/apps/gitc.png"
done

mkdir -p "$apps"
cat > "$desktop" <<EOF
[Desktop Entry]
Type=Application
Name=gitc
GenericName=Git Client
Comment=A fast, minimal git client
Exec=$exe %f
Icon=gitc
Terminal=false
Categories=Development;RevisionControl;
Keywords=git;vcs;version control;
StartupNotify=true
StartupWMClass=gitc
EOF

chmod 644 "$desktop"

# Best effort: these refresh the menu and icon caches, and not every desktop
# ships them.
command -v update-desktop-database >/dev/null && update-desktop-database "$apps" || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -f -t "$icons" 2>/dev/null || true

echo "Wrote $desktop"
echo "  Exec:           $exe"
echo "  StartupWMClass: gitc  (matches gitc's --class=gitc)"
echo
echo "Close the gitc window and reopen it - the desktop reads the class when"
echo "the window is created."
