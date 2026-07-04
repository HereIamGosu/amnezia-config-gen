// __tests__/client-compatibility.test.js
// Unit tests for the client compatibility matrix — Release 2.7.0.

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  WARNINGS,
  getCompatibilityForGeneration,
  listClients,
} = require('../src/server/clientCompatibility');

const summaryShape = (s) => {
  assert.ok(Array.isArray(s.recommended), 'recommended array');
  assert.ok(Array.isArray(s.experimental), 'experimental array');
  assert.ok(Array.isArray(s.notRecommended), 'notRecommended array');
  assert.ok(Array.isArray(s.warnings), 'warnings array');
};

const clientIds = (bucket) => bucket.map((c) => c.clientId);

test('legacy .conf: AmneziaVPN and AmneziaWG are recommended', () => {
  const s = getCompatibilityForGeneration({ mode: 'legacy', exportType: 'conf', link: false });
  summaryShape(s);
  assert.ok(clientIds(s.recommended).includes('amnezia_vpn'));
  assert.ok(clientIds(s.recommended).includes('amneziawg_client'));
});

test('legacy .conf: recommended clients only expose conf (no vpnlink without link)', () => {
  const s = getCompatibilityForGeneration({ mode: 'legacy', exportType: 'conf', link: false });
  const av = s.recommended.find((c) => c.clientId === 'amnezia_vpn');
  assert.deepEqual(av.exports, ['conf']);
});

test('awg2 .conf: adds the Cloudflare-peer disclaimer warning', () => {
  const s = getCompatibilityForGeneration({ mode: 'awg2', exportType: 'conf', link: false });
  assert.ok(s.warnings.includes(WARNINGS.CLOUDFLARE_PEER));
});

test('legacy mode does NOT add the Cloudflare-peer warning', () => {
  const s = getCompatibilityForGeneration({ mode: 'legacy', exportType: 'conf', link: false });
  assert.ok(!s.warnings.includes(WARNINGS.CLOUDFLARE_PEER));
});

test('vpn:// available: AmneziaVPN exposes conf + vpnlink', () => {
  const s = getCompatibilityForGeneration({ mode: 'awg2', exportType: 'vpnlink', link: true });
  const av = s.recommended.find((c) => c.clientId === 'amnezia_vpn');
  assert.deepEqual(av.exports, ['conf', 'vpnlink']);
});

test('no vpn://: AmneziaVPN exposes conf only', () => {
  const s = getCompatibilityForGeneration({ mode: 'awg2', exportType: 'conf', link: false });
  const av = s.recommended.find((c) => c.clientId === 'amnezia_vpn');
  assert.deepEqual(av.exports, ['conf']);
});

test('mobile profile flag does not break the summary', () => {
  const s = getCompatibilityForGeneration({ mode: 'awg2', exportType: 'conf', link: true, mobile: true });
  summaryShape(s);
  assert.ok(s.recommended.length > 0);
});

test('router flag does not break the summary', () => {
  const s = getCompatibilityForGeneration({ mode: 'legacy', exportType: 'conf', link: false, router: true });
  summaryShape(s);
});

test('wg-tunnel is experimental, never recommended', () => {
  const s = getCompatibilityForGeneration({ mode: 'legacy', exportType: 'conf', link: false });
  assert.ok(clientIds(s.experimental).includes('wg_tunnel'));
  assert.ok(!clientIds(s.recommended).includes('wg_tunnel'));
});

test('experimental clients trigger the client-version warning', () => {
  const s = getCompatibilityForGeneration({ mode: 'legacy', exportType: 'conf', link: false });
  assert.ok(s.experimental.length > 0);
  assert.ok(s.warnings.includes(WARNINGS.CLIENT_VERSION));
});

test('sing-box / clash / mihomo are notRecommended with a reason', () => {
  const s = getCompatibilityForGeneration({ mode: 'awg2', exportType: 'conf', link: true });
  const nr = Object.fromEntries(s.notRecommended.map((c) => [c.clientId, c]));
  for (const id of ['sing_box', 'clash', 'mihomo']) {
    assert.ok(nr[id], `${id} must be notRecommended`);
    assert.ok(typeof nr[id].reason === 'string' && nr[id].reason.length > 0);
  }
});

test('unsupported/experimental export target adds an exporter warning', () => {
  const s = getCompatibilityForGeneration({ mode: 'awg2', exportType: 'singbox', link: true });
  assert.ok(s.warnings.includes(WARNINGS.UNSUPPORTED_EXPORTER));
});

test('stable export target does NOT add an exporter warning', () => {
  const s = getCompatibilityForGeneration({ mode: 'legacy', exportType: 'conf', link: false });
  assert.ok(!s.warnings.includes(WARNINGS.UNSUPPORTED_EXPORTER));
});

test('unknown mode falls back without throwing (treated as legacy)', () => {
  const s = getCompatibilityForGeneration({ mode: 'totally-unknown', exportType: 'conf', link: false });
  summaryShape(s);
  assert.ok(s.recommended.length > 0);
  assert.ok(!s.warnings.includes(WARNINGS.CLOUDFLARE_PEER));
});

test('empty/no context does not throw', () => {
  const s = getCompatibilityForGeneration();
  summaryShape(s);
});

test('warnings are de-duplicated', () => {
  const s = getCompatibilityForGeneration({ mode: 'awg2', exportType: 'singbox', link: true });
  assert.equal(s.warnings.length, new Set(s.warnings).size);
});

test('registry contains the full initial client list', () => {
  const ids = listClients().map((c) => c.clientId);
  for (const id of [
    'amnezia_vpn', 'amneziawg_client', 'wg_tunnel', 'sing_box', 'mihomo',
    'clash', 'openclash', 'homeproxy', 'throne', 'onebox', 'anyportal', 'exclave',
  ]) {
    assert.ok(ids.includes(id), `missing client ${id}`);
  }
});

test('every client model has the required fields', () => {
  for (const c of listClients()) {
    assert.equal(typeof c.clientId, 'string');
    assert.equal(typeof c.name, 'string');
    assert.ok(Array.isArray(c.platforms));
    assert.ok(Array.isArray(c.supportedExports));
    assert.ok(Array.isArray(c.recommendedModes));
  }
});
