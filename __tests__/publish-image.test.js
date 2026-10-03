const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

// Drives scripts/ci/publish-image.sh against a fake `docker` and `git` to cover every branch
// without a registry: trust in the image job outputs, the immutable SHA tag, registry errors,
// the containerd image store (image ID != config digest) and the main-only alias.
const root = path.resolve(__dirname, '..');
const SCRIPT = path.join(root, 'scripts', 'ci', 'publish-image.sh');
const SHA = 'a'.repeat(40);
const SHA_WITH_404 = `${'b'.repeat(10)}404${'c'.repeat(27)}`;
const IMAGE_ID = `sha256:${'1'.repeat(64)}`;
const CONFIG_HEX = '3'.repeat(64);
const CONFIG = `sha256:${CONFIG_HEX}`;
const OTHER = `sha256:${'2'.repeat(64)}`;
const DIGEST = `sha256:${'d'.repeat(64)}`;
const posix = (p) => p.replace(/\\/g, '/');

const FAKE_DOCKER = `#!/usr/bin/env bash
log() { echo "$*" >> "$FAKE_DIR/calls.log"; }
case "$1" in
  load) cat > /dev/null; echo "Loaded image: amnezia-web:ci-test"; exit 0 ;;
  image) if [[ "$*" == *'.Id'* ]]; then echo "$FAKE_LOADED_ID"; else echo "$FAKE_REVISION"; fi; exit 0 ;;
  tag) log "tag $2 $3"; exit 0 ;;
  push) log "push $2"; touch "$FAKE_DIR/pushed"; exit 0 ;;
  buildx)
    if [[ "$*" == *'--format'* ]]; then
      echo '{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"'"$FAKE_DIGEST"'","size":1}'
      exit 0
    fi
    ref="\${@: -1}"
    log "inspect $ref"
    if [ "$FAKE_REGISTRY" = error ]; then
      echo "ERROR: failed to do request: Head \\"https://ghcr.io/v2/hereiamgosu/amnezia-config-gen/manifests/$SOURCE_SHA\\": dial tcp 140.82.113.33:443: i/o timeout" >&2
      exit 1
    fi
    if [ "$FAKE_REGISTRY" = inconsistent ]; then
      echo "ERROR: content at https://ghcr.io/v2/hereiamgosu/amnezia-config-gen/manifests/$FAKE_DIGEST not found: not found" >&2
      exit 1
    fi
    if [ -f "$FAKE_DIR/pushed" ]; then config="$FAKE_PUSHED_CONFIG"
    elif [ "$FAKE_REGISTRY" = existing ]; then config="$FAKE_EXISTING_CONFIG"
    else echo "ERROR: $ref: not found" >&2; exit 1; fi
    printf '{\\n  "schemaVersion": 2,\\n  "config": {\\n    "mediaType": "application/vnd.oci.image.config.v1+json",\\n    "digest": "%s",\\n    "size": 1234\\n  },\\n  "layers": []\\n}\\n' "$config"
    exit 0 ;;
esac
echo "unexpected docker call: $*" >&2; exit 99
`;

const FAKE_GIT = `#!/usr/bin/env bash
if [ "$1" = ls-remote ] && [ -n "$FAKE_GIT_FAIL" ]; then echo "fatal: unable to access: Could not resolve host: github.com" >&2; exit 128; fi
if [ "$1" = ls-remote ]; then printf '%s\\trefs/heads/main\\n' "$FAKE_MAIN_TIP"; exit 0; fi
echo "unexpected git call: $*" >&2; exit 99
`;

const sh = (script) => {
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};

const run = (overrides = {}, { configInArchive = `blobs/sha256/${CONFIG_HEX}` } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-'));
  const bin = path.join(dir, 'bin');
  const artifact = path.join(dir, 'artifact');
  const content = path.join(dir, 'content');
  for (const d of [bin, artifact, content]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'git'), FAKE_GIT, { mode: 0o755 });
  fs.writeFileSync(path.join(content, 'manifest.json'), JSON.stringify([{ Config: configInArchive, RepoTags: ['amnezia-web:ci-test'], Layers: [] }]));
  sh(`cd "${posix(content)}" && tar -cf - manifest.json | gzip > "${posix(artifact)}/image.tar.gz"`);
  fs.writeFileSync(path.join(artifact, 'image-id.txt'), `${IMAGE_ID}\n`);
  const archiveSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(artifact, 'image.tar.gz'))).digest('hex');
  const sourceSha = overrides.SOURCE_SHA ?? SHA;
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_DIR: dir,
    FAKE_LOADED_ID: IMAGE_ID,
    FAKE_REVISION: sourceSha,
    FAKE_REGISTRY: 'missing',
    FAKE_EXISTING_CONFIG: CONFIG,
    FAKE_PUSHED_CONFIG: CONFIG,
    FAKE_DIGEST: DIGEST,
    FAKE_MAIN_TIP: sourceSha,
    SOURCE_SHA: sourceSha,
    REPO_IMAGE: 'ghcr.io/hereiamgosu/amnezia-config-gen',
    ARTIFACT_DIR: artifact,
    OUT_DIR: path.join(dir, 'out'),
    EXPECTED_IMAGE_ID: IMAGE_ID,
    EXPECTED_ARCHIVE_SHA256: archiveSha,
    EXPECTED_CONFIG_DIGEST: CONFIG,
    ALIAS: 'main',
    MAIN_REPO_URL: 'https://github.com/HereIamGosu/amnezia-config-gen',
    GITHUB_STEP_SUMMARY: '',
    ...overrides,
  };
  const res = spawnSync('bash', [SCRIPT], { env, encoding: 'utf8' });
  const read = (file) => (fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), 'utf8') : '');
  const out = read('out/release.json');
  const result = { status: res.status, stderr: res.stderr, calls: read('calls.log'), release: out ? JSON.parse(out) : null };
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
};

