#!/usr/bin/env bash
# Runs locally. Ships a committed revision to the VPS and activates it.
# Usage: DEPLOY_HOST=root@<vps-ip> deploy/deploy.sh [git-ref]     (default ref: HEAD)
#        DEPLOY_KEY=~/.ssh/key overrides the SSH key (default ~/.ssh/amnezia_vps)
# Rollback = deploy the previous ref again (its image is reused, no rebuild).
set -euo pipefail

HOST="${DEPLOY_HOST:?set DEPLOY_HOST=user@host}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/amnezia_vps}"
REF="${1:-HEAD}"
SHA="$(git rev-parse --short=12 "${REF}^{commit}")"
SSH=(ssh -i "$KEY" -o BatchMode=yes "$HOST")

echo "deploying $REF ($SHA) to $HOST"
git archive --format=tar "$SHA" | "${SSH[@]}" "set -e
  d=/opt/amnezia-web/releases/$SHA
  rm -rf \"\$d\" && mkdir -p \"\$d\" && tar -xf - -C \"\$d\" && echo $SHA > \"\$d/REVISION\""
"${SSH[@]}" "sh /opt/amnezia-web/releases/$SHA/deploy/remote-activate.sh $SHA"
"${SSH[@]}" "curl -fsS -o /dev/null -w 'public /api/status: %{http_code}\n' --resolve valokda-amnezia.185-77-219-233.sslip.io:443:127.0.0.1 https://valokda-amnezia.185-77-219-233.sslip.io/api/status" || true
