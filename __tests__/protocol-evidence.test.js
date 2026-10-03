'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EVIDENCE_STATUSES, validateProtocolEvidence } = require('../src/server/protocolEvidence');
const { AWG_CAPABILITIES, AWG_CAPABILITY_BY_FIELD, assertConfigEvidenceKnown, validateAwgEvidence } = require('../src/server/awg/evidence');
const { AWG_PROFILES, buildAwgMetadata } = require('../src/server/awg/profiles');
const { buildAwg3Interface } = require('../src/server/awg/configBuilder');
const { WARP_SAFE_WIRE_FORMAT, assertNoBlockedWarpOverrides } = require('../src/server/awg/warpSafety');
const { parseAwgRange } = require('../src/server/awg/ranges');
const { __internals: warp } = require('../api/warp');

const buildDefault = (mode, overrides = {}) => buildAwg3Interface({
  mode,
  privateKey: 'test-key',
  clientIPv4: '172.16.0.2',
  dnsLine: '1.1.1.1',
  obfuscation: { Jc: 3, Jmin: 64, Jmax: 128 },
  i1: 'abcd',
  contentPaddingAddition: AWG_PROFILES[mode].contentPaddingDefault,
  ...overrides,
});

test('every required AWG field has one complete, valid evidence record', () => {
  const expected = ['Jc', 'Jmin', 'Jmax', 'I1', 'I2', 'I3', 'I4', 'I5',
    'ContentPaddingAddition', 'RekeyAfterTime', 'RekeyTimeout', 'RejectAfterTime',
    'KeepaliveTimeout', 'MaxHandshakeAttempts', 'PersistentKeepalive',
    'DisableCookies', 'RandomTrailers', 'HeaderProtectionKey',
    'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4'];
  assert.deepEqual(Object.keys(AWG_CAPABILITY_BY_FIELD).sort(), expected.sort());
  assert.deepEqual(validateAwgEvidence(), []);
  for (const record of AWG_CAPABILITIES) assert.ok(EVIDENCE_STATUSES.includes(record.evidenceStatus));
});

test('validator rejects duplicate IDs, missing evidence and unsafe defaults', () => {
  const original = AWG_CAPABILITY_BY_FIELD.ContentPaddingAddition;
  const bad = { ...original, id: 'bad', fields: ['Bad'], evidenceStatus: 'unknown', productPolicy: { state: 'enabled-by-default', defaultValue: '1' } };
  assert.match(validateProtocolEvidence([original, bad, original]).join(' '), /unsafe enabled default/);
  assert.match(validateProtocolEvidence([original, bad, original]).join(' '), /Duplicate or missing capability ID/);
  const blocked = { ...original, id: 'blocked', fields: ['Blocked'], evidenceStatus: 'peer-dependent-disabled' };
  assert.match(validateProtocolEvidence([blocked]).join(' '), /not blocked\/fixed/);
  const fixed = { ...original, id: 'fixed', fields: ['Fixed'], productPolicy: { state: 'fixed' } };
  assert.match(validateProtocolEvidence([fixed]).join(' '), /fixed value missing/);
});

test('WARP peer-dependent capabilities agree with explicit final safety policy', () => {
  for (const field of ['S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4']) {
    const record = AWG_CAPABILITY_BY_FIELD[field];
    assert.equal(record.evidenceStatus, 'peer-dependent-disabled');
    assert.equal(record.productPolicy.state, 'fixed');
    assert.equal(record.productPolicy.fixedValue, WARP_SAFE_WIRE_FORMAT[field]);
    assert.throws(() => assertNoBlockedWarpOverrides({ [field]: 'unsafe' }));
  }
  for (const field of ['HeaderProtectionKey', 'RandomTrailers']) {
    assert.equal(AWG_CAPABILITY_BY_FIELD[field].evidenceStatus, 'peer-dependent-disabled');
    assert.equal(AWG_CAPABILITY_BY_FIELD[field].productPolicy.state, 'blocked');
  }
  assert.throws(() => assertNoBlockedWarpOverrides({ headerProtectionKey: 'unsafe' }));
  assert.throws(() => assertNoBlockedWarpOverrides({ randomTrailers: 'on' }));
});

test('default AWG 3.0 and 3.1 output has evidence for every emitted field', () => {
  for (const mode of ['awg3', 'awg31']) {
    const text = buildDefault(mode);
    assert.deepEqual(assertConfigEvidenceKnown(mode, text), []);
    assert.match(text, /ContentPaddingAddition = 10-100/);
    assert.match(text, /S1 = 0/);
    assert.match(text, /H4 = 4/);
    assert.doesNotMatch(text, /HeaderProtectionKey/);
    if (mode === 'awg31') assert.match(text, /DisableCookies = on/);
  }
  assert.match(assertConfigEvidenceKnown('awg3', `${buildDefault('awg3')}\nUnknownAWGField = 1`).join(' '), /no evidence record/);
});

test('API metadata describes effective serialized values without secrets', () => {
  for (const mode of ['awg3', 'awg31']) {
    for (const padding of [true, false]) {
      const text = buildDefault(mode, { contentPaddingAddition: padding ? '10-100' : null, disableCookies: mode === 'awg31' ? 'off' : undefined });
      const metadata = buildAwgMetadata(mode, { configText: text });
      assert.equal(metadata.evidenceModelVersion, 1);
      assert.equal(metadata.capabilities.contentPaddingAddition.effectiveState, padding ? 'active' : 'disabled');
      if (mode === 'awg31') assert.equal(metadata.capabilities.disableCookies.effectiveState, 'disabled');
      assert.equal(metadata.capabilities.randomTrailers.effectiveState, 'blocked');
      assert.equal(metadata.capabilities.headerProtectionKey.effectiveState, 'blocked');
      const publicMetadata = JSON.stringify(metadata);
      for (const secret of ['test-key', 'PrivateKey', 'PresharedKey', 'vpn://', 'abcd', 'AllowedIPs']) {
        assert.equal(publicMetadata.includes(secret), false);
      }
    }
  }
});

test('public range fields enforce the strict 16-bit config contract', () => {
  for (const options of Object.values(warp.AWG_RANGE_FIELDS)) {
    for (const value of ['0', '1', '65535', '0-0', '1-65535']) {
      assert.equal(parseAwgRange(value, options), value);
    }
    for (const value of ['65536', '2-1', '-1', '1.5', '0x10', '1e3', '1 - 2', '1\nPrivateKey = leak', '1\nI1 = aabb']) {
      assert.throws(() => parseAwgRange(value, options));
    }
  }
});