test('fresh publish pushes the tested image under the full SHA and records the digest', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, new RegExp(`push ghcr.io/hereiamgosu/amnezia-config-gen:${SHA}`));
  assert.match(r.calls, /push ghcr\.io\/hereiamgosu\/amnezia-config-gen:main/);
  assert.equal(r.release.source_sha, SHA);
  assert.equal(r.release.image_digest, DIGEST);
  assert.equal(r.release.image_ref, `ghcr.io/hereiamgosu/amnezia-config-gen@${DIGEST}`);
  assert.equal(r.release.config_digest, CONFIG);
  assert.equal(r.release.published, 'pushed');
  assert.equal(r.release.alias_state, 'moved');
});

test('works with the containerd image store, where the image ID is not the config digest', () => {
  // IMAGE_ID (1…) differs from CONFIG (3…): registry checks use the config digest from the archive.
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const legacy = run({}, { configInArchive: `${CONFIG_HEX}.json` });
  assert.equal(legacy.status, 0, legacy.stderr);
});

test('re-running for the same content does not push the SHA tag again', () => {
  const r = run({ FAKE_REGISTRY: 'existing', ALIAS: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.calls, /^push /m);
  assert.equal(r.release.published, 'already-present');
});

test('an existing SHA tag with different content is never overwritten', () => {
  const r = run({ FAKE_REGISTRY: 'existing', FAKE_EXISTING_CONFIG: OTHER });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing to overwrite/);
  assert.doesNotMatch(r.calls, /push|tag /);
});

test('a self-consistent artifact that is not what the image job tested is rejected', () => {
  // image-id.txt and the archive agree with each other, but not with the image job output.
  const r = run({ EXPECTED_IMAGE_ID: OTHER });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /image-id\.txt does not match the image job output/);
  assert.equal(r.calls, '');
});

test('a replaced archive is rejected by its sha256 before docker load', () => {
  const r = run({ EXPECTED_ARCHIVE_SHA256: 'f'.repeat(64) });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is not the archive the image job exported/);
  assert.equal(r.calls, '');
});

test('an archive whose config differs from the tested config is rejected', () => {
  const r = run({ EXPECTED_CONFIG_DIGEST: OTHER });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /archive config/);
});

test('a loaded image other than the tested one is rejected', () => {
  const r = run({ FAKE_LOADED_ID: OTHER });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is not the tested image/);
  assert.equal(r.calls, '');
});

test('a revision label from another commit is rejected', () => {
  const r = run({ FAKE_REVISION: 'e'.repeat(40) });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /revision label/);
  assert.equal(r.calls, '');
});

test('a registry error whose text contains "404" (here in the SHA) does not lead to a push', () => {
  const r = run({ SOURCE_SHA: SHA_WITH_404, FAKE_REGISTRY: 'error' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not determine whether/);
  assert.doesNotMatch(r.calls, /push/);
});

test('the job fails if the registry does not reference the tested config after push', () => {
  const r = run({ FAKE_PUSHED_CONFIG: OTHER });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /references config/);
});

test('the alias is left alone when the commit is no longer the tip of main', () => {
  const r = run({ FAKE_MAIN_TIP: 'f'.repeat(40) });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.calls, /push ghcr\.io\/hereiamgosu\/amnezia-config-gen:main/);
  assert.match(r.release.alias_state, /^skipped/);
});

test('a 404 while reading an existing tag (registry inconsistency) is not taken as "missing"', () => {
  const r = run({ FAKE_REGISTRY: 'inconsistent' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not determine whether/);
  assert.doesNotMatch(r.calls, /push|tag /);
});

test('a failed main-tip lookup skips the alias but keeps the completed publication', () => {
  const r = run({ FAKE_GIT_FAIL: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, new RegExp(`push ghcr.io/hereiamgosu/amnezia-config-gen:${SHA}`));
  assert.doesNotMatch(r.calls, /amnezia-config-gen:main/);
  assert.equal(r.release.published, 'pushed');
  assert.match(r.release.alias_state, /^skipped \(main is at unknown\)/);
});

test('an archive with another config fails before any docker call', () => {
  const r = run({ EXPECTED_CONFIG_DIGEST: OTHER });
  assert.notEqual(r.status, 0);
  assert.equal(r.calls, '');
});

test('missing image job outputs or a short SHA are rejected', () => {
  const missing = run({ EXPECTED_CONFIG_DIGEST: '' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /EXPECTED_CONFIG_DIGEST/);
  const short = run({ SOURCE_SHA: 'abc123' });
  assert.notEqual(short.status, 0);
  assert.match(short.stderr, /full commit SHA/);
});
