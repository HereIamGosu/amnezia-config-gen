'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { generateCpsPayload, generateStunPayload, crc32 } = require('../src/server/cpsGenerator');
const { AUTO_PROTOCOLS } = require('../src/server/cps/protocols');
const { parseFixedBytesTemplate } = require('../src/server/cps/templates');

test('explicit stable generators return observable result metadata', async () => {
  for (const id of AUTO_PROTOCOLS) {
    const result = await generateCpsPayload(id);
    assert.equal(result.requested, id);
    assert.equal(result.resolved, id);
    assert.equal(result.stability, 'stable');
    assert.match(result.value, /^(?:<[br][^>]*>)+$/);
  }
});

test('Auto resolves only to stable generators and reports the actual choice', async () => {
  for (let index = 0; index < 30; index += 1) {
    const result = await generateCpsPayload('auto');
    assert.equal(result.requested, 'auto');
    assert.ok(AUTO_PROTOCOLS.includes(result.resolved));
    assert.equal(result.stability, 'stable');
    assert.ok(result.value.length > 0);
  }
});

test('STUN payload has correct message length, magic cookie and FINGERPRINT', () => {
  const packet = generateStunPayload();
  assert.equal(packet.readUInt16BE(0), 0x0001);
  assert.equal(packet.readUInt16BE(2), packet.length - 20);
  assert.equal(packet.readUInt32BE(4), 0x2112a442);
  assert.equal(packet.readUInt16BE(packet.length - 8), 0x8028);
  assert.equal(packet.readUInt16BE(packet.length - 6), 4);
  assert.equal(packet.readUInt32BE(packet.length - 4), (crc32(packet.subarray(0, -8)) ^ 0x5354554e) >>> 0);
});

test('SIP and static stable templates expand to non-empty deterministic byte sequences', async () => {
  for (const id of ['sip', 'static']) {
    const result = await generateCpsPayload(id);
    const bytes = parseFixedBytesTemplate(result.value);
    assert.ok(bytes.length > 0);
    if (id === 'sip') {
      assert.match(bytes.toString('utf8'), /^INVITE sip:/);
      assert.match(bytes.toString('utf8'), /\r\nCall-ID: /);
    }
  }
});

test('explicit DTLS remains experimental and has a consistent record/handshake envelope', async () => {
  const result = await generateCpsPayload('dtls');
  const packet = parseFixedBytesTemplate(result.value);
  assert.equal(result.stability, 'experimental');
  assert.equal(packet[0], 0x16);
  assert.equal(packet.readUInt16BE(1), 0xfefd);
  assert.equal(packet.readUInt16BE(11), packet.length - 13);
  assert.equal(packet[13], 0x01);
});
