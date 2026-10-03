// __tests__/release-consistency.test.js
// Regression coverage for the release consistency CLI.

'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const checker = path.join(root, 'scripts', 'check-release-consistency.js');

function runChecker(args) {
  return spawnSync(process.execPath, [checker, ...args], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
}

test('release checker accepts the matching release tag', () => {
  const result = runChecker(['--tag', 'v2.7.3']);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Release consistency check passed for 2\.7\.3/);
});

test('release checker rejects a tag/package version mismatch', () => {
  const result = runChecker(['--tag', 'v2.7.2']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tag v2\.7\.2 does not match package\.json version 2\.7\.3/);
});

test('release checker rejects a requested target version drift', () => {
  const result = runChecker(['--version', '2.7.2']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package\.json version 2\.7\.3 does not match target 2\.7\.2/);
});
