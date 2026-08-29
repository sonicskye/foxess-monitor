#!/usr/bin/env bash
#
# Launch the dashboard fullscreen on the laptop's own screen.
#
# Run from your desktop session's autostart (see docs/RUNBOOK.md). It waits for the backend to
# answer before starting the browser, so a slow boot doesn't leave you looking at an error page.
#
#   ./deploy/kiosk.sh                    # defaults to http://localhost:8080
#   URL=http://localhost:9000 ./deploy/kiosk.sh

set -euo pipefail

URL="${URL:-http://localhost:8080}"
PROFILE="${PROFILE:-$HOME/.config/foxess-kiosk}"
WAIT_SECONDS="${WAIT_SECONDS:-90}"

find_browser() {
  for candidate in "${BROWSER_BIN:-}" chromium chromium-browser google-chrome google-chrome-stable brave-browser; do
    [ -n "$candidate" ] && command -v "$candidate" >/dev/null 2>&1 && { command -v "$candidate"; return 0; }
  done
  return 1
}

BROWSER="$(find_browser)" || {
  echo "No Chromium-based browser found. Install one, e.g.:" >&2
  echo "  sudo apt install chromium" >&2
  echo "Or set BROWSER_BIN=/path/to/browser" >&2
  exit 1
}

echo "Waiting for $URL (up to ${WAIT_SECONDS}s)…"
for _ in $(seq "$WAIT_SECONDS"); do
  if curl -sf --max-time 2 "${URL%/}/healthz" >/dev/null 2>&1; then
    echo "Backend is up."
    break
  fi
  sleep 1
done

# Stop the screen blanking — this is a wall display, not a workstation.
if command -v xset >/dev/null 2>&1; then
  xset s off || true
  xset -dpms || true
  xset s noblank || true
fi

exec "$BROWSER" \
  --kiosk \
  --app="$URL" \
  --user-data-dir="$PROFILE" \
  --start-fullscreen \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI \
  --no-first-run \
  --check-for-update-interval=31536000 \
  --password-store=basic \
  --autoplay-policy=no-user-gesture-required \
  --overscroll-history-navigation=0
