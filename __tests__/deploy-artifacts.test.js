const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Docker base image is pinned by digest and stays on Node 22', () => {
  // Two stages (asset builder + runtime), both on the same pinned base image.
  const from = read('deploy/Dockerfile').split('\n').filter((line) => /^FROM\s/i.test(line));
  assert.equal(from.length, 2);
  assert.match(from[0], /^FROM node:22-alpine@sha256:[0-9a-f]{64} AS builder$/);
  assert.match(from[1], /^FROM node:22-alpine@sha256:[0-9a-f]{64}$/);
  assert.equal(from[0].replace(/ AS builder$/, ''), from[1], 'same base image in both stages');
  assert.equal(JSON.parse(read('package.json')).engines.node, '22.x');
});

test('Dependabot watches the Docker base image without Node major upgrades', () => {
  const config = read('.github/dependabot.yml');
  assert.match(config, /package-ecosystem: docker\s+directory: \/deploy/);
  assert.match(config, /dependency-name: node\s+update-types: \["version-update:semver-major"\]/);
});
