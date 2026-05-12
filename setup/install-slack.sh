#!/usr/bin/env bash
# Setup helper: install-slack — bundles the preflight + install commands
# from the /add-slack skill into one idempotent script so /new-setup can
# run them programmatically before continuing to credentials.
#
# Copies the Slack adapter in from the `channels` branch; appends the
# self-registration import; installs the pinned @chat-adapter/slack package;
# builds. All steps are safe to re-run.
#
# DO NOT RUN ON THIS FORK — see README-extra.md "Slack: Socket Mode is
# mandatory". This script would replace the Socket Mode adapter
# (src/channels/slack.ts via @slack/bolt) with the upstream webhook-only
# @chat-adapter/slack shim. The guard below refuses to run unless the
# operator opts in explicitly.
if [[ "${NANOCLAW_FORK_OVERRIDE_INSTALL_SLACK:-}" != "i-understand-this-will-replace-socket-mode" ]]; then
  cat >&2 <<'GUARD'
[install-slack.sh] REFUSED on this fork.

This fork uses a Socket Mode Slack adapter (@slack/bolt) ported verbatim
from v1 — see src/channels/slack.ts header + README-extra.md.

Running install-slack.sh would:
  1. git fetch origin channels
  2. OVERWRITE src/channels/slack.ts with the upstream webhook-only
     Chat-SDK shim from origin/channels
  3. Add @chat-adapter/slack@4.26.0 as a dependency

That is a hard regression for this install. The Slack adapter is already
wired and tested — no install step is needed on this fork.

If you genuinely understand the consequences and need to bypass this
guard, re-run with:
  NANOCLAW_FORK_OVERRIDE_INSTALL_SLACK=i-understand-this-will-replace-socket-mode \
    bash setup/install-slack.sh

See README-extra.md for the rationale.
GUARD
  exit 2
fi

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== NANOCLAW SETUP: INSTALL_SLACK ==="

needs_install=false
[[ -f src/channels/slack.ts ]] || needs_install=true
grep -q "import './slack.js';" src/channels/index.ts || needs_install=true
grep -q '"@chat-adapter/slack"' package.json || needs_install=true
[[ -d node_modules/@chat-adapter/slack ]] || needs_install=true

if ! $needs_install; then
  echo "STATUS: already-installed"
  echo "=== END ==="
  exit 0
fi

echo "STEP: fetch-channels-branch"
git fetch origin channels

echo "STEP: copy-files"
git show origin/channels:src/channels/slack.ts > src/channels/slack.ts

echo "STEP: register-import"
if ! grep -q "import './slack.js';" src/channels/index.ts; then
  printf "import './slack.js';\n" >> src/channels/index.ts
fi

echo "STEP: pnpm-install"
pnpm install @chat-adapter/slack@4.26.0

echo "STEP: pnpm-build"
pnpm run build

echo "STATUS: installed"
echo "=== END ==="
