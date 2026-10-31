// __tests__/vpn-link-client-fields.test.js
// The vpn:// link must carry the structured fields AmneziaVPN builds for itself when it imports a .conf.
// iOS (WGConfig.swift decodes hostName, port as a number, client_ip, client_priv_key, server_pub_key, allowed_ips,
// mtu and the AWG keys), Android (Wireguard.kt: getString/getInt) and desktop (localsocketcontroller.cpp) read these
// fields, not the .conf text. A link with only { config, mtu, port } made the iOS network extension fail with
// "Can't parse WG config … hostName … found null" (AmneziaVPN 5.0.3.0, 2026-10-22).
//
// Reference: ImportController::extractWireGuardConfig, amnezia-vpn/amnezia-client tag 5.0.3.0,
// client/core/controllers/selfhosted/importController.cpp (reimplemented below, not copied).

'use strict';

const assert = require('node:assert/strict');
const { inflateSync } = require('node:zlib');
const { test } = require('node:test');
const { generate } = require('./helpers/warp-harness');

const AWG_KEYS = [
  'Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4', 'I1', 'I2', 'I3', 'I4', 'I5',
  'HeaderProtectionKey', 'ContentPaddingAddition', 'RekeyAfterTime', 'RekeyTimeout', 'RejectAfterTime',
  'KeepaliveTimeout', 'MaxHandshakeAttempts', 'RandomTrailers', 'DisableCookies',
];

/** What the client itself stores as last_config after importing `data` as a .conf. */
const clientImportLastConfig = (data) => {
  const map = new Map();
  for (const line of data.split('\n')) {
    const t = line.trim();
    if (t.startsWith('[') && t.endsWith(']')) continue;
    const i = t.indexOf('=');
    if (i > 0) map.set(t.slice(0, i).trim(), t.slice(i + 1).trim());
  }
  const endpoint = map.get('Endpoint');
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(endpoint);
  const last = { config: data, hostName: m[1] || m[2], port: Number(m[3]) };
  last.client_priv_key = map.get('PrivateKey');
  last.client_ip = map.get('Address');
  last.server_pub_key = map.get('PublicKey');
  if (map.get('PersistentKeepalive')) last.persistent_keep_alive = map.get('PersistentKeepalive');
  last.allowed_ips = (map.get('AllowedIPs') || '').split(/\s*,\s*/).filter(Boolean);
  for (const key of AWG_KEYS) if (map.get(key)) last[key] = map.get(key);
  last.mtu = map.get('MTU');
  return last;
};

const decodeLink = (link) => {
  const b64 = link.replace(/^vpn:\/\//, '').replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(b64, 'base64');
  return JSON.parse(inflateSync(buf.subarray(4)).toString('utf8'));
};

const CASES = [
  ['awg2 default', { mode: 'awg2' }],
  ['awg2 cps5', { mode: 'awg2', cps5: '1' }],
  ['awg31 default', { mode: 'awg31' }],
  ['awg31 explicit disableCookies', { mode: 'awg31', disableCookies: 'on' }],
  ['awg31 mobile + router', { mode: 'awg31', mobile: '1', router: '1' }],
  ['legacy', { mode: 'legacy' }],
];

for (const [label, query] of CASES) {
  test(`vpn:// for ${label} carries the fields the client builds on its own import`, async () => {
    const r = await generate({ routeMode: 'full', link: '1', ...query });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const link = r.body.vpnLink || r.body.configs[0].vpnLink;
    assert.ok(link && link.startsWith('vpn://'), 'a link is produced');
    const payload = decodeLink(link);
    const awg = payload.containers[0].awg;
    const lastConfig = JSON.parse(awg.last_config);
    const expected = clientImportLastConfig(r.configs[0]);

    assert.deepEqual(lastConfig, expected);
    assert.equal(typeof lastConfig.port, 'number', 'port is a number (WGConfig.swift: Int, Wireguard.kt: getInt)');
    assert.ok(Array.isArray(lastConfig.allowed_ips) && lastConfig.allowed_ips.length > 0);
    assert.equal(payload.hostName, lastConfig.hostName, 'outer hostName is the Endpoint host of the config');
    assert.equal(awg.port, String(lastConfig.port));
  });
}

test('iOS WGConfig required fields are all present and typed (outer dns plus last_config)', async () => {
  const r = await generate({ routeMode: 'full', link: '1', mode: 'awg31' });
  const payload = decodeLink(r.body.vpnLink || r.body.configs[0].vpnLink);
  const last = JSON.parse(payload.containers[0].awg.last_config);
  for (const key of ['hostName', 'client_ip', 'client_priv_key', 'server_pub_key', 'mtu']) {
    assert.equal(typeof last[key], 'string', key);
    assert.ok(last[key].length > 0, key);
  }
  assert.equal(typeof last.port, 'number');
  assert.ok(Array.isArray(last.allowed_ips));
  assert.equal(typeof payload.dns1, 'string');
  assert.equal(typeof payload.dns2, 'string');
  // the network extension builds the obfuscation block only when all of these are non-empty
  for (const key of ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'H1', 'H2', 'H3', 'H4']) {
    assert.ok(String(last[key] || '').trim() !== '', `${key} present for the iOS settings block`);
  }
});

test('Lab Auto link takes hostName from the Endpoint of the config, not from a default', async () => {
  const { buildVpnLink } = require('../src/server/vpnLinkBuilder');
  const conf = [
    '[Interface]', 'PrivateKey = AAAA', 'Address = 172.16.0.2', 'MTU = 1280', 'Jc = 5', '',
    '[Peer]', 'PublicKey = BBBB', 'AllowedIPs = 0.0.0.0/0', 'Endpoint = 162.159.192.165:4500', 'PersistentKeepalive = 25',
  ].join('\n');
  const payload = decodeLink(buildVpnLink(conf, { mode: 'awg2', hostName: 'engage.cloudflareclient.com', dns1: '1.1.1.1', dns2: '1.0.0.1' }));
  const last = JSON.parse(payload.containers[0].awg.last_config);
  assert.equal(last.hostName, '162.159.192.165');
  assert.equal(payload.hostName, '162.159.192.165');
  assert.equal(last.persistent_keep_alive, '25');
  assert.equal(last.Jc, '5');
});
