#!/usr/bin/env bash
# Smoke-tests an already built image exactly as production runs it (deploy/docker-compose.yml
# hardening). Used by CI on the image it is about to hand over, so what passes here is the
# same image ID that can later be published.
# Usage: scripts/ci/smoke-image.sh <image> <expected-revision>
# Needs: docker, curl, python3 (no Node on the host required). Makes no outbound calls of its own and never asks the app
# to register a WARP device.
set -euo pipefail

IMAGE="$1"
REVISION="$2"
NAME="amnezia-smoke-$$"
PORT="${SMOKE_PORT:-13180}"
BASE="http://127.0.0.1:${PORT}"
VERSION="$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')"
FAILURES=0

fail() { echo "FAIL: $*"; FAILURES=$((FAILURES + 1)); }
pass() { echo "ok:   $*"; }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

cleanup() {
  if [ "$FAILURES" -gt 0 ]; then docker logs --tail 50 "$NAME" 2>&1 || true; fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== image metadata"
check "revision label = ${REVISION}" \
  '[ "$(docker image inspect -f "{{index .Config.Labels \"org.opencontainers.image.revision\"}}" "$IMAGE")" = "$REVISION" ]'
check "APP_REVISION env = ${REVISION}" \
  'grep -qx "APP_REVISION=${REVISION}" <<<"$(docker image inspect -f "{{range .Config.Env}}{{println .}}{{end}}" "$IMAGE")"'
check "runs as non-root user node" '[ "$(docker image inspect -f "{{.Config.User}}" "$IMAGE")" = node ]'
check "has a HEALTHCHECK" '[ -n "$(docker image inspect -f "{{if .Config.Healthcheck}}{{.Config.Healthcheck.Test}}{{end}}" "$IMAGE")" ]'

echo "== start with production hardening"
docker run -d --name "$NAME" \
  --read-only --tmpfs /tmp:size=16m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 256m --cpus 1 --pids-limit 128 \
  -p "127.0.0.1:${PORT}:3000" "$IMAGE" >/dev/null

status=starting
for _ in $(seq 1 45); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo missing)"
  [ "$status" = healthy ] && break
  [ "$status" = unhealthy ] && break
  sleep 2
done
check "container becomes healthy (got: ${status})" '[ "$status" = healthy ]'

echo "== image contents"
check "no devDependencies (eslint absent)" '! docker exec "$NAME" test -e /app/node_modules/eslint'
for path in /app/__tests__ /app/.git /app/docs /app/.github /app/deploy; do
  check "absent: ${path}" "! docker exec \"\$NAME\" test -e ${path}"
done
check "process runs as uid != 0" '[ "$(docker exec "$NAME" id -u)" != 0 ]'

echo "== HTTP"
# Body checks read here-strings, not pipes: under pipefail, printf piped into an early-exiting
# grep -q fails spuriously once a body exceeds the pipe buffer (printf gets SIGPIPE).
# get <path> -> sets CODE, TYPE, CACHE, BODY
get() {
  local headers
  headers="$(mktemp)"
  BODY="$(curl -s --path-as-is -m 15 -D "$headers" "${BASE}$1" || true)"
  CODE="$(awk 'NR==1{print $2}' "$headers")"
  TYPE="$(grep -i '^content-type:' "$headers" | tr -d '\r' | cut -d' ' -f2- || true)"
  CACHE="$(grep -i '^cache-control:' "$headers" | tr -d '\r' | cut -d' ' -f2- || true)"
  CSP="$(grep -ci '^content-security-policy:' "$headers" || true)"
  rm -f "$headers"
}
is_json() { python3 -c 'import json, sys; json.load(sys.stdin)' <<<"$BODY" 2>/dev/null; }

get /
check "/ -> 200 html" '[ "$CODE" = 200 ] && [[ "$TYPE" == text/html* ]]'
check "/ references assets ?v=${VERSION}" 'grep -q "?v=${VERSION}\"" <<<"$BODY"'
check "/ sends a Content-Security-Policy" '[ "$CSP" -ge 1 ]'
get /status.html
check "/status.html -> 200, uses live-status.js" '[ "$CODE" = 200 ] && grep -q "static/live-status.js" <<<"$BODY"'
get "/static/live-status.js?v=${VERSION}"
check "/static/live-status.js -> 200" '[ "$CODE" = 200 ]'
for api in /api/status /api/healthcheck /api/iplist; do
  get "$api"
  check "${api} -> 200 JSON, Cache-Control: no-store" '[ "$CODE" = 200 ] && is_json && [ "$CACHE" = no-store ]'
done
get "/api/warp?mode=awg2&cps=tls"
check "/api/warp rejects an unsupported CPS protocol before contacting Cloudflare" \
  '[ "$CODE" = 400 ] && grep -q unsupported_cps_protocol <<<"$BODY"'
for path in /package.json /server.js /.git/config /api/../package.json /static/../../package.json /status.json; do
  get "$path"
  check "${path} -> 404" '[ "$CODE" = 404 ]'
done

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "image smoke: ${FAILURES} failure(s)"
  exit 1
fi
echo "image smoke: all checks passed for ${IMAGE} (${REVISION})"
