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
    assert.doesNotMatch(text, /:\s*write\b/, `${file}: no write permission in CI`);
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

test('Dependabot keeps pinned actions and the base image current', () => {
  const config = fs.readFileSync(path.join(root, '.github', 'dependabot.yml'), 'utf8');
  assert.match(config, /package-ecosystem: github-actions\s+directory: \//);
  assert.match(config, /package-ecosystem: docker\s+directory: \/deploy/);
});
