'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  buildQuicInitial,
  decodeQuicVarInt,
  deriveInitialSecrets,
  encodeQuicVarInt,
  unprotectQuicInitial,
} = require('../src/server/cps/quic');
const { fixedBytesTemplate, parseFixedBytesTemplate } = require('../src/server/cps/templates');

test('QUIC v1 key derivation matches RFC 9001 Appendix A', () => {
  const secrets = deriveInitialSecrets(Buffer.from('8394c8f03e515708', 'hex'));
  assert.equal(secrets.initialSecret.toString('hex'), '7db5df06e7a69e432496adedb00851923595221596ae2ae9fb8115c1e9ed0a44');
  assert.equal(secrets.clientInitialSecret.toString('hex'), 'c00cf151ca5be075ed0ebfb5c80323c42d6b7db67881289af4008f1f6c357aea');
  assert.equal(secrets.key.toString('hex'), '1f369613dd76d5467730efcbe3b1a22d');
  assert.equal(secrets.iv.toString('hex'), 'fa044b2f42a3fd3b46fb255c');
  assert.equal(secrets.hp.toString('hex'), '9f50449e04a0e810283a1e9933adedd2');
});

test('QUIC varints preserve every encoding boundary without signed truncation', () => {
  const values = [0n, 63n, 64n, 16383n, 16384n, (1n << 30n) - 1n, 1n << 30n, (1n << 62n) - 1n];
  for (const value of values) {
    const encoded = encodeQuicVarInt(value);
    const decoded = decodeQuicVarInt(encoded);
    assert.equal(decoded.value, value);
    assert.equal(decoded.bytes, encoded.length);
  }
  assert.throws(() => encodeQuicVarInt(1n << 62n), RangeError);
});

test('protected QUIC Initial is exactly 1200 bytes and decrypts to its CRYPTO frame', () => {
  const options = {
    dcid: Buffer.from('8394c8f03e515708', 'hex'),
    scid: Buffer.from('f067a5502a4262b5', 'hex'),
    packetNumber: 2,
    clientRandom: Buffer.alloc(32, 0x11),
    keyShare: Buffer.alloc(32, 0x22),
    serverName: 'cloudflare.com',
    targetLength: 1200,
  };
  const built = buildQuicInitial(options);
  assert.equal(built.packet.length, 1200);
  assert.equal(built.plaintext[0], 0x06, 'payload must start with a CRYPTO frame');

  const opened = unprotectQuicInitial(built.packet);
  assert.equal(opened.packetNumber, 2n);
  assert.deepEqual(opened.plaintext, built.plaintext);
  assert.equal(opened.dcid.toString('hex'), options.dcid.toString('hex'));
  const cryptoLength = decodeQuicVarInt(opened.plaintext, 2);
  assert.equal(opened.plaintext[2 + cryptoLength.bytes], 0x01, 'CRYPTO data must start with TLS ClientHello');
  assert.ok(opened.plaintext.includes(Buffer.from('cloudflare.com', 'ascii')));
});

test('QUIC template preserves the complete packet across bounded adjacent byte tags', () => {
  const { packet } = buildQuicInitial({ targetLength: 1200 });
  const template = fixedBytesTemplate(packet);
  const chunks = [...template.matchAll(/<b 0x([0-9a-f]+)>/g)].map((match) => Buffer.from(match[1], 'hex'));
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 1000));
  assert.deepEqual(parseFixedBytesTemplate(template), packet);
});
