#!/usr/bin/env bash
# scripts/wsl-window-capture.sh — capture a screenshot of a Linux GUI
# window running through WSLg, save as PNG.
#
# Why: Tauri apps run as native GTK/WebKitGTK windows on WSL, displayed
# on Windows via WSLg's Weston/RDP bridge. Playwright lets us screenshot
# the React app from the Vite side, but the actual Tauri native window
# (with its real WebKit rendering + chrome titlebar + GPU compositor
# behavior) is invisible to Playwright. This script bridges that gap.
#
# WSLg quirk: `wmctrl -l` fails because Weston doesn't expose
# `_NET_CLIENT_LIST`. Workaround uses `xwininfo -root -tree` which works.
#
# Tools needed (one-time install):
#   sudo apt install -y imagemagick wmctrl xdotool
#
# Usage:
#   ./scripts/wsl-window-capture.sh                       # list windows
#   ./scripts/wsl-window-capture.sh grok-shell out.png    # capture by name match
#   ./scripts/wsl-window-capture.sh 0x600004 out.png      # capture by window-id
#
# Match is a case-insensitive substring against window name. Returns
# the matched window-id; if multiple match, picks the first.

set -euo pipefail

DISPLAY="${DISPLAY:-:0}"
export DISPLAY

# Without args: list named windows.
if [[ $# -eq 0 ]]; then
  echo "Named X11 windows (DISPLAY=$DISPLAY):"
  xwininfo -root -tree 2>/dev/null \
    | grep -E '"[^"]+":' \
    | grep -v 'has no name' \
    | sed 's/^[[:space:]]*//'
  exit 0
fi

NEEDLE="$1"
OUT="${2:-/tmp/wsl-capture-$(date +%s).png}"

# Direct hex id?
if [[ "$NEEDLE" =~ ^0x[0-9a-fA-F]+$ ]]; then
  WID="$NEEDLE"
else
  WID="$(
    xwininfo -root -tree 2>/dev/null \
      | grep -i -E "\"[^\"]*${NEEDLE}[^\"]*\":" \
      | head -1 \
      | awk '{print $1}' \
      | grep -E '^0x[0-9a-fA-F]+$' || true
  )"
  if [[ -z "$WID" ]]; then
    echo "✗ no window matched '$NEEDLE'" >&2
    echo "   Run with no args to list named windows." >&2
    exit 1
  fi
fi

echo "→ capturing $WID → $OUT"
import -window "$WID" "$OUT"
ls -la "$OUT"
echo "✓ done"
