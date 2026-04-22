#!/bin/bash
# Clean restart of nanoclaw.
#
# Order matters:
#   1. Stop the orchestrator — it caches session IDs in memory and writes them
#      back on every container completion. Clearing the DB while it's running
#      is immediately overwritten.
#   2. Clear agent-runner-src copies so containers pick up the latest
#      container/agent-runner/src/ on their next spawn (the per-group copy is
#      one-shot and never auto-refreshed).
#   3. Delete the sessions table — on-disk .claude/sessions/ is typically
#      empty after a cache clear, but sessions.session_id still points at the
#      (now non-existent) conversation. Leaving this mismatch produces an
#      infinite "No conversation found" retry loop on the next message.
#   4. Start the orchestrator.
#
# See feedback_clear_sessions_db_row.md in ~/.claude/.../memory/ for the
# incident that motivated wiping sessions as part of restart.

set -eu

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

echo "[1/4] Stopping nanoclaw..."
systemctl --user stop nanoclaw

# Guard against any manual/nohup instance left running
if pgrep -f 'dist/index.js' | grep -v "$$" > /dev/null; then
    echo "  warning: found node dist/index.js process(es) still running:"
    pgrep -af 'dist/index.js'
    echo "  kill them manually if they are stale nanoclaw instances."
fi

echo "[2/4] Clearing agent-runner-src caches..."
rm -rf \
    data/sessions/*/task-run/agent-runner-src \
    data/sessions/*/message-run/agent-runner-src

echo "[3/4] Clearing stale session rows..."
sqlite3 store/messages.db "DELETE FROM sessions;"

echo "[4/4] Starting nanoclaw..."
systemctl --user start nanoclaw

sleep 2
state="$(systemctl --user is-active nanoclaw)"
echo
echo "nanoclaw: $state"

if [ "$state" != "active" ]; then
    echo "service failed to start; check: journalctl --user -u nanoclaw -n 40"
    exit 1
fi
