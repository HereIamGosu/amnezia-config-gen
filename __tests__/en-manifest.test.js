// __tests__/en-manifest.test.js
// /en installs as an English app (owner decision No. 10, 3.1.7): its own manifest with start_url /en, lang en and
// an English description, while the Russian page keeps /site.webmanifest. Both list the same icon files with the
// same ?v= key, and release:check enforces it for both.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const readJson = (file) => JSON.parse(read(file));

test('the English page links its own manifest, the Russian page the Russian one', () => {
  assert.match(read('public/index.html'), /<link rel="manifest" href="\/site\.webmanifest" \/>/);
  assert.match(read('public/en/index.html'), /<link rel="manifest" href="\/en\/site\.webmanifest" \/>/);
});

test('the English manifest starts at /en in English and shares everything else', () => {
  const ru = readJson('public/site.webmanifest');
  const en = readJson('public/en/site.webmanifest');
  assert.equal(en.id, '/en');
  assert.equal(en.start_url, '/en');
  assert.equal(en.lang, 'en');
  assert.doesNotMatch(en.description, /[а-яё]/i);
  const OWN = ['id', 'start_url', 'lang', 'description'];
  const shared = (manifest) => Object.fromEntries(Object.entries(manifest).filter(([key]) => !OWN.includes(key)));
  assert.deepEqual(shared(en), shared(ru));
});

test('the English manifest is revalidated like the Russian one', () => {
  const rules = readJson('vercel.json').headers;
  const headersOf = (source) => rules.find((rule) => rule.source === source)?.headers;
  assert.ok(headersOf('/site.webmanifest'));
  assert.deepEqual(headersOf('/en/site.webmanifest'), headersOf('/site.webmanifest'));
});

test('release:check covers the icons of both manifests', () => {
  const { checkManifestIconVersions, MANIFESTS } = require('../scripts/check-release-consistency');
  assert.deepEqual(MANIFESTS, ['public/site.webmanifest', 'public/en/site.webmanifest']);
  const [failure] = checkManifestIconVersions({ icons: [{ src: '/static/i.png?v=1.0.0' }] }, '1.0.1', 'public/en/site.webmanifest');
  assert.match(failure, /^public\/en\/site\.webmanifest icon \/static\/i\.png\?v=1\.0\.0 must use \?v=1\.0\.1$/);
});
