#!/usr/bin/env bash
# One-time setup of the lead pipeline on a fresh Oracle Cloud (or any Ubuntu 22.04/24.04) server.
#
#   sudo bash /opt/bob-moses-leads/deploy/oracle/setup.sh leads.bobmosescc.com
#
# Installs Node.js 22 and Caddy (the web server, which gets the https certificate on its own),
# runs the app as a service that restarts on its own, opens ports 80/443, and backs up the
# database every night. Safe to run again: it keeps your settings file and database.
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE=bob-moses-leads
RUN_USER=leads
DATA_DIR=/var/lib/$SERVICE
BACKUP_DIR=/var/backups/$SERVICE
ENV_FILE=/etc/$SERVICE.env

if [[ $EUID -ne 0 ]]; then echo "Run this with sudo." >&2; exit 1; fi
if [[ -z "$DOMAIN" ]]; then echo "Usage: sudo bash $0 leads.yourdomain.com" >&2; exit 1; fi
if [[ ! -f "$APP_DIR/server.js" ]]; then echo "Can't find server.js in $APP_DIR." >&2; exit 1; fi

# Small servers (512 MB, like the $5 Lightsail plan) get a swap file so installs don't run out of memory.
if [[ $(awk '/MemTotal/ {print $2}' /proc/meminfo) -lt 1500000 && ! -f /swapfile ]]; then
  echo "==> Adding a 1 GB swap file (this server has under 1.5 GB of memory)"
  fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git sqlite3 debian-keyring debian-archive-keyring apt-transport-https iptables-persistent

echo "==> Installing Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".").map(Number).reduce((a, n, i) => a + n * [1e6, 1e3, 1][i], 0)')" -lt 22013000 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "==> Installing Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> Opening ports 80 and 443 in the server firewall"
# Oracle's Ubuntu images block everything but SSH. (Also add the ports in the Oracle console's Security List.)
for port in 80 443; do
  iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null \
    || iptables -I INPUT 1 -p tcp -m state --state NEW --dport "$port" -j ACCEPT
done
netfilter-persistent save

echo "==> Creating the app user and folders"
id -u "$RUN_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$RUN_USER"
mkdir -p "$DATA_DIR/photos" "$BACKUP_DIR"
chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR" "$BACKUP_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> Settings: your first admin login"
  read -rp "Admin name (e.g. Dylan): " ADMIN_NAME
  while true; do
    read -rsp "Admin password (8+ characters): " ADMIN_PASS; echo
    read -rsp "Same password again: " ADMIN_PASS2; echo
    if [[ "$ADMIN_PASS" == *[,\"\'\\]* || "$ADMIN_NAME" == *[,:\"\'\\]* ]]; then
      echo "Leave out commas, quotes and backslashes (and colons in the name). Try again."
      continue
    fi
    [[ "$ADMIN_PASS" == "$ADMIN_PASS2" && ${#ADMIN_PASS} -ge 8 ]] && break
    echo "They didn't match or were too short. Try again."
  done
  umask 077
  cat > "$ENV_FILE" <<CONF
# Settings for the lead pipeline. After changing anything: sudo systemctl restart $SERVICE
PORT=3000
HOST=127.0.0.1
TRUST_PROXY=true
DB_PATH=$DATA_DIR/leads.db
PHOTOS_DIR=$DATA_DIR/photos
TZ=America/Los_Angeles
APP_USERS=$ADMIN_NAME:$ADMIN_PASS:admin
BRAND_NAME=Bob Moses Ceramic Coating
BRAND_SHORT_NAME=Bob Moses Leads
BRAND_CITY=Las Vegas
BRAND_PHONE=(702) 600-1128
BRAND_ADDRESS=3120 W Sirius Ave Ste 103, Las Vegas, NV 89102
BRAND_WEBSITE=https://bobmosescc.com/locations/las-vegas-nv/
REMINDER_HOUR=9
REMINDER_SKIP_WEEKENDS=true
LEAD_ARCHIVE_DAYS=14
CORS_ORIGINS=https://bobmosescc.com,https://www.bobmosescc.com
# Add these when you have them:
# WEBSITE_API_KEY=
# EMAIL_PROVIDER=resend
# EMAIL_API_KEY=
# EMAIL_FROM=Bob Moses Ceramic Coating <leads@yourdomain.com>
# FB_VERIFY_TOKEN=
# FB_APP_SECRET=
# FB_PAGE_ACCESS_TOKEN=
# FB_FORM_IDS=
# PUBLIC_URL=https://$DOMAIN
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_FROM=+1702...
# STRIPE_SECRET_KEY=
# STRIPE_WEBHOOK_SECRET=
CONF
  chmod 600 "$ENV_FILE"
  echo "Saved $ENV_FILE"
else
  echo "==> Keeping your existing settings in $ENV_FILE"
fi

echo "==> Setting up the app service"
cat > /etc/systemd/system/$SERVICE.service <<UNIT
[Unit]
Description=Bob Moses lead pipeline
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$DATA_DIR
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now $SERVICE
systemctl restart $SERVICE

echo "==> Pointing $DOMAIN at the app (Caddy gets the https certificate)"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
CADDY
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

echo "==> Nightly backup (database kept 14 days in $BACKUP_DIR; off-server too once backup-setup.sh is run)"
cat > /etc/cron.daily/$SERVICE-backup <<CRON
#!/bin/sh
exec /usr/bin/env bash $APP_DIR/deploy/oracle/backup.sh
CRON
chmod 755 /etc/cron.daily/$SERVICE-backup

sleep 2
if systemctl is-active --quiet $SERVICE; then
  echo
  echo "Done. The app is running."
  echo "Once $DOMAIN points at this server's public IP (an A record in Namecheap),"
  echo "open https://$DOMAIN and sign in. The certificate can take a minute the first time."
else
  echo "The app didn't start. See what went wrong with: journalctl -u $SERVICE -n 50" >&2
  exit 1
fi
