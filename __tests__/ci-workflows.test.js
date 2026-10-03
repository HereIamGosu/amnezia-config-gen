const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const workflowsDir = path.join(root, '.github', 'workflows');
const workflows = fs.readdirSync(workflowsDir)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({ file, text: fs.readFileSync(path.join(workflowsDir, file), 'utf8') }));

test('CI is a single workflow; obsolete duplicates are gone', () => {
  assert.deepEqual(workflows.map((w) => w.file).sort(), ['ci.yml']);
});

test('every action is pinned to a full commit SHA with its version noted', () => {
  for (const { file, text } of workflows) {
    const uses = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/gm)];
    assert.ok(uses.length > 0, file);
    for (const [, ref, rest] of uses) {
      assert.match(ref, /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/, `${file}: ${ref}`);
      assert.match(rest, /#\s*v\d+\.\d+\.\d+/, `${file}: ${ref} needs a "# vX.Y.Z" comment`);
    }
  }
});

test('workflows grant no permissions by default and never use privileged triggers or secrets', () => {
  for (const { file, text } of workflows) {
    assert.match(text, /^permissions:\s*\{\}\s*$/m, `${file}: top-level permissions must be {}`);
    assert.doesNotMatch(text, /pull_request_target|workflow_run/, file);
    assert.doesNotMatch(text, /secrets\./, file);
    const writes = text.match(/^\s+[\w-]+:\s*write\b.*$/gm) || [];
    assert.deepEqual(writes.map((l) => l.trim()), file === 'ci.yml' ? ['packages: write'] : [],
      `${file}: the only write permission is packages: write in the publish job`);
    for (const checkout of text.matchAll(/uses:\s*actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+persist-credentials:\s*(\w+)/g)) {
      assert.equal(checkout[1], 'false', `${file}: checkout must not persist credentials`);
    }
    assert.equal(
      (text.match(/uses:\s*actions\/checkout@/g) || []).length,
      (text.match(/persist-credentials:\s*false/g) || []).length,
      `${file}: every checkout sets persist-credentials: false`,
    );
  }
});

test('the image is built once and the smoke test runs against that image', () => {
  const ci = workflows.find((w) => w.file === 'ci.yml').text;
  assert.equal((ci.match(/docker\/build-push-action@/g) || []).length, 1, 'exactly one build');
  assert.match(ci, /push:\s*false/);
  assert.match(ci, /load:\s*true/);
  assert.match(ci, /APP_REVISION=\$\{\{ github\.sha \}\}/);
  assert.match(ci, /bash scripts\/ci\/smoke-image\.sh "\$IMAGE" "\$GITHUB_SHA"/);
  assert.doesNotMatch(ci, /docker build\b/, 'no second, ad-hoc build');
  assert.doesNotMatch(ci, /:latest\b/);
  assert.match(ci, /DOCKER_BUILD_RECORD_UPLOAD: false/, 'no implicit build-record artifact (PRs included)');
  assert.match(ci, /shell: bash # -eo pipefail[^\n]*\n\s+run: \|\n\s+docker save /, 'image export must run with pipefail');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'scripts', 'ci', 'smoke-image.sh'), 'utf8').replace(/^\s*#.*$/gm, ''), /\|\s*grep/,
    'smoke checks must not pipe into grep (false failures under pipefail on large bodies)');
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'ci', 'smoke-image.sh')));
});

// Splits ci.yml into its job blocks (two-space indented keys under `jobs:`).
const jobsOf = (text) => {
  const body = text.slice(text.indexOf('\njobs:\n') + 7);
  const parts = body.split(/^ {2}(?=[\w-]+:\s*$)/m).filter((p) => p.trim() && !p.trim().startsWith('#'));
  return Object.fromEntries(parts.map((p) => [p.slice(0, p.indexOf(':')), p]));
};

test('only the publish job can write, only for pushes to main, and it never builds', () => {
  const ci = workflows.find((w) => w.file === 'ci.yml').text;
  const jobs = jobsOf(ci);
  assert.deepEqual(Object.keys(jobs), ['ci', 'image', 'publish']);
  for (const name of ['ci', 'image']) {
    assert.match(jobs[name], /permissions:\n\s+contents: read\n/, `${name}: read-only`);
    assert.doesNotMatch(jobs[name], /packages:|docker push|docker\/login-action/, `${name} must not publish`);
  }
  const publish = jobs.publish;
  assert.match(publish, /needs: image\n/);
  assert.match(publish, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\n/);
  assert.match(publish, /permissions:\n\s+contents: read\n\s+packages: write\n/);
  assert.match(publish, /name: image-\$\{\{ github\.sha \}\}/, 'downloads the artifact of this exact commit');
  assert.match(publish, /bash scripts\/ci\/publish-image\.sh/);
  assert.match(publish, /SOURCE_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(publish, /password: \$\{\{ github\.token \}\}/);
  // Trust root: the image job's outputs, which only its own steps can set — not the artifact.
  for (const output of ['image_id', 'archive_sha256', 'config_digest']) {
    assert.match(jobs.image, new RegExp(`${output}: \\$\\{\\{ steps\\.(record|export)\\.outputs\\.${output} \\}\\}`), `image job output ${output}`);
    assert.match(publish, new RegExp(`: \\$\\{\\{ needs\\.image\\.outputs\\.${output} \\}\\}`), `publish uses ${output}`);
  }
  assert.doesNotMatch(publish, /build-push-action|docker build|setup-buildx|npm /, 'publish must not build');
  const script = fs.readFileSync(path.join(root, 'scripts', 'ci', 'publish-image.sh'), 'utf8');
  assert.match(script, /docker load/);
  assert.doesNotMatch(script.replace(/^\s*#.*$/gm, ''), /docker build\b|buildx build|:latest/);
});

test('Dependabot keeps pinned actions and the base image current', () => {
  const config = fs.readFileSync(path.join(root, '.github', 'dependabot.yml'), 'utf8');
  assert.match(config, /package-ecosystem: github-actions\s+directory: \//);
  assert.match(config, /package-ecosystem: docker\s+directory: \/deploy/);
});
