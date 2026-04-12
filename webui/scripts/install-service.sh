#!/bin/bash
set -euo pipefail

# Install nanoclaw-webui as a system service.
# Detects systemd (Linux), launchd (macOS), or uses nohup fallback.

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_PATH="$(which node)"
HOME_DIR="$HOME"
ENTRY_POINT="$PROJECT_ROOT/dist/webui/start.js"

if [ ! -f "$ENTRY_POINT" ]; then
  echo "Error: $ENTRY_POINT not found. Run 'npm run build:webui' first."
  exit 1
fi

mkdir -p "$PROJECT_ROOT/logs"

# --- systemd (Linux) ---
if command -v systemctl &>/dev/null && [ "$(uname)" = "Linux" ]; then
  UNIT_DIR="$HOME_DIR/.config/systemd/user"
  UNIT_FILE="$UNIT_DIR/nanoclaw-webui.service"
  mkdir -p "$UNIT_DIR"

  cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=NanoClaw Web UI
After=network.target

[Service]
Type=simple
ExecStart=$NODE_PATH $ENTRY_POINT
WorkingDirectory=$PROJECT_ROOT
Restart=always
RestartSec=5
Environment=HOME=$HOME_DIR
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$HOME_DIR/.local/bin

StandardOutput=append:$PROJECT_ROOT/logs/webui.log
StandardError=append:$PROJECT_ROOT/logs/webui.error.log

[Install]
WantedBy=default.target
UNIT

  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  systemctl --user daemon-reload
  systemctl --user enable nanoclaw-webui
  systemctl --user start nanoclaw-webui

  echo "Installed and started nanoclaw-webui.service"
  echo "  Status: systemctl --user status nanoclaw-webui"
  echo "  Logs:   tail -f $PROJECT_ROOT/logs/webui.log"

# --- launchd (macOS) ---
elif [ "$(uname)" = "Darwin" ]; then
  PLIST_DIR="$HOME_DIR/Library/LaunchAgents"
  PLIST_FILE="$PLIST_DIR/com.nanoclaw-webui.plist"
  mkdir -p "$PLIST_DIR"

  cat > "$PLIST_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw-webui</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$ENTRY_POINT</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_ROOT</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:$HOME_DIR/.local/bin</string>
        <key>HOME</key>
        <string>$HOME_DIR</string>
    </dict>
    <key>StandardOutPath</key>
    <string>$PROJECT_ROOT/logs/webui.log</string>
    <key>StandardErrorPath</key>
    <string>$PROJECT_ROOT/logs/webui.error.log</string>
</dict>
</plist>
PLIST

  launchctl load "$PLIST_FILE"

  echo "Installed and started com.nanoclaw-webui"
  echo "  Status: launchctl list | grep nanoclaw-webui"
  echo "  Logs:   tail -f $PROJECT_ROOT/logs/webui.log"

# --- nohup fallback ---
else
  PID_FILE="$PROJECT_ROOT/webui.pid"

  if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
      echo "Stopping existing web UI (PID $OLD_PID)..."
      kill "$OLD_PID" 2>/dev/null || true
      sleep 2
    fi
  fi

  # Truncate logs if over 50 MB
  for f in "$PROJECT_ROOT/logs/webui.log" "$PROJECT_ROOT/logs/webui.error.log"; do
    if [ -f "$f" ] && [ "$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null)" -gt 52428800 ]; then
      tail -c 10485760 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
      echo "Truncated $f (kept last 10 MB)"
    fi
  done

  echo "Starting NanoClaw Web UI..."
  nohup "$NODE_PATH" "$ENTRY_POINT" \
    >> "$PROJECT_ROOT/logs/webui.log" \
    2>> "$PROJECT_ROOT/logs/webui.error.log" &

  echo $! > "$PID_FILE"
  echo "Web UI started (PID $!)"
  echo "  URL:  https://localhost:${WEBUI_PORT:-3100}"
  echo "  Logs: tail -f $PROJECT_ROOT/logs/webui.log"
fi
