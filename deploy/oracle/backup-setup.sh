#!/usr/bin/env bash
# Turns on nightly off-server backups to a cloud bucket (AWS Lightsail bucket, AWS S3, Backblaze B2,
# Cloudflare R2: anything S3-compatible). Asks for the bucket and its access keys, saves them where
# only root can read them, and runs a first backup to check it works.
#   sudo bash /opt/bob-moses-leads/deploy/oracle/backup-setup.sh
set -euo pipefail
SERVICE=bob-moses-leads
OFFSITE_ENV=/etc/$SERVICE-backup.env
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ $EUID -ne 0 ]]; then echo "Run this with sudo." >&2; exit 1; fi

echo "Off-server backups: the database and photos go to your cloud bucket every night."
read -rp "Bucket name: " BUCKET
read -rp "Region (Lightsail/AWS, e.g. us-west-2): " REGION
read -rp "Endpoint (leave blank for a Lightsail or AWS bucket): " ENDPOINT
read -rp "Access key ID: " KEY_ID
read -rsp "Secret access key: " SECRET; echo
read -rp "Keep database copies for how many days? [30]: " KEEP
umask 077
cat > "$OFFSITE_ENV" <<CONF
# Off-server backups (read by deploy/oracle/backup.sh). Root only.
BACKUP_S3_BUCKET=$BUCKET
BACKUP_S3_REGION=${REGION:-us-east-1}
BACKUP_S3_ENDPOINT=$ENDPOINT
BACKUP_S3_KEY_ID=$KEY_ID
BACKUP_S3_SECRET=$SECRET
BACKUP_KEEP_DAYS=${KEEP:-30}
CONF
chmod 600 "$OFFSITE_ENV"

# Point the nightly job at the backup script that ships with the app.
cat > /etc/cron.daily/$SERVICE-backup <<CRON
#!/bin/sh
exec /usr/bin/env bash $APP_DIR/deploy/oracle/backup.sh
CRON
chmod 755 /etc/cron.daily/$SERVICE-backup

echo "==> Running a first backup now"
if bash "$APP_DIR/deploy/oracle/backup.sh"; then
  echo "Done. Backups go to $BUCKET every night; the app shows the last one under Team."
else
  echo "The backup didn't work. Check the bucket name, region and keys, then run this again." >&2
  exit 1
fi
