#!/usr/bin/env bash
# Deploys one commit of the URL shortener on this instance.
#
# Usage: deploy.sh <commit-sha>
#
# Run as root by SSM Run Command (from the GitHub Actions workflow). Steps:
#   1. as user `app`: fetch and check out the exact commit in /opt/app
#   2. as user `app`: npm ci --omit=dev
#   3. as user `app`: apply db/schema.sql (idempotent) using the same env file systemd uses
#   4. restart the systemd service and wait for /health to answer 200
#
# Note: SSM runs the copy of this script already checked out on the instance, so a change
# to deploy.sh itself takes effect on the deploy *after* the one that ships it.

set -euo pipefail

APP_DIR=/opt/app
APP_USER=app
ENV_FILE=/etc/url-shortener/app.env
SERVICE=url-shortener
HEALTH_URL=http://127.0.0.1:3000/health

SHA="${1:-}"
if [[ -z "$SHA" ]]; then
  echo "usage: $0 <commit-sha>" >&2
  exit 1
fi
if [[ ! -r "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE is missing or unreadable" >&2
  exit 1
fi

step() { echo; echo "==> $*"; }

step "1/4 Checking out $SHA in $APP_DIR"
sudo -u "$APP_USER" git -C "$APP_DIR" fetch --quiet origin
sudo -u "$APP_USER" git -C "$APP_DIR" checkout --quiet --detach "$SHA"
sudo -u "$APP_USER" git -C "$APP_DIR" log -1 --oneline

step "2/4 Installing production dependencies"
sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && npm ci --omit=dev --no-audit --no-fund"

step "3/4 Applying database schema"
# Source the same env file the systemd unit loads, so the migration connects with the same
# settings as the app. The password is fetched from Parameter Store inside migrate.js.
sudo -u "$APP_USER" bash -c "set -a; . '$ENV_FILE'; set +a; cd '$APP_DIR' && node scripts/migrate.js"

step "4/4 Restarting $SERVICE"
systemctl restart "$SERVICE"

for attempt in $(seq 1 10); do
  if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
    echo "health check passed (attempt $attempt)"
    echo
    echo "Deployed $SHA successfully."
    exit 0
  fi
  sleep 2
done

echo "error: $HEALTH_URL did not return 200 after restart" >&2
systemctl status "$SERVICE" --no-pager || true
journalctl -u "$SERVICE" -n 50 --no-pager || true
exit 1
