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

test('CPS registry has unique canonical IDs and stable-only Auto entries', () => {
  const protocols = Object.values(CPS_PROTOCOLS);
  assert.equal(new Set(protocols.map(({ id }) => id)).size, protocols.length);
  assert.deepEqual([...AUTO_PROTOCOLS].sort(), ['sip', 'static', 'stun']);
  for (const id of AUTO_PROTOCOLS) {
    const protocol = getCpsProtocol(id);
    assert.equal(protocol.status, 'stable');
    assert.equal(protocol.autoEligible, true);
    assert.ok(protocol.evidence);
  }
});

test('CPS registry keeps QUIC, DNS and DTLS explicit experimental modes', () => {
  for (const id of ['quic', 'dns', 'dtls']) {
    assert.equal(getCpsProtocol(id).status, 'experimental');
    assert.equal(getCpsProtocol(id).autoEligible, false);
  }
});

test('TLS is unsupported and unknown CPS IDs are rejected without fallback', () => {
  assert.equal(getCpsProtocol('tls').status, 'unsupported');
  assert.throws(() => validateCpsProtocol('tls'), (error) =>
    error.statusCode === 400 && error.code === 'unsupported_cps_protocol');
  assert.throws(() => validateCpsProtocol('bogus'), (error) =>
    error.statusCode === 400 && error.code === 'invalid_cps_protocol');
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
