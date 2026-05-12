#!/bin/bash
# Clean restart of nanoclaw (v2).
#
# v2 deltas vs v1 restart.sh:
#   - No cache-clear step. v2 agent runs from a baked Docker image
#     (nanoclaw-agent:latest); there's no per-session source overlay
#     under data/sessions/<id>/agent-runner-src/ to invalidate.
#   - No DELETE FROM sessions step. The v1 race that motivated it
#     (sessions row pointing at a deleted on-disk JSONL → infinite
#     "no conversation found" retry) cannot occur in v2 — conversation
#     state lives in per-session SQLite DBs at
#     data/v2-sessions/<id>/{inbound,outbound}.db, not JSONLs.
#
# The manual-instance guard is kept: a bare `node dist/index.js` can
# still race the systemd-managed instance. See
# feedback_kill_manual_before_restart in ~/.claude/.../memory/.

set -eu

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

echo "[1/2] Stopping nanoclaw..."
systemctl --user stop nanoclaw

if pgrep -f 'dist/index.js' | grep -v "$$" > /dev/null; then
    echo "  warning: found node dist/index.js process(es) still running:"
    pgrep -af 'dist/index.js'
    echo "  kill them manually if they are stale nanoclaw instances."
fi

echo "[2/2] Starting nanoclaw..."
systemctl --user start nanoclaw

sleep 2
state="$(systemctl --user is-active nanoclaw)"
echo
echo "nanoclaw: $state"

if [ "$state" != "active" ]; then
    echo "service failed to start; check: journalctl --user -u nanoclaw -n 40"
    exit 1
fi
