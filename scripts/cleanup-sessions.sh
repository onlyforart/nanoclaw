#!/bin/bash
#
# Prune stale session artifacts (v2).
#
# v2 deltas vs v1 cleanup-sessions.sh:
#   - No JSONL fan-out. v2 stores conversation state in per-session
#     SQLite DBs at data/v2-sessions/<id>/{inbound,outbound}.db — not
#     .claude/projects/-workspace-group/<id>.jsonl.
#   - No .claude/debug, .claude/todos, .claude/telemetry directories.
#     Container state lives entirely in the two per-session DBs.
#   - Group logs at groups/<folder>/logs/ are the main ongoing disk
#     usage.
#
# v1's cleanup-sessions.sh shipped on upstream/main pointing at v1
# paths (store/messages.db, data/sessions/, .claude/projects/) — all
# absent in v2. This rewrite replaces that broken trunk script.
#
# Usage:  ./scripts/cleanup-sessions.sh [--dry-run]
#
# Retention:
#   Per-session DB dirs (data/v2-sessions/<id>/):  30 days since
#                                                   last_active for
#                                                   non-active sessions
#   Group logs (groups/<folder>/logs/):             7 days

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

CENTRAL_DB="$PROJECT_ROOT/data/v2.db"
SESSIONS_DIR="$PROJECT_ROOT/data/v2-sessions"
GROUPS_DIR="$PROJECT_ROOT/groups"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

TOTAL_FREED=0

log() { echo "[cleanup] $*"; }

remove_dir() {
  local target="$1"
  local size
  size=$(du -sk "$target" 2>/dev/null | cut -f1)
  if $DRY_RUN; then
    log "would remove dir: $target (${size}K)"
  else
    rm -rf "$target"
    log "removed dir: $target (${size}K)"
  fi
  TOTAL_FREED=$((TOTAL_FREED + size))
}

remove_file() {
  local target="$1"
  local size
  size=$(wc -c < "$target" 2>/dev/null || echo 0)
  size=$((size / 1024))
  if $DRY_RUN; then
    log "would remove file: $target (${size}K)"
  else
    rm -f "$target"
  fi
  TOTAL_FREED=$((TOTAL_FREED + size))
}

# --- Collect active session IDs from the central DB ---

if [ ! -f "$CENTRAL_DB" ]; then
  log "ERROR: central database not found at $CENTRAL_DB"
  exit 1
fi

ACTIVE_IDS=$(sqlite3 "$CENTRAL_DB" "SELECT id FROM sessions WHERE status = 'active';" 2>/dev/null || true)

is_active() {
  echo "$ACTIVE_IDS" | grep -qF "$1"
}

# --- Prune stale per-session DB directories ---
# Layout: data/v2-sessions/<agent_group_id>/<session_id>/...
# Heuristic: a session dir is stale if its directory has not been
# modified in 30 days AND its session row is not status='active'. The
# mtime heuristic avoids racing with the host's own session lifecycle.

if [ -d "$SESSIONS_DIR" ]; then
  while IFS= read -r -d '' session_dir; do
    session_id=$(basename "$session_dir")
    if is_active "$session_id"; then
      continue
    fi
    remove_dir "$session_dir"
  done < <(find "$SESSIONS_DIR" -mindepth 2 -maxdepth 2 -type d -mtime +30 -print0 2>/dev/null)
fi

# --- Prune group logs (>7 days) ---

if [ -d "$GROUPS_DIR" ]; then
  while IFS= read -r -d '' f; do
    remove_file "$f"
  done < <(find "$GROUPS_DIR"/*/logs -type f -mtime +7 -print0 2>/dev/null)
fi

# --- Summary ---

if $DRY_RUN; then
  log "DRY RUN complete — would free ~${TOTAL_FREED}K"
else
  log "Done — freed ~${TOTAL_FREED}K"
fi
