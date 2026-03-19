#!/bin/bash
set -euo pipefail

# Uninstall the nanoclaw-webui service.

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# --- systemd ---
if command -v systemctl &>/dev/null && [ "$(uname)" = "Linux" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  systemctl --user stop nanoclaw-webui 2>/dev/null || true
  systemctl --user disable nanoclaw-webui 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/nanoclaw-webui.service"
  systemctl --user daemon-reload
  echo "Removed nanoclaw-webui.service"

# --- launchd ---
elif [ "$(uname)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.nanoclaw-webui.plist"
  if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed com.nanoclaw-webui"
  else
    echo "No launchd plist found."
  fi

# --- nohup ---
else
  PID_FILE="$PROJECT_ROOT/webui.pid"
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null || true
      echo "Stopped web UI (PID $PID)"
    fi
    rm -f "$PID_FILE"
  else
    echo "No PID file found."
  fi
fi
