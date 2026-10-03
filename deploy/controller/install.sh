#!/bin/sh
# Installs the amnezia-deploy controller on the VPS (run as root from an extracted git archive).
# It does NOT bootstrap, touch nginx, deploy anything or enable the deployment timer.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"

install -o root -g root -m 0755 "$here/amnezia_deploy.py" /usr/local/sbin/amnezia-deploy
install -d -o root -g root -m 0750 /var/lib/amnezia-deploy
install -d -o root -g root -m 0755 /etc/amnezia-deploy /etc/nginx/amnezia-deploy
for unit in amnezia-deploy-check.service amnezia-deploy-check.timer amnezia-deploy-reconcile.service; do
  install -o root -g root -m 0644 "$here/systemd/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable amnezia-deploy-reconcile.service   # boot-time reconcile only; never deploys
systemctl disable amnezia-deploy-check.timer 2>/dev/null || true
echo "installed; timer state: $(systemctl is-enabled amnezia-deploy-check.timer 2>/dev/null || true)"
