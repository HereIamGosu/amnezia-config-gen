// __tests__/release-consistency.test.js
// Regression coverage for the release consistency CLI.

'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const checker = path.join(root, 'scripts', 'check-release-consistency.js');
const { version } = require('../package.json');
const escaped = version.replace(/[.]/g, '[.]');

function runChecker(args) {
  return spawnSync(process.execPath, [checker, ...args], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
}

test('release checker accepts the matching release tag', () => {
  const result = runChecker(['--tag', `v${version}`]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`Release consistency check passed for ${escaped}`));
});

test('release checker rejects a tag/package version mismatch', () => {
  const result = runChecker(['--tag', 'v2.7.2']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`tag v2[.]7[.]2 does not match package[.]json version ${escaped}`));
});

test('release checker rejects a requested target version drift', () => {
  const result = runChecker(['--version', '2.7.2']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`package[.]json version ${escaped} does not match target 2[.]7[.]2`));
});

test('release checker covers the cache keys of every HTML entry point', () => {
  const { checkHtmlAssetVersions, HTML_ENTRY_POINTS } = require('../scripts/check-release-consistency');
  assert.deepEqual(HTML_ENTRY_POINTS, ['public/index.html', 'public/en/index.html', 'public/status.html', 'public/404.html', 'public/lab/index.html', 'public/en/lab/index.html']);
  const ok = '<script src="static/live-status.js?v=9.9.9"></script>';
  assert.deepEqual(checkHtmlAssetVersions({ 'public/status.html': ok }, '9.9.9'), []);
  assert.deepEqual(
    checkHtmlAssetVersions({ 'public/status.html': ok.replace('9.9.9', '9.9.8') }, '9.9.9'),
    ['public/status.html asset static/live-status.js?v=9.9.8 uses 9.9.8, expected 9.9.9'],
  );
  assert.deepEqual(checkHtmlAssetVersions({ 'public/status.html': '<p>no assets</p>' }, '9.9.9'),
    ['public/status.html has no versioned static assets']);
});

test('release checker sees root-relative and absolute cache keys too', () => {
  const { collectVersionedAssetUrls } = require('../scripts/check-release-consistency');
  const html = [
    '<link rel="icon" href="/static/favicon.ico?v=1.0.0" />',
    '<meta property="og:image" content="https://awgconfig.com/static/og.png?v=1.0.1" />',
    '"image": "https://awgconfig.com/static/og.png?v=1.0.2"',
    '<a href="https://example.com/static/x.js?v=9">foreign host is ignored</a>',
  ].join('\n');
  assert.deepEqual(collectVersionedAssetUrls(html).map((asset) => asset.version), ['1.0.0', '1.0.1', '1.0.2']);
});

test('release checker covers manifest icons, JSON-LD version, sitemap date and security.txt expiry', () => {
  const {
    checkManifestIconVersions, checkSoftwareVersion, checkSitemapFreshness, checkSecurityTxtExpiry, releaseDateOf,
  } = require('../scripts/check-release-consistency');

  assert.deepEqual(checkManifestIconVersions({ icons: [{ src: '/static/i.png?v=9.9.9' }] }, '9.9.9'), []);
  assert.equal(checkManifestIconVersions({ icons: [{ src: '/static/i.png' }] }, '9.9.9').length, 1);

  assert.deepEqual(checkSoftwareVersion('"softwareVersion": "9.9.9"', '9.9.9'), []);
  assert.match(checkSoftwareVersion('"softwareVersion": "9.9.8"', '9.9.9')[0], /expected 9\.9\.9/);
  assert.match(checkSoftwareVersion('no json-ld', '9.9.9')[0], /exactly one/);

  assert.equal(releaseDateOf('## [9.9.9] - 2030-01-02\n', '9.9.9'), '2030-01-02');
  assert.deepEqual(checkSitemapFreshness('<lastmod>2030-01-02</lastmod>', '2030-01-02'), []);
  assert.match(checkSitemapFreshness('<lastmod>2030-01-01</lastmod>', '2030-01-02')[0], /older than the release date/);
  assert.match(checkSitemapFreshness('<urlset/>', '2030-01-02')[0], /no <lastmod>/);

  const now = new Date('2030-01-01T00:00:00Z');
  assert.deepEqual(checkSecurityTxtExpiry('Expires: 2030-06-01T00:00:00.000Z\n', now), []);
  assert.match(checkSecurityTxtExpiry('Expires: 2030-01-15T00:00:00.000Z\n', now)[0], /renew Expires/);
  assert.match(checkSecurityTxtExpiry('Contact: x\n', now)[0], /no valid Expires/);
});
