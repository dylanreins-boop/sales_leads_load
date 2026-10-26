#!/usr/bin/env bash
# Pulls the latest code from GitHub and restarts the app. Run on the server:
#   bash /opt/bob-moses-leads/deploy/oracle/update.sh
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$APP_DIR"
git pull --ff-only origin main
sudo systemctl restart bob-moses-leads
sleep 2
systemctl is-active --quiet bob-moses-leads && echo "Updated to $(git log --oneline -1)" \
  || { echo "The app didn't start. Check: journalctl -u bob-moses-leads -n 50" >&2; exit 1; }
