#!/usr/bin/env bash
# Pulse — install or update on the Contabo VPS. Run from a checkout of the repo:
#   sudo bash deploy/install.sh
# It ONLY touches Pulse's own pieces and leaves every other site and service alone:
#   /var/www/bluecredit-pulse            the website
#   /opt/bluecredit-pulse                the two server functions (Deno)
#   /etc/bluecredit-pulse/pulse.env      secrets (created once, never overwritten)
#   /etc/nginx/sites-available|enabled/pulse.bluecredits.org
#   pulse-calendar.service (127.0.0.1:8091), pulse-chief.service (127.0.0.1:8092),
#   pulse-calendar-sync.timer (every 15 minutes), user "bcpulse"
# nginx is only reloaded after `nginx -t` passes; nothing else is restarted.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WEB=/var/www/bluecredit-pulse; APP=/opt/bluecredit-pulse; ETC=/etc/bluecredit-pulse
DOMAIN=pulse.bluecredits.org; DENO_VERSION=2.9.6
say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }

say "Checking the ports Pulse uses are free (or already Pulse's)"
for p in 8091 8092; do
  if ss -ltnp 2>/dev/null | grep -q "127.0.0.1:$p " && ! ss -ltnp | grep "127.0.0.1:$p " | grep -q deno; then
    echo "Port $p is used by something else. Edit the ports in deploy/*.service and nginx-pulse.conf first."; exit 1
  fi
done

say "Service user and folders"
id bcpulse >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin bcpulse
install -d -o root -g root -m 755 "$WEB" "$APP"
install -d -o root -g bcpulse -m 750 "$ETC"

say "Deno $DENO_VERSION (installed to /usr/local/bin only if missing or older)"
if ! command -v deno >/dev/null || [ "$(deno --version | head -1 | awk '{print $2}')" != "$DENO_VERSION" ]; then
  tmp=$(mktemp -d); curl -fsSL "https://github.com/denoland/deno/releases/download/v$DENO_VERSION/deno-x86_64-unknown-linux-gnu.zip" -o "$tmp/deno.zip"
  (cd "$tmp" && unzip -q deno.zip) && install -m 755 "$tmp/deno" /usr/local/bin/deno && rm -rf "$tmp"
fi

say "Website → $WEB"
rsync -a --delete --exclude '.DS_Store' "$REPO/web/" "$WEB/"
# point the site at this server's functions
sed -i 's#^\(\s*\)// functionsUrl:.*#\1functionsUrl: "https://'"$DOMAIN"'/fn",#' "$WEB/config.js"
sed -i 's#apps: { scheduler: false, chief: false },#apps: { scheduler: true, chief: true },#' "$WEB/config.js"
grep -q 'functionsUrl' "$WEB/config.js" || sed -i 's#appName:#functionsUrl: "https://'"$DOMAIN"'/fn",\n  appName:#' "$WEB/config.js"

say "Server functions → $APP"
rsync -a --delete --exclude '*_test.ts' --exclude 'testkit.ts' "$REPO/supabase/functions/" "$APP/functions/"
chown -R root:root "$APP/functions"
DENO_DIR="$APP/.deno" deno cache "$APP/functions/calendar/index.ts" "$APP/functions/chief/index.ts"
chown -R bcpulse:bcpulse "$APP/.deno"

say "Secrets file $ETC/pulse.env"
if [ ! -f "$ETC/pulse.env" ]; then
  cp "$REPO/deploy/pulse.env.example" "$ETC/pulse.env"
  sed -i "s#^CALENDAR_SECRET=.*#CALENDAR_SECRET=$(openssl rand -hex 32)#; s#^CRON_SECRET=.*#CRON_SECRET=$(openssl rand -hex 24)#" "$ETC/pulse.env"
  echo "Created. Fill in SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY and the Google/Microsoft keys, then run this script again."
fi
chown root:bcpulse "$ETC/pulse.env"; chmod 640 "$ETC/pulse.env"

say "systemd services"
install -m 644 "$REPO/deploy/pulse-calendar.service" "$REPO/deploy/pulse-chief.service" \
  "$REPO/deploy/pulse-calendar-sync.service" "$REPO/deploy/pulse-calendar-sync.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pulse-calendar.service pulse-chief.service pulse-calendar-sync.timer
systemctl restart pulse-calendar.service pulse-chief.service

say "nginx site for $DOMAIN"
install -m 644 "$REPO/deploy/nginx-pulse.conf" "/etc/nginx/sites-available/$DOMAIN.new"
if [ -f "/etc/nginx/sites-available/$DOMAIN" ] && grep -q "managed by Certbot" "/etc/nginx/sites-available/$DOMAIN"; then
  rm "/etc/nginx/sites-available/$DOMAIN.new"   # keep the certbot-edited copy; update locations by hand if they change
else
  mv "/etc/nginx/sites-available/$DOMAIN.new" "/etc/nginx/sites-available/$DOMAIN"
fi
ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
nginx -t && systemctl reload nginx

say "HTTPS certificate"
if ! grep -q "managed by Certbot" "/etc/nginx/sites-available/$DOMAIN"; then
  if getent hosts "$DOMAIN" >/dev/null; then certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect -m barasa@bluecredits.org || echo "certbot failed: check DNS, then run: certbot --nginx -d $DOMAIN"
  else echo "DNS for $DOMAIN doesn't point here yet. Add an A record to this server's IP, then run: certbot --nginx -d $DOMAIN"; fi
fi

say "Health"
sleep 1
for s in pulse-calendar pulse-chief; do printf '%-16s %s\n' "$s" "$(systemctl is-active $s)"; done
curl -s -o /dev/null -w 'calendar function: HTTP %{http_code}\n' -X POST http://127.0.0.1:8091/ -d '{}' || true
curl -s -o /dev/null -w 'chief function:    HTTP %{http_code}\n' -X POST http://127.0.0.1:8092/ -d '{}' || true
echo "(401 = running and asking for sign-in, which is right.) Site: https://$DOMAIN/"
