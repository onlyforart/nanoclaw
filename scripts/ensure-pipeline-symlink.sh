#!/bin/bash
# Ensure nanoclaw/pipeline symlink points at a given target directory.
#
# The pipeline/ symlink resolves at runtime to a plugin's spec directory
# (monitor.yaml, sanitiser-config.yaml, field-catalog.yaml, etc.). It's
# gitignored deliberately — not every install ships with a pipeline plugin —
# but when it IS present, a missing symlink means loadSanitiserConfig
# silently returns empty defaults and operator messages can leak into
# observations (see the sanitiser-config startup warning).
#
# This script is idempotent and safe to run on any install. The target path
# is passed as an argument so installation-specific paths stay out of this
# public repo.
#
# Usage:
#   scripts/ensure-pipeline-symlink.sh <target-dir-relative-to-repo-root> [flags]
#
# Behaviour:
#   - Target dir missing     → no-op, exit 0 (install without the plugin)
#   - Symlink already correct → no-op, exit 0
#   - Symlink missing         → create it
#   - Symlink wrong target    → --force to replace, else exit 1
#   - Non-symlink at path     → refuse to clobber, exit 1
#
# Flags:
#   --force   replace a wrong symlink without prompting
#   --quiet   suppress informational output (warnings still go to stderr)
#
# Example: a plugin skill calls this as
#   scripts/ensure-pipeline-symlink.sh ../some-plugin-repo/plugin-name/specs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SYMLINK="$REPO_ROOT/pipeline"

FORCE=0
QUIET=0
TARGET_RELATIVE=""

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --quiet) QUIET=1 ;;
    --*)
      echo "[pipeline-symlink] Unknown flag: $arg" >&2
      exit 2
      ;;
    *)
      if [ -n "$TARGET_RELATIVE" ]; then
        echo "[pipeline-symlink] Multiple target paths given; expected exactly one." >&2
        exit 2
      fi
      TARGET_RELATIVE="$arg"
      ;;
  esac
done

if [ -z "$TARGET_RELATIVE" ]; then
  echo "Usage: $0 <target-dir-relative-to-repo-root> [--force] [--quiet]" >&2
  exit 2
fi

TARGET_ABSOLUTE="$REPO_ROOT/$TARGET_RELATIVE"

log() {
  [ "$QUIET" = "1" ] || echo "$@"
}

warn() {
  echo "$@" >&2
}

# Target missing → exit quietly. Installs without the plugin don't need this link.
if [ ! -d "$TARGET_ABSOLUTE" ]; then
  log "[pipeline-symlink] No plugin at $TARGET_RELATIVE — nothing to do."
  exit 0
fi

# Symlink already correct → no-op
if [ -L "$SYMLINK" ]; then
  existing_target="$(readlink "$SYMLINK")"
  if [ "$existing_target" = "$TARGET_RELATIVE" ]; then
    log "[pipeline-symlink] Already correct: pipeline → $TARGET_RELATIVE"
    exit 0
  fi
  warn "[pipeline-symlink] Existing symlink points to '$existing_target' — expected '$TARGET_RELATIVE'."
  if [ "$FORCE" = "1" ]; then
    rm "$SYMLINK"
    ln -s "$TARGET_RELATIVE" "$SYMLINK"
    warn "[pipeline-symlink] Repaired (--force)."
    exit 0
  fi
  warn "[pipeline-symlink] Re-run with --force to replace, or fix manually."
  exit 1
fi

# Regular file/dir at the path → refuse to clobber
if [ -e "$SYMLINK" ]; then
  warn "[pipeline-symlink] $SYMLINK exists but is not a symlink. Refusing to replace."
  exit 1
fi

# Symlink missing → create
ln -s "$TARGET_RELATIVE" "$SYMLINK"
log "[pipeline-symlink] Created: pipeline → $TARGET_RELATIVE"
