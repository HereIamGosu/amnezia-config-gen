'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { generateDnsTemplate } = require('../src/server/cps/dns');

test('DNS CPS is a response-shaped packet with runtime transaction ID', () => {
  const template = generateDnsTemplate();
  assert.match(template, /^<r 2><b 0x[0-9a-f]+>$/);
  const packet = Buffer.concat([Buffer.alloc(2), Buffer.from(template.match(/<b 0x([0-9a-f]+)>/)[1], 'hex')]);

  assert.equal(packet.readUInt16BE(2), 0x8180);
  assert.equal(packet.readUInt16BE(4), 1);
  assert.equal(packet.readUInt16BE(6), 1);
  assert.equal(packet.readUInt16BE(8), 0);
  assert.equal(packet.readUInt16BE(10), 0);

  let offset = 12;
  while (packet[offset] !== 0) offset += packet[offset] + 1;
  offset += 1;
  assert.equal(packet.readUInt16BE(offset), 1);
  assert.equal(packet.readUInt16BE(offset + 2), 1);
  offset += 4;
  assert.equal(packet.readUInt16BE(offset), 0xc00c);
  assert.equal(packet.readUInt16BE(offset + 2), 1);
  assert.equal(packet.readUInt16BE(offset + 4), 1);
  assert.equal(packet.readUInt16BE(offset + 10), 4);
  assert.equal(packet.length, offset + 16);
});
