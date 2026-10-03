'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  AUTO_PROTOCOLS,
  CPS_PROTOCOLS,
  getCpsProtocol,
  validateCpsProtocol,
} = require('../src/server/cps/protocols');

const EXPECTED_EVIDENCE_STATUS = Object.freeze({
  static: 'verified',
  sip: 'verified',
  stun: 'verified',
  quic: 'experimental',
  dns: 'experimental',
  dtls: 'experimental',
  tls: 'unsupported',
});

const EXPECTED_LEGACY_STATUS = Object.freeze({
  static: 'stable',
  sip: 'stable',
  stun: 'stable',
  quic: 'experimental',
  dns: 'experimental',
  dtls: 'experimental',
  tls: 'unsupported',
});

test('CPS registry has unique canonical IDs and stable-only Auto entries', () => {
  const protocols = Object.values(CPS_PROTOCOLS);
  assert.equal(new Set(protocols.map(({ id }) => id)).size, protocols.length);
  assert.deepEqual([...AUTO_PROTOCOLS].sort(), ['sip', 'static', 'stun']);
  for (const id of AUTO_PROTOCOLS) {
    const protocol = getCpsProtocol(id);
    assert.equal(protocol.status, 'stable');
    assert.equal(protocol.evidenceStatus, 'verified');
    assert.equal(protocol.autoEligible, true);
    assert.ok(Array.isArray(protocol.evidence));
    assert.ok(protocol.evidence.length > 0);
  }
});

test('CPS evidence metadata is structured without replacing legacy stability terms', () => {
  for (const [id, protocol] of Object.entries(CPS_PROTOCOLS)) {
    assert.equal(protocol.status, EXPECTED_LEGACY_STATUS[id]);
    assert.equal(protocol.evidenceStatus, EXPECTED_EVIDENCE_STATUS[id]);
    assert.ok(Array.isArray(protocol.evidence));
    assert.ok(protocol.evidence.length > 0);
    assert.equal(typeof protocol.evidenceSummary, 'string');
    assert.ok(protocol.evidenceSummary.length > 0);
    for (const record of protocol.evidence) {
      assert.equal(typeof record.type, 'string');
      assert.equal(typeof record.ref, 'string');
      assert.ok(record.type.length > 0);
      assert.ok(record.ref.length > 0);
    }
  }
});

test('CPS registry keeps QUIC, DNS and DTLS explicit experimental modes', () => {
  for (const id of ['quic', 'dns', 'dtls']) {
    assert.equal(getCpsProtocol(id).status, 'experimental');
    assert.equal(getCpsProtocol(id).evidenceStatus, 'experimental');
    assert.equal(getCpsProtocol(id).autoEligible, false);
  }
});

test('TLS is unsupported and unknown CPS IDs are rejected without fallback', () => {
  assert.equal(getCpsProtocol('tls').status, 'unsupported');
  assert.equal(getCpsProtocol('tls').evidenceStatus, 'unsupported');
  assert.throws(() => validateCpsProtocol('tls'), (error) =>
    error.statusCode === 400 && error.code === 'unsupported_cps_protocol');
  assert.throws(() => validateCpsProtocol('bogus'), (error) =>
    error.statusCode === 400 && error.code === 'invalid_cps_protocol');
});

test('Auto CPS can never include unverified, experimental or unsupported protocols', () => {
  const autoProtocols = new Set(AUTO_PROTOCOLS);
  for (const protocol of Object.values(CPS_PROTOCOLS)) {
    const shouldBeAutoEligible = protocol.status === 'stable'
      && protocol.evidenceStatus === 'verified'
      && protocol.autoEligible === true;
    assert.equal(autoProtocols.has(protocol.id), shouldBeAutoEligible);
  }
  for (const id of ['quic', 'dns', 'dtls', 'tls']) {
    assert.equal(autoProtocols.has(id), false);
  }
});

test('CPS selector stays synchronized with all supported registry entries', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const values = [...html.matchAll(/name="cpsProtocol"\s+value="([^"]+)"/g)].map((match) => match[1]);
  const supported = ['auto', ...Object.values(CPS_PROTOCOLS)
    .filter(({ status }) => status !== 'unsupported')
    .map(({ id }) => id)];
  assert.deepEqual(values.sort(), supported.sort());
  assert.ok(!values.includes('tls'));
});
