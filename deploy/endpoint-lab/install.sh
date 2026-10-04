#!/bin/sh
# Installs the endpoint-lab CLI on the Lab host (run as root from an extracted git archive).
# It does NOT install packages, register a probe identity, run probes, install or enable any
# systemd unit/timer, or touch the web runtime. Phase A runs the CLI by hand.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"

install -o root -g root -m 0755 "$here/endpoint_lab.py" /usr/local/sbin/endpoint-lab
install -d -o root -g root -m 0700 /etc/amnezia-endpoint-lab /var/lib/amnezia-endpoint-lab
# Ubuntu's AppArmor profile for /usr/bin/wg lets it read key files only under /etc/wireguard/**.
install -d -o root -g root -m 0700 /etc/wireguard /etc/wireguard/amnezia-endpoint-lab
install -d -o root -g root -m 0755 /var/lib/amnezia-endpoint-lab/public
echo "installed /usr/local/sbin/endpoint-lab; candidates file: /etc/amnezia-endpoint-lab/candidates.json"
