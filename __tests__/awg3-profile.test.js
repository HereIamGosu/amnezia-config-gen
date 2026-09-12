'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AWG_PROFILES, buildAwgMetadata, normalizeAwgMode } = require('../src/server/awg/profiles');
const { parseAwgRange } = require('../src/server/awg/ranges');
const { assertWarpSafeAwgConfig, enforceWarpSafeAwgConfig } = require('../src/server/awg/warpSafety');

test('AWG mode aliases normalize to four canonical modes', () => {
  for (const alias of ['3', '3.0', 'awg3', 'awg3.0', 'awg30']) assert.equal(normalizeAwgMode(alias), 'awg3');
  for (const alias of ['3.1', 'awg31', 'awg3.1']) assert.equal(normalizeAwgMode(alias), 'awg31');
  assert.equal(normalizeAwgMode('awg2'), 'awg2');
  assert.equal(normalizeAwgMode('unknown'), 'legacy');
});

test('strict AWG range parser accepts canonical values', () => {
  for (const value of ['25', '25-35', '0', '100-120', '3-7', '150-180']) {
    assert.equal(parseAwgRange(value, { field: 'Test' }), value);
  }
  assert.equal(parseAwgRange(' off ', { field: 'Test', allowOff: true }), 'off');
});

test('strict AWG range parser rejects malformed, reversed, unsafe, and injected values', () => {
  for (const value of ['35-25', 'foo', '25-', '-35', '25.0', '25x', '1-2-3', '25 - 35', '1e3', '0x19', '429496729999999', '100-120\nPrivateKey = injected']) {
    assert.throws(() => parseAwgRange(value, { field: 'Test' }), /Invalid Test range/);
  }
});

test('WARP safety is the final authority over peer-dependent fields', () => {
  const safe = enforceWarpSafeAwgConfig({ mode: 'awg31', S4: 12, H1: '12345', headerProtectionKey: 'secret', randomTrailers: 'on' });
  assert.deepEqual(
    { S1: safe.S1, S2: safe.S2, S3: safe.S3, S4: safe.S4, H1: safe.H1, H2: safe.H2, H3: safe.H3, H4: safe.H4 },
    { S1: 0, S2: 0, S3: 0, S4: 0, H1: '1', H2: '2', H3: '3', H4: '4' },
  );
  assert.equal(safe.headerProtectionKey, undefined);
  assert.equal(safe.randomTrailers, 'off');
  assert.equal(safe.disableCookies, 'off');
  assert.doesNotThrow(() => assertWarpSafeAwgConfig(safe));
});

test('profiles and response metadata describe only the WARP-safe subset', () => {
  assert.equal(AWG_PROFILES.awg3.supports.headerProtection, false);
  const metadata = buildAwgMetadata('awg31', { contentPaddingExperimental: true, routerMode: true, vpnLinkAvailable: true });
  assert.equal(metadata.profile, 'warp-safe');
  assert.equal(metadata.peerType, 'stock-wireguard');
  assert.equal(metadata.vpnImport.protocolVersion, '3.1');
  assert.equal(metadata.routerCompatibility, 'experimental/router-dependent');
  assert.deepEqual(metadata.experimentalFeatures, ['content-padding-addition']);
  assert.ok(metadata.disabledFeatures.some(({ feature }) => feature === 'random-trailers'));
});
