#!/bin/bash
# Run as root from the unpacked deployment directory on a fresh Ubuntu VM.
set -euo pipefail
cd "$(dirname "$0")"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends nginx nodejs python3-venv ca-certificates
if [ ! -x /opt/racktop-certbot/bin/python ]; then
    python3 -m venv /opt/racktop-certbot
fi
if [ -f certbot-requirements.txt ]; then
    /opt/racktop-certbot/bin/pip install --disable-pip-version-check -r certbot-requirements.txt
else
    /opt/racktop-certbot/bin/pip install --disable-pip-version-check 'certbot==5.8.0'
fi
/opt/racktop-certbot/bin/pip freeze > /opt/racktop-certbot/requirements-lock.txt
install -d -m 755 /var/www/letsencrypt/.well-known/acme-challenge
install -m 644 nginx-bootstrap.conf /etc/nginx/sites-available/racktop-relay
if [ "$(readlink /etc/nginx/sites-enabled/default || true)" = /etc/nginx/sites-available/default ]; then
    rm /etc/nginx/sites-enabled/default
fi
ln -sfn /etc/nginx/sites-available/racktop-relay /etc/nginx/sites-enabled/racktop-relay
nginx -t
systemctl enable --now nginx
systemctl reload nginx
/opt/racktop-certbot/bin/certbot --version
node --version
