#!/usr/bin/env bash
# macOS launcher for gps-sdr-sim + web route planner.
# Opens two new Terminal.app windows: one for the Node frontend, one for the sim.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

FRONTEND="$ROOT/frontend"
SIMEXE="$ROOT/gps-sdr-sim"
NAVFILE="$ROOT/scripts/brdc2120.26n"

# Optional: capture fresh ephemeris before starting.
# Requires pyrtcm (pip install pyrtcm) or use the venv at scripts/.venv
#
# echo "[*] Capturing live ephemeris..."
# "$ROOT/scripts/.venv/bin/python" "$ROOT/scripts/rtcm_to_rinex.py" || {
#     echo "[-] Ephemeris capture failed."; exit 1;
# }

if [[ ! -x "$SIMEXE" ]]; then
    echo "[-] gps-sdr-sim binary not found or not executable at:"
    echo "    $SIMEXE"
    echo "    Build it first: run 'make' from the repo root (needs libusb: 'brew install libusb')."
    exit 1
fi

if [[ ! -f "$NAVFILE" ]]; then
    echo "[-] Navigation file not found:"
    echo "    $NAVFILE"
    echo "    Run scripts/rtcm_to_rinex.py to generate a fresh ephemeris file."
    exit 1
fi

if [[ ! -d "$FRONTEND/node_modules" ]]; then
    echo "[*] node_modules missing - running npm install..."
    ( cd "$FRONTEND" && npm install )
fi

# Escape backslash and double-quote for an AppleScript double-quoted string literal.
as_escape() { printf %s "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

open_terminal() {
    local title="$1" cmd="$2"
    local as_cmd as_title
    as_cmd=$(as_escape "$cmd")
    as_title=$(as_escape "$title")
    osascript <<APPLESCRIPT >/dev/null
tell application "Terminal"
    activate
    set newTab to do script "$as_cmd"
    set custom title of newTab to "$as_title"
end tell
APPLESCRIPT
}

echo "[*] Starting web route planner on http://localhost:3000 ..."
open_terminal "GPS Route Planner" "cd '$FRONTEND' && node server.js"

# Give the server a moment to bind before the sim tries anything on 6000.
sleep 2

# Flags: -H direct HackRF transmit, -b 8 signed 8-bit I/Q, -S TCP socket input on port 6000
echo "[*] Starting gps-sdr-sim ..."
open_terminal "gps-sdr-sim" "'$SIMEXE' -e '$NAVFILE' -b 8 -p 128 -s 4000000 -H -S"

echo
echo "[+] Both processes launched in separate Terminal windows."
echo "    Open http://localhost:3000 in your browser, then click Connect to Simulator."
echo
