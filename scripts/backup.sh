#!/usr/bin/env bash
#
# NanoClaw site-specific backup
#
# Creates a compressed archive of everything needed to rebuild this
# installation on a new machine: secrets, database, auth credentials,
# certificates, configuration, and systemd service files.
#
# Usage:
#   ./scripts/backup.sh                  # backup to default location
#   ./scripts/backup.sh /mnt/usb/        # backup to specific directory
#   ./scripts/backup.sh --include-logs   # include application logs
#
# The archive preserves file permissions (important for mode-600 secrets).
# SQLite is backed up via .backup to guarantee consistency even while
# nanoclaw is running.

set -euo pipefail

NANOCLAW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${NANOCLAW_DIR}/backups"
INCLUDE_LOGS=false

for arg in "$@"; do
  case "$arg" in
    --include-logs) INCLUDE_LOGS=true ;;
    -*) echo "Unknown option: $arg" >&2; exit 1 ;;
    *) BACKUP_DIR="$arg" ;;
  esac
done

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
STAGING_DIR=$(mktemp -d "/tmp/nanoclaw-backup-${TIMESTAMP}.XXXXXX")
DEST="${STAGING_DIR}/nanoclaw-backup"
mkdir -p "$DEST"

cleanup() { rm -rf "$STAGING_DIR"; }
trap cleanup EXIT

echo "NanoClaw backup — $(date -Iseconds)"
echo "Source:  $NANOCLAW_DIR"
echo "Staging: $STAGING_DIR"
echo ""

# --- helpers ---

copy_if_exists() {
  local src="$1" dest_subdir="$2"
  if [ -e "$src" ]; then
    mkdir -p "${DEST}/${dest_subdir}"
    cp -a "$src" "${DEST}/${dest_subdir}/"
    echo "  + ${dest_subdir}/$(basename "$src")"
  fi
}

copy_dir_if_exists() {
  local src="$1" dest_subdir="$2"
  if [ -d "$src" ]; then
    mkdir -p "${DEST}/${dest_subdir}"
    cp -a "$src" "${DEST}/${dest_subdir}/"
    echo "  + ${dest_subdir}/$(basename "$src")/"
  fi
}

# --- 1. Secrets & environment ---

echo "Secrets & environment:"
copy_if_exists "${NANOCLAW_DIR}/.env" "."
copy_if_exists "${NANOCLAW_DIR}/.gitleaks-local.toml" "."

# --- 2. Database (consistent snapshot via sqlite3 .backup) ---

echo "Database:"
DB="${NANOCLAW_DIR}/store/messages.db"
if [ -f "$DB" ]; then
  mkdir -p "${DEST}/store"
  sqlite3 "$DB" ".backup '${DEST}/store/messages.db'"
  echo "  + store/messages.db (sqlite3 .backup)"
else
  echo "  ! store/messages.db not found — skipping"
fi

# --- 3. WhatsApp auth ---

echo "WhatsApp auth:"
copy_dir_if_exists "${NANOCLAW_DIR}/store/auth" "store"
copy_if_exists "${NANOCLAW_DIR}/store/auth-status.txt" "store"

# --- 4. TLS certificates ---

echo "TLS certificates:"
copy_dir_if_exists "${NANOCLAW_DIR}/data/tls" "data"

# --- 5. Site-specific configuration ---

echo "Configuration:"
# Back up all site-specific JSON config files in data/
for cfg in "${NANOCLAW_DIR}"/data/*.json; do
  [ -f "$cfg" ] || continue
  copy_if_exists "$cfg" "data"
done
copy_dir_if_exists "${NANOCLAW_DIR}/data/env" "data"

# --- 6. Gitignored group files (OLLAMA.md, SLACK.md, etc.) ---

echo "Group-specific files (gitignored):"
cd "$NANOCLAW_DIR"
git ls-files --others --ignored --exclude-standard -- groups/ \
  | grep -v '\.pagepilot' \
  | grep -v '/logs/' \
  | while read -r f; do
      dir=$(dirname "$f")
      mkdir -p "${DEST}/${dir}"
      cp -a "$f" "${DEST}/${f}"
      echo "  + $f"
    done

# --- 7. PagePilot run history (small, useful for continuity) ---

echo "PagePilot run history:"
for pp_dir in "${NANOCLAW_DIR}"/groups/*/.pagepilot; do
  [ -d "$pp_dir" ] || continue
  rel="${pp_dir#"${NANOCLAW_DIR}/"}"
  copy_dir_if_exists "$pp_dir" "$(dirname "$rel")"
done

# --- 8. Systemd service files ---

echo "Systemd services:"
SYSTEMD_DIR="${HOME}/.config/systemd/user"
if [ -d "$SYSTEMD_DIR" ]; then
  mkdir -p "${DEST}/systemd"
  for svc in "${SYSTEMD_DIR}"/nanoclaw*.service; do
    [ -f "$svc" ] || continue
    cp -a "$svc" "${DEST}/systemd/"
    echo "  + systemd/$(basename "$svc")"
  done
fi

# --- 9. Logs (optional) ---

if [ "$INCLUDE_LOGS" = true ]; then
  echo "Logs:"
  for logfile in "${NANOCLAW_DIR}"/logs/*.log; do
    [ -f "$logfile" ] || continue
    copy_if_exists "$logfile" "logs"
  done
  for group_log_dir in "${NANOCLAW_DIR}"/groups/*/logs; do
    [ -d "$group_log_dir" ] || continue
    rel="${group_log_dir#"${NANOCLAW_DIR}/"}"
    copy_dir_if_exists "$group_log_dir" "$(dirname "$rel")"
  done
else
  echo "Logs: skipped (use --include-logs to include)"
fi

# --- 10. Create archive ---

mkdir -p "$BACKUP_DIR"
ARCHIVE="${BACKUP_DIR}/nanoclaw-backup-${TIMESTAMP}.tar.gz"
tar czf "$ARCHIVE" -C "$STAGING_DIR" "nanoclaw-backup"

SIZE=$(du -sh "$ARCHIVE" | cut -f1)
echo ""
echo "Backup complete: $ARCHIVE ($SIZE)"

# --- 11. Verify archive ---

FILE_COUNT=$(tar tzf "$ARCHIVE" | wc -l)
echo "Archive contains $FILE_COUNT files"

# --- 12. Prune old backups (keep last 5) ---

KEPT=0
for old in $(ls -t "${BACKUP_DIR}"/nanoclaw-backup-*.tar.gz 2>/dev/null); do
  KEPT=$((KEPT + 1))
  if [ "$KEPT" -gt 5 ]; then
    rm -f "$old"
    echo "Pruned old backup: $(basename "$old")"
  fi
done
