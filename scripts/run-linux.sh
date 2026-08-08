#!/usr/bin/env bash
# Linux / Raspberry Pi launcher for gps-sdr-sim + web route planner.
# Frontend runs in the background; gps-sdr-sim runs in the foreground so its
# stderr is visible. Pressing Ctrl+C stops both cleanly.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

FRONTEND="$ROOT/frontend"
SIMEXE="$ROOT/gps-sdr-sim"
NAVFILE="$ROOT/scripts/brdc2010.26n"
FRONTEND_LOG="$SCRIPT_DIR/frontend.log"

# ── Optional: capture fresh ephemeris before starting ────────────────────
# Uncomment to re-run rtcm_to_rinex.py first. Requires pyrtcm — install with
# `pip install pyrtcm` or use the venv at scripts/.venv.
#
# echo "[*] Capturing live ephemeris..."
# "$ROOT/scripts/.venv/bin/python" "$ROOT/scripts/rtcm_to_rinex.py" || {
#     echo "[-] Ephemeris capture failed."; exit 1;
# }

# ── Validate paths ────────────────────────────────────────────────────────
if [[ ! -x "$SIMEXE" ]]; then
    echo "[-] gps-sdr-sim binary not found or not executable at:"
    echo "    $SIMEXE"
    echo "    Build it first:"
    echo "      sudo apt install libusb-1.0-0-dev pkg-config"
    echo "      make clean && make all"
    exit 1
fi

if [[ ! -f "$NAVFILE" ]]; then
    echo "[-] Navigation file not found:"
    echo "    $NAVFILE"
    echo "    Run scripts/rtcm_to_rinex.py to generate one, or edit NAVFILE in this script."
    exit 1
fi

if ! command -v node >/dev/null 2>&1; then
    echo "[-] Node.js is not installed. Install with:  sudo apt install nodejs npm"
    exit 1
fi

if [[ ! -d "$FRONTEND/node_modules" ]]; then
    echo "[*] node_modules missing — running npm install..."
    ( cd "$FRONTEND" && npm install )
fi

# ── Cleanup handler: kill the frontend when the sim exits or user hits Ctrl+C ─
FRONTEND_PID=""
cleanup() {
    if [[ -n "$FRONTEND_PID" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
        echo
        echo "[*] Stopping frontend (PID $FRONTEND_PID)..."
        kill "$FRONTEND_PID" 2>/dev/null || true
        wait "$FRONTEND_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

# ── Launch frontend in background ─────────────────────────────────────────
echo "[*] Starting web route planner on http://localhost:3000 ..."
( cd "$FRONTEND" && node server.js ) > "$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

# Give the server a moment to bind
sleep 2

if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    echo "[-] Frontend failed to start. See $FRONTEND_LOG"
    exit 1
fi
echo "    Frontend PID: $FRONTEND_PID   (logs: $FRONTEND_LOG)"

# ── Launch gps-sdr-sim in foreground ──────────────────────────────────────
# Flags: -H direct HackRF transmit, -b 8 signed 8-bit I/Q, -S TCP socket
#        input on port 6000, -s 4M sample rate, -p 128 fixed gain,
#        -T now overwrite TOC/TOE to current time.
echo "[*] Starting gps-sdr-sim ..."
echo
echo "[+] Open http://localhost:3000 in your browser, then click Connect to Simulator."
echo "    Press Ctrl+C here to stop both processes."
echo

# HackRF often needs elevated privileges unless a udev rule grants access to
# the "plugdev" group. If you see "Failed to open HackRF device", either:
#   1) Install hackrf udev rules and add your user to plugdev, OR
#   2) Prefix the line below with sudo
sudo "$SIMEXE" -e "$NAVFILE" -b 8 -s 4000000 -p 128 -T now -H -S
