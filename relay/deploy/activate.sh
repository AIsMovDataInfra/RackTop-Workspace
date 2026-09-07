#!/bin/bash
# Run as root from the unpacked deployment directory after certificate issuance.
set -euo pipefail
cd "$(dirname "$0")"
test -s /etc/letsencrypt/live/racktop-relay-ip/fullchain.pem
test -s /etc/letsencrypt/live/racktop-relay-ip/privkey.pem
if ! id racktop-relay >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin racktop-relay
fi
install -d -o root -g racktop-relay -m 750 /etc/racktop-relay
if [ ! -e /etc/racktop-relay/owner-token ]; then
    (umask 077; python3 -c 'import secrets; print(secrets.token_urlsafe(32))' > /etc/racktop-relay/owner-token)
fi
chown racktop-relay:racktop-relay /etc/racktop-relay/owner-token
chmod 600 /etc/racktop-relay/owner-token
install -m 644 racktop-relay.service /etc/systemd/system/racktop-relay.service
install -m 644 racktop-certbot-renew.service /etc/systemd/system/racktop-certbot-renew.service
install -m 644 racktop-certbot-renew.timer /etc/systemd/system/racktop-certbot-renew.timer
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
install -m 755 renew-hook.sh /etc/letsencrypt/renewal-hooks/deploy/racktop-nginx
install -m 644 nginx.conf /etc/nginx/sites-available/racktop-relay
nginx -t
systemctl daemon-reload
systemctl enable racktop-relay.service racktop-certbot-renew.timer
systemctl restart racktop-relay.service
systemctl start racktop-certbot-renew.timer
systemctl reload nginx
systemctl is-active racktop-relay nginx racktop-certbot-renew.timer
