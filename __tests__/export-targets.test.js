// __tests__/export-targets.test.js
// Unit tests for the export target registry v0 — Release 2.7.0.

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  STATUS,
  getExportTarget,
  listExportTargets,
  getAvailableExportTargets,
  isStableExportTarget,
} = require('../src/server/exportTargets');

test('getExportTarget("conf") returns a stable target', () => {
  const conf = getExportTarget('conf');
  assert.ok(conf);
  assert.equal(conf.id, 'conf');
  assert.equal(conf.status, STATUS.STABLE);
  assert.deepEqual(conf.requires, []);
});

test('getExportTarget("vpnlink") returns a stable target requiring vpnLink', () => {
  const vpn = getExportTarget('vpnlink');
  assert.ok(vpn);
  assert.equal(vpn.status, STATUS.STABLE);
  assert.deepEqual(vpn.requires, ['vpnLink']);
});

test('getExportTarget is case-insensitive and trims', () => {
  assert.equal(getExportTarget('  CONF  ').id, 'conf');
});

test('getExportTarget(unknown) returns null', () => {
  assert.equal(getExportTarget('does-not-exist'), null);
  assert.equal(getExportTarget(''), null);
  assert.equal(getExportTarget(undefined), null);
});

test('listExportTargets returns all registered targets', () => {
  const ids = listExportTargets().map((t) => t.id);
  assert.deepEqual(
    ids,
    ['conf', 'vpnlink', 'qr', 'singbox', 'mihomo', 'clash', 'throne', 'openwrt'],
  );
});

test('initial target statuses match the release spec', () => {
  const byId = Object.fromEntries(listExportTargets().map((t) => [t.id, t.status]));
  assert.equal(byId.conf, 'stable');
  assert.equal(byId.vpnlink, 'stable');
  assert.equal(byId.qr, 'experimental');
  assert.equal(byId.singbox, 'experimental');
  assert.equal(byId.mihomo, 'experimental');
  assert.equal(byId.clash, 'experimental');
  assert.equal(byId.throne, 'research');
  assert.equal(byId.openwrt, 'documentation');
});

test('getAvailableExportTargets without vpn:// yields only .conf', () => {
  const ids = getAvailableExportTargets({ link: false }).map((t) => t.id);
  assert.deepEqual(ids, ['conf']);
});

test('getAvailableExportTargets with vpn:// adds vpnlink and qr, never exporter/research', () => {
  const ids = getAvailableExportTargets({ link: true }).map((t) => t.id);
  assert.deepEqual(ids, ['conf', 'vpnlink', 'qr']);
  assert.ok(!ids.includes('singbox'));
  assert.ok(!ids.includes('throne'));
  assert.ok(!ids.includes('openwrt'));
});

test('stable targets are not mixed with experimental in the available set', () => {
  const available = getAvailableExportTargets({ link: true });
  const experimentalOrWorse = available.filter((t) => t.status === 'research' || t.status === 'documentation');
  assert.equal(experimentalOrWorse.length, 0);
});

test('research target never counts as stable', () => {
  assert.equal(isStableExportTarget('throne'), false);
  assert.equal(isStableExportTarget('singbox'), false);
  assert.equal(isStableExportTarget('conf'), true);
  assert.equal(isStableExportTarget('vpnlink'), true);
});

test('unsupported exporter targets carry a warning', () => {
  for (const id of ['singbox', 'mihomo', 'clash']) {
    const target = getExportTarget(id);
    assert.ok(target.warnings.length > 0, `${id} must warn`);
  }
});

test('returned targets are copies (mutation-safe)', () => {
  const a = getExportTarget('conf');
  a.warnings.push('mutated');
  const b = getExportTarget('conf');
  assert.deepEqual(b.warnings, []);
});
