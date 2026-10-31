#!/usr/bin/env bash
# Nightly backup, run by cron (/etc/cron.daily/bob-moses-leads-backup). Run it by hand to test:
#   sudo bash /opt/bob-moses-leads/deploy/oracle/backup.sh
#
# 1. A copy of the database on this server, kept 14 days in /var/backups/bob-moses-leads.
# 2. Once off-server backups are set up (backup-setup.sh), a copy of the database and every photo
#    in your cloud bucket, so nothing is lost if the server is.
set -uo pipefail
SERVICE=bob-moses-leads
RUN_USER=leads
DATA_DIR=/var/lib/$SERVICE
BACKUP_DIR=/var/backups/$SERVICE
OFFSITE_ENV=/etc/$SERVICE-backup.env
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

mkdir -p "$BACKUP_DIR"
sqlite3 "$DATA_DIR/leads.db" ".backup '$BACKUP_DIR/leads-$(date +%F).db'"
find "$BACKUP_DIR" -name 'leads-*.db' -mtime +14 -delete

if [[ -f "$OFFSITE_ENV" ]]; then
  STATUS="$DATA_DIR/offsite-status.json"
  set -a
  # shellcheck disable=SC1090
  . "$OFFSITE_ENV"
  set +a
  rc=0
  DB_PATH="$DATA_DIR/leads.db" PHOTOS_DIR="$DATA_DIR/photos" BACKUP_DIR="$BACKUP_DIR" BACKUP_STATUS_FILE="$STATUS" \
    /usr/bin/node --disable-warning=ExperimentalWarning "$APP_DIR/scripts/backup-offsite.js" 2>&1 | tee >(logger -t "$SERVICE-backup") || rc=$?
  # The app reads the result to show admins when the last off-server copy was made.
  chown "$RUN_USER:$RUN_USER" "$STATUS" 2>/dev/null || true
  exit $rc
fi
