#!/bin/sh
# Runs on the VPS. Builds (if needed) and activates release <sha>; rolls back on failed health.
# Usage: remote-activate.sh <sha>
set -eu

SHA="$1"
BASE=/opt/amnezia-web
REL="$BASE/releases/$SHA"
PREV="$(cat "$BASE/current.rev" 2>/dev/null || true)"
KEEP=3

[ -d "$REL" ] || { echo "release $REL not found" >&2; exit 1; }

if ! docker image inspect "amnezia-web:$SHA" >/dev/null 2>&1; then
  docker build -q -t "amnezia-web:$SHA" --build-arg "APP_REVISION=$SHA" -f "$REL/deploy/Dockerfile" "$REL"
fi

activate() {
  APP_REVISION="$1" docker compose -f "$BASE/releases/$1/deploy/docker-compose.yml" up -d --no-build --remove-orphans
}

wait_healthy() {
  i=0
  while [ $i -lt 30 ]; do
    status="$(docker inspect -f '{{.State.Health.Status}}' amnezia-web 2>/dev/null || echo missing)"
    [ "$status" = healthy ] && return 0
    i=$((i + 1))
    sleep 2
  done
  return 1
}

activate "$SHA"
if ! wait_healthy; then
  echo "release $SHA is not healthy" >&2
  docker logs --tail 30 amnezia-web >&2 || true
  if [ -n "$PREV" ] && [ "$PREV" != "$SHA" ]; then
    echo "rolling back to $PREV" >&2
    activate "$PREV"
    wait_healthy || echo "rollback target $PREV is not healthy either" >&2
  fi
  exit 1
fi

echo "$SHA" > "$BASE/current.rev"
ln -sfn "$REL" "$BASE/current"
echo "active: $SHA (previous: ${PREV:-none})"

# Keep the newest $KEEP releases (and their images); never remove the active one.
ls -1t "$BASE/releases" | tail -n +$((KEEP + 1)) | while read -r old; do
  [ "$old" = "$SHA" ] && continue
  rm -rf "${BASE:?}/releases/$old"
  docker image rm "amnezia-web:$old" >/dev/null 2>&1 || true
done
