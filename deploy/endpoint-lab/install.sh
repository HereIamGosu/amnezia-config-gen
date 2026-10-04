#!/bin/sh
# Usage (root, from an extracted git archive of that commit): sh install.sh <full-commit-sha>
# Installs or updates the endpoint-lab CLI and its systemd units. Idempotent.
# It does NOT install packages, create or touch the probe identity, run probes, or enable/start any
# timer: install != activate. A running oneshot keeps the code it already loaded (atomic rename).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
rev="${1:-}"
case "$rev" in
  ""|*[!0-9a-f]*) echo "usage: install.sh <full-commit-sha>" >&2; exit 2 ;;
esac
[ "${#rev}" -eq 40 ] || { echo "usage: install.sh <full-commit-sha>" >&2; exit 2; }

install -d -o root -g root -m 0700 /etc/amnezia-endpoint-lab /var/lib/amnezia-endpoint-lab
# Ubuntu's AppArmor profile for /usr/bin/wg lets it read key files only under /etc/wireguard/**.
install -d -o root -g root -m 0700 /etc/wireguard /etc/wireguard/amnezia-endpoint-lab
install -d -o root -g root -m 0755 /var/lib/amnezia-endpoint-lab/public /usr/local/share/amnezia-endpoint-lab

install -o root -g root -m 0755 "$here/endpoint_lab.py" /usr/local/sbin/.endpoint-lab.new
mv -f /usr/local/sbin/.endpoint-lab.new /usr/local/sbin/endpoint-lab
sha="$(sha256sum /usr/local/sbin/endpoint-lab | cut -d' ' -f1)"
printf '{"commit": "%s", "sha256": "%s", "installed_at": "%s"}\n' "$rev" "$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > /usr/local/share/amnezia-endpoint-lab/REVISION.new
chmod 0644 /usr/local/share/amnezia-endpoint-lab/REVISION.new
mv -f /usr/local/share/amnezia-endpoint-lab/REVISION.new /usr/local/share/amnezia-endpoint-lab/REVISION

for unit in amnezia-endpoint-lab-refresh.service amnezia-endpoint-lab-refresh.timer \
            amnezia-endpoint-lab-discovery.service amnezia-endpoint-lab-discovery.timer; do
  install -o root -g root -m 0644 "$here/systemd/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
for t in amnezia-endpoint-lab-refresh.timer amnezia-endpoint-lab-discovery.timer; do
  echo "$t: $(systemctl is-enabled "$t" 2>/dev/null || true) / $(systemctl is-active "$t" 2>/dev/null || true)"
done
echo "installed endpoint-lab $rev (sha256 $sha); timers are not enabled by this script"
