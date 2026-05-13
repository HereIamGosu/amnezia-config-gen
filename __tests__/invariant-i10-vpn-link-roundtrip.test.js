const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { inflateSync } = require('zlib');
const { Buffer } = require('buffer');
const { buildVpnLink } = require('../api/vpnLinkBuilder');

const fromBase64Url = (s) => {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
  return Buffer.from(norm + pad, 'base64');
};

describe('Invariant I10: vpn:// link round-trip', () => {
  test('vpn:// decodes (qUncompress + JSON.parse) to last_config matching input', () => {
    const sampleConf = [
      '[Interface]',
      'PrivateKey = AAAA',
      'Address = 172.16.0.2',
      'DNS = 1.1.1.1',
      'MTU = 1280',
      '',
      '[Peer]',
      'PublicKey = BBBB',
      'AllowedIPs = 0.0.0.0/0, ::/0',
      'Endpoint = engage.cloudflareclient.com:4500',
    ].join('\n');

    const link = buildVpnLink(sampleConf, {
      hostName: 'engage.cloudflareclient.com',
      dns1: '1.1.1.1',
      dns2: '1.0.0.1',
      mode: 'awg2',
    });
    assert.ok(link.startsWith('vpn://'), 'must start with vpn://');

    const buf = fromBase64Url(link.slice('vpn://'.length));
    // qCompress: first 4 bytes BE uint32 length of UNCOMPRESSED payload, rest is zlib (inflate, not raw).
    assert.ok(buf.length > 4, 'compressed payload must be longer than length prefix');
    const declaredLen = buf.readUInt32BE(0);
    const inflated = inflateSync(buf.slice(4));
    assert.equal(inflated.length, declaredLen, 'inflated length must match declared length prefix');

    const obj = JSON.parse(inflated.toString('utf8'));
    assert.equal(obj.defaultContainer, 'awg');
    assert.equal(obj.containers[0].container, 'awg');
    const innerJson = JSON.parse(obj.containers[0].awg.last_config);
    assert.equal(innerJson.config, sampleConf, 'inner config must equal original .conf text');
    assert.equal(innerJson.mtu, '1280');
    assert.equal(innerJson.port, '4500');
  });

  test('vpn:// MTU/port extraction defaults when fields missing', () => {
    const minimalConf = '[Interface]\nPrivateKey = X\n\n[Peer]\nPublicKey = Y\n';
    const link = buildVpnLink(minimalConf);
    const buf = fromBase64Url(link.slice('vpn://'.length));
    const inflated = inflateSync(buf.slice(4));
    const obj = JSON.parse(inflated.toString('utf8'));
    const innerJson = JSON.parse(obj.containers[0].awg.last_config);
    assert.equal(innerJson.mtu, '1280', 'MTU defaults to 1280 when no MTU= line');
    assert.equal(innerJson.port, '4500', 'port defaults to 4500 when no Endpoint=host:port line');
  });
});
