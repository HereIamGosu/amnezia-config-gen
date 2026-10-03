#!/usr/bin/env bash
# Publishes the image the CI `image` job built and smoke-tested — never a rebuild.
#
#   1. prove the downloaded archive is the one the image job exported and the image it tested:
#      archive sha256, image ID and config digest must equal the image job's outputs (only that
#      job's own steps can set them; the artifact alone is not trusted);
#   2. treat <repo>:<full-sha> as immutable: an existing tag with other content fails the job, the
#      same content is not pushed again, and any registry error that is not a clear "not found"
#      fails instead of pushing;
#   3. push, then prove the registry manifest references the tested image config;
#   4. move the human alias only if the commit is still the tip of main;
#   5. write release.json (source_sha, image_digest, ...) for later deployment tooling.
#
# Env: SOURCE_SHA (40-hex commit), REPO_IMAGE (ghcr.io/owner/name), ARTIFACT_DIR (image.tar.gz +
# image-id.txt), OUT_DIR (receives release.json), EXPECTED_IMAGE_ID, EXPECTED_ARCHIVE_SHA256,
# EXPECTED_CONFIG_DIGEST (image job outputs), ALIAS (optional moving tag for humans; deployment
# must use the digest), MAIN_REPO_URL (repository to read the main tip from, for ALIAS).
# Needs docker with buildx, git, gzip, tar, sed, sha256sum.
set -euo pipefail

fail() { echo "::error::$*" >&2; exit 1; }
HEX64='[0-9a-f]{64}'

: "${SOURCE_SHA:?}" "${REPO_IMAGE:?}" "${ARTIFACT_DIR:?}" "${OUT_DIR:?}"
: "${EXPECTED_IMAGE_ID:?}" "${EXPECTED_ARCHIVE_SHA256:?}" "${EXPECTED_CONFIG_DIGEST:?}"
ALIAS="${ALIAS:-}"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "SOURCE_SHA must be a full commit SHA, got '$SOURCE_SHA'"
[[ "$REPO_IMAGE" =~ ^[a-z0-9./_-]+$ ]] || fail "REPO_IMAGE must be a lowercase image name, got '$REPO_IMAGE'"
[[ "$EXPECTED_IMAGE_ID" =~ ^sha256:$HEX64$ ]] || fail "EXPECTED_IMAGE_ID is not an image ID"
[[ "$EXPECTED_ARCHIVE_SHA256" =~ ^$HEX64$ ]] || fail "EXPECTED_ARCHIVE_SHA256 is not a sha256"
[[ "$EXPECTED_CONFIG_DIGEST" =~ ^sha256:$HEX64$ ]] || fail "EXPECTED_CONFIG_DIGEST is not a digest"

archive="$ARTIFACT_DIR/image.tar.gz"

# Config digest named by the archive's manifest.json ("<hex>.json" or "blobs/sha256/<hex>").
archive_config_digest() {
  gzip -dc "$1" | tar -xOf - manifest.json | tr -d '\n' \
    | sed -n 's/.*"Config"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | sed -e 's#^blobs/sha256/##' -e 's#\.json$##' -e 's#^#sha256:#'
}

# --- 1. the tested image ------------------------------------------------------------------
actual_sha256="$(sha256sum < "$archive" | cut -d' ' -f1)"
[ "$actual_sha256" = "$EXPECTED_ARCHIVE_SHA256" ] \
  || fail "image.tar.gz ($actual_sha256) is not the archive the image job exported ($EXPECTED_ARCHIVE_SHA256)"
[ "$(tr -d '[:space:]' < "$ARTIFACT_DIR/image-id.txt")" = "$EXPECTED_IMAGE_ID" ] \
  || fail "image-id.txt does not match the image job output $EXPECTED_IMAGE_ID"
config_digest="$(archive_config_digest "$archive")"
[ "$config_digest" = "$EXPECTED_CONFIG_DIGEST" ] \
  || fail "archive config '$config_digest' does not match the image job output $EXPECTED_CONFIG_DIGEST"

load_output="$(gzip -dc "$archive" | docker load)"
local_ref="$(sed -n 's/^Loaded image: //p' <<<"$load_output" | head -n 1)"
[ -n "$local_ref" ] || fail "docker load reported no image"
actual_id="$(docker image inspect -f '{{.Id}}' "$local_ref")"
[ "$actual_id" = "$EXPECTED_IMAGE_ID" ] || fail "loaded image $actual_id is not the tested image $EXPECTED_IMAGE_ID"
revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$local_ref")"
[ "$revision" = "$SOURCE_SHA" ] || fail "image revision label '$revision' does not match $SOURCE_SHA"
echo "loaded tested image $actual_id (config $config_digest, $local_ref)"

