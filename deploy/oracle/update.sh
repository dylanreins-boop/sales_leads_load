#!/usr/bin/env bash
# Pulls the latest code from GitHub and restarts the app. Run on the server:
#   bash /opt/bob-moses-leads/deploy/oracle/update.sh
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$APP_DIR"
git pull --ff-only origin main
# The nightly backup runs the script that ships with the app (so backup changes arrive with updates).
printf '#!/bin/sh\nexec /usr/bin/env bash %s/deploy/oracle/backup.sh\n' "$APP_DIR" | sudo tee /etc/cron.daily/bob-moses-leads-backup >/dev/null
sudo chmod 755 /etc/cron.daily/bob-moses-leads-backup
sudo systemctl restart bob-moses-leads
sleep 2
systemctl is-active --quiet bob-moses-leads && echo "Updated to $(git log --oneline -1)" \
  || { echo "The app didn't start. Check: journalctl -u bob-moses-leads -n 50" >&2; exit 1; }
