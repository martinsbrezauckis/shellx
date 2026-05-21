#!/usr/bin/env bash
# scripts/dev.sh — launch grok-shell dev with port overrides that keep
# Vite + Tauri-devUrl + debug-api in sync.
#
# Why this exists: each port has a different config location and Tauri's
# devUrl is static JSON. Manually editing three files (vite.config.ts,
# tauri.conf.json, env) for every project that uses 5173/5757 is brittle.
# This wrapper reads two env vars, templates Tauri's devUrl on the
# command line via `--config`, and passes the same Vite port through
# the env so vite.config.ts picks it up.
#
# Usage:
#   ./scripts/dev.sh                                  # defaults (5173 + 5757)
#   GROK_SHELL_VITE_PORT=5858 ./scripts/dev.sh
#   GROK_SHELL_VITE_PORT=5858 GROK_SHELL_DEBUG_PORT=5858 \
#     ./scripts/dev.sh
#
# To free a busy port from a sibling project first:
#   lsof -i :5173        # see what holds it
#   ss -tlnp | grep 5173
#
# Notes:
#   - Both env vars accept any 1024-65535 value.
#   - VITE port and DEBUG port don't need to match — they're independent
#     services. Some teams co-locate them for memorability though.
#   - --features debug-api is unconditional because the React side
#     `invoke('get_debug_port')` depends on it.

set -euo pipefail

VITE_PORT="${GROK_SHELL_VITE_PORT:-5173}"
DEBUG_PORT="${GROK_SHELL_DEBUG_PORT:-5757}"

# WebKitGTK 4.1 silently ignores ::-webkit-scrollbar pseudo-elements
# (confirmed: Tauri discussions #8829, tao #368, webkit bug #234874).
# GTK overlay scrollbars only fade in on hover, which the user reported
# 2026-05-17 as "lack of scrollbar in chat, cant see history". Setting
# GTK_OVERLAY_SCROLLING=0 forces traditional always-visible scrollbars
# at the GTK widget level. On Windows (WebView2/Edge) the
# ::-webkit-scrollbar CSS in App.css works natively, so this only
# affects WSL dev. Production Windows users are fine.
export GTK_OVERLAY_SCROLLING=0

# Export so the child Vite (pnpm dev) picks the port up from vite.config.ts.
export GROK_SHELL_VITE_PORT="$VITE_PORT"
export GROK_SHELL_DEBUG_PORT="$DEBUG_PORT"

# WSLg graphics — every WSL user sees the libEGL/ZINK/dri2 warnings
# on stdout. They are NOISE, not errors. WSL2's Mesa stack lacks a
# real GPU device fd; WebKitGTK falls back to software rendering and
# still draws fine. Ignore them.
#
# The two real symptoms historically blamed on Mesa here:
#   (1) resize hang — clicking the window or dragging its border froze
#       the UI. Root cause was DRI2/DMABUF interaction, fixed by
#       WEBKIT_DISABLE_COMPOSITING_MODE=1 + WEBKIT_DISABLE_DMABUF_RENDERER=1
#   (2) invisible window — the app launches, taskbar icon appears,
#       but no window is visible on the Windows desktop. Root cause
#       was WEBKIT_DISABLE_DMABUF_RENDERER=1 itself: it forces
#       software paths that prevent the Wayland compositor from
#       getting a renderable surface, so WSLg has nothing to show.
#
# Tauri 2 + WSLg combo today: NEITHER workaround. Mesa warnings are
# harmless; the resize hang doesn't reproduce on current versions
# (Mesa 24+, webkit2gtk 2.46+). If a user hits the hang again, they
# can opt in via:
#   GROK_SHELL_DISABLE_COMPOSITING=1 ./scripts/dev.sh
#
# X11 backend (agent screenshot mode) — opt in:
#   GROK_SHELL_FORCE_X11=1 ./scripts/dev.sh
#   ⚠ note: X11/XWayland windows often appear off-screen on WSLg's
#   Windows-desktop layout. Only useful when the agent is driving
#   xwininfo + import for visual-verify.
if [[ "${GROK_SHELL_FORCE_X11:-0}" == "1" ]]; then
  : "${GDK_BACKEND:=x11}"
  export GDK_BACKEND
  echo "→ Forced GDK_BACKEND=x11 (agent screenshot mode)"
fi
if [[ "${GROK_SHELL_DISABLE_COMPOSITING:-0}" == "1" ]]; then
  export WEBKIT_DISABLE_COMPOSITING_MODE=1
  export WEBKIT_DISABLE_DMABUF_RENDERER=1
  echo "→ Mesa workarounds enabled (compositing+dmabuf disabled)"
fi

echo "→ Vite     port: $VITE_PORT"
echo "→ debug-api port: $DEBUG_PORT"
echo "→ Tauri devUrl  : http://localhost:$VITE_PORT (templated)"
echo "→ GDK_BACKEND   : ${GDK_BACKEND:-wayland (default)}"
echo "→ WebKit        : compositing=${WEBKIT_DISABLE_COMPOSITING_MODE:-on}  dmabuf=${WEBKIT_DISABLE_DMABUF_RENDERER:-on}"

# Tauri 2's --config accepts a JSON literal that merges over the static
# tauri.conf.json. Two overrides:
#  1. `build.devUrl` so Tauri's WebView loads from the Vite port we just set
#  2. `app.security.devCsp` — relaxes the production CSP's hardcoded
#     `http://localhost:5173` + `http://127.0.0.1:5757` to wildcards in
#     dev mode. Without this, every port override silently breaks: the
#     React app fails to fetch its Vite-served modules (CSP-blocked),
#     the page never renders, and the user sees a Linux taskbar entry
#     with no visible window. devCsp only applies in `tauri dev` — the
#     strict prod CSP in tauri.conf.json is unaffected.
DEV_CSP="default-src 'self'; img-src 'self' asset: blob: data: https://asset.localhost; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' asset: https://asset.localhost ipc: http://ipc.localhost http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*; frame-src 'self' asset: blob:; worker-src 'self' blob:;"

CONFIG_OVERRIDE=$(cat <<EOF
{"build":{"devUrl":"http://localhost:${VITE_PORT}"},"app":{"security":{"devCsp":"${DEV_CSP}"}}}
EOF
)

exec pnpm tauri dev --features debug-api --config "$CONFIG_OVERRIDE"