# --- registry helpers ---------------------------------------------------------------------
# Config digest referenced by a remote single-image manifest (empty for an index).
config_digest_of() {
  tr -d '\n' <<<"$1" | sed -n 's/.*"config"[[:space:]]*:[[:space:]]*{[^}]*"digest"[[:space:]]*:[[:space:]]*"\(sha256:[0-9a-f]\{64\}\)".*/\1/p'
}
# Prints the raw manifest of $1; returns 3 only when the tag lookup itself answered 404, which
# buildx prints as the exact line 'ERROR: <ref>: not found'. Anything else returns 1: timeouts,
# 5xx, auth errors, and also a 404 while reading content after the lookup succeeded (registry
# inconsistency), which must never be mistaken for a missing tag.
remote_manifest() {
  local out
  if out="$(docker buildx imagetools inspect --raw "$1" 2>&1)"; then
    printf '%s' "$out"
  elif grep -qxF -e "ERROR: $1: not found" -e "$1: not found" <<<"$out"; then
    return 3
  else
    printf '%s\n' "$out" >&2
    return 1
  fi
}
manifest_digest_of_ref() {
  docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' \
    | tr -d '\n' | sed -n 's/.*"digest"[[:space:]]*:[[:space:]]*"\(sha256:[0-9a-f]\{64\}\)".*/\1/p'
}

# --- 2. immutable SHA tag -----------------------------------------------------------------
target="$REPO_IMAGE:$SOURCE_SHA"
set +e
existing="$(remote_manifest "$target")"
rc=$?
set -e
case "$rc" in
  0)
    existing_config="$(config_digest_of "$existing")"
    [ "$existing_config" = "$EXPECTED_CONFIG_DIGEST" ] \
      || fail "$target already exists with config '${existing_config:-<an index or an unreadable manifest>}', not the tested $EXPECTED_CONFIG_DIGEST; refusing to overwrite"
    published=already-present
    echo "$target already holds the tested image; not pushing again"
    ;;
  3)
    docker tag "$local_ref" "$target"
    docker push "$target"
    published=pushed
    ;;
  *)
    fail "could not determine whether $target exists; not pushing"
    ;;
esac

# --- 3. prove what the registry holds -----------------------------------------------------
digest="$(manifest_digest_of_ref "$target")"
[[ "$digest" =~ ^sha256:$HEX64$ ]] || fail "could not read the registry digest of $target"
pinned="$REPO_IMAGE@$digest"
set +e
pinned_manifest="$(remote_manifest "$pinned")"
rc=$?
set -e
[ "$rc" = 0 ] || fail "cannot read $pinned back from the registry"
remote_config="$(config_digest_of "$pinned_manifest")"
[ "$remote_config" = "$EXPECTED_CONFIG_DIGEST" ] \
  || fail "registry manifest $digest references config '$remote_config', not the tested $EXPECTED_CONFIG_DIGEST"
echo "registry holds the tested image: $pinned"

# --- 4. human alias -----------------------------------------------------------------------
alias_digest=""
alias_state="none"
if [ -n "$ALIAS" ]; then
  [[ "$ALIAS" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] && [[ ! "$ALIAS" =~ ^[0-9a-f]{40}$ ]] || fail "invalid ALIAS '$ALIAS'"
  : "${MAIN_REPO_URL:?MAIN_REPO_URL is required with ALIAS}"
  # Optional step: a failed lookup must not fail a publication that already happened.
  main_tip="$(git ls-remote "$MAIN_REPO_URL" refs/heads/main | cut -f1)" || main_tip=""
  if [ "$main_tip" = "$SOURCE_SHA" ]; then
    docker tag "$local_ref" "$REPO_IMAGE:$ALIAS"
    docker push "$REPO_IMAGE:$ALIAS"
    alias_digest="$(manifest_digest_of_ref "$REPO_IMAGE:$ALIAS")"
    alias_state="moved"
    [ "$alias_digest" = "$digest" ] || echo "::warning::alias $ALIAS points to $alias_digest, not $digest"
  else
    alias_state="skipped (main is at ${main_tip:-unknown})"
    echo "::notice::$SOURCE_SHA is not the tip of main (${main_tip:-unknown}); leaving :$ALIAS unchanged"
  fi
fi

# --- 5. record ----------------------------------------------------------------------------
mkdir -p "$OUT_DIR"
cat > "$OUT_DIR/release.json" <<JSON
{
  "source_sha": "$SOURCE_SHA",
  "image": "$target",
  "image_digest": "$digest",
  "image_ref": "$pinned",
  "image_id": "$EXPECTED_IMAGE_ID",
  "config_digest": "$EXPECTED_CONFIG_DIGEST",
  "archive_sha256": "$EXPECTED_ARCHIVE_SHA256",
  "published": "$published",
  "alias": "${ALIAS}",
  "alias_state": "${alias_state}",
  "alias_digest": "${alias_digest}",
  "run_id": "${GITHUB_RUN_ID:-}",
  "run_attempt": "${GITHUB_RUN_ATTEMPT:-}"
}
JSON
cat "$OUT_DIR/release.json"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo '## Published image'
    echo
    echo '| | |'
    echo '| --- | --- |'
    echo "| source_sha | \`$SOURCE_SHA\` |"
    echo "| image | \`$target\` |"
    echo "| image_digest | \`$digest\` |"
    echo "| pull by digest | \`$pinned\` |"
    echo "| tested image ID | \`$EXPECTED_IMAGE_ID\` |"
    echo "| config digest | \`$EXPECTED_CONFIG_DIGEST\` |"
    echo "| result | $published |"
    [ -z "$ALIAS" ] || echo "| alias (humans only) | \`$REPO_IMAGE:$ALIAS\` — $alias_state |"
  } >> "$GITHUB_STEP_SUMMARY"
fi
