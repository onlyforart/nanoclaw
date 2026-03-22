#!/usr/bin/env bash
# setup-sandbox.sh — Set up NanoClaw in a Docker AI Sandbox.
#
# Usage:
#   curl -fsSL https://nanoclaw.dev/install-docker-sandboxes.sh | bash

set -euo pipefail

REPO_URL="https://github.com/onlyforart/nanoclaw.git"
REPO_BRANCH="main"

# Generate unique suffix for this instance
SUFFIX=$(date +%s | tail -c 5)
WORKSPACE="${HOME}/nanoclaw-sandbox-${SUFFIX}"
SANDBOX_NAME="nanoclaw-sandbox-${SUFFIX}"

# When piped via curl|bash, stdin is the script itself.
# Redirect stdin for commands that might consume it.

echo ""
echo "=== NanoClaw Docker Sandbox Setup ==="
echo ""
echo "Workspace: ${WORKSPACE}"
echo "Sandbox:   ${SANDBOX_NAME}"
echo ""

# ── Preflight ──────────────────────────────────────────────────────
if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" != "arm64" ]]; then
  echo "ERROR: Docker AI Sandboxes require Apple Silicon (M1 or later)."
  echo "Intel Macs are not supported. See: https://docs.docker.com/sandbox/"
  exit 1
fi

if ! command -v docker &>/dev/null; then
  echo "ERROR: Docker not found."
  echo "Install Docker Desktop 4.40+: https://www.docker.com/products/docker-desktop/"
  exit 1
fi

if ! docker sandbox version </dev/null &>/dev/null; then
  echo "ERROR: Docker sandbox not available."
  echo "Update Docker Desktop 4.40+ and enable sandbox support."
  exit 1
fi

# ── Clone NanoClaw on host ─────────────────────────────────────────
echo "Cloning NanoClaw..."
git clone -b "$REPO_BRANCH" "$REPO_URL" "$WORKSPACE" </dev/null

# ── Create sandbox using Claude agent type ─────────────────────────
echo "Creating sandbox..."
echo y | docker sandbox create --name "$SANDBOX_NAME" claude "$WORKSPACE"

# ── Configure proxy bypass for messaging platforms ─────────────────
echo "Configuring network bypass..."
docker sandbox network proxy "$SANDBOX_NAME" \
  --bypass-host api.anthropic.com \
  --bypass-host "api.telegram.org" \
  --bypass-host "*.telegram.org" \
  --bypass-host "*.whatsapp.com" \
  --bypass-host "*.whatsapp.net" \
  --bypass-host "*.web.whatsapp.com" \
  --bypass-host "discord.com" \
  --bypass-host "*.discord.com" \
  --bypass-host "*.discord.gg" \
  --bypass-host "*.discord.media" \
  --bypass-host "slack.com" \
  --bypass-host "*.slack.com" </dev/null

echo ""
echo "========================================="
echo "  Sandbox created! Launching..."
echo "========================================="
echo ""
echo "Type /setup when Claude Code starts."
echo ""

docker sandbox run "$SANDBOX_NAME" </dev/tty
