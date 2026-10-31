// __tests__/client-key-conformance.test.js
// Keys of the generated .conf must be accepted by the config parsers of the clients we name in the registry.
// Key sets come from upstream sources (__tests__/fixtures/client-key-sets.json, written by
// scripts/extract-client-keys.js). AmneziaWG Apple before v3.1.3 rejects any [Interface]/[Peer] key outside its list.

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fixture = require('./fixtures/client-key-sets.json');
const { generate, parseConf } = require('./helpers/warp-harness');

const OLD_APPLE = 'v3.1.20260814';
const MODES = ['awg2', 'awg3', 'awg31'];
const VARIANTS = [
  ['default', {}],
  ['mobile', { mobile: '1' }],
  ['router', { router: '1' }],
  ['mobile+router', { mobile: '1', router: '1' }],
  ['cps5', { cps5: '1' }],
  ['own chains', { cps5: '1', i1: '<b 0x1234><r 12><t>', i2: '<b 0xabcd><r 8>' }],
  ['contentPaddingAddition=off', { contentPaddingAddition: 'off' }],
  ['ipv6', { ipv6: '1' }],
];

const sectionKeys = (conf, name) => {
  const section = parseConf(conf).find((s) => s.name === name);
  return section ? section.fields.map(([key]) => key.toLowerCase()) : [];
};

test('fixture covers the mandatory AmneziaWG Apple revisions', () => {
  const old = fixture.find((e) => e.version === OLD_APPLE);
  assert.ok(old, `${OLD_APPLE} is in the fixture`);
  assert.equal(old.sha, 'fe2e2d7ebb835a0a2ad1d8de75094a6de134da4d');
  assert.equal(old.interfaceKeys.length, 28);
  assert.ok(fixture.some((e) => e.version === 'v3.1.4' && e.interfaceKeys.length === 30));
  assert.deepEqual(old.peerKeys, ['publickey', 'presharedkey', 'allowedips', 'endpoint', 'persistentkeepalive']);
});

for (const mode of MODES) {
  for (const [label, extra] of VARIANTS) {
    test(`default ${mode} (${label}): every key is accepted by every client in the fixture`, async () => {
      const r = await generate({ mode, routeMode: 'full', ...extra });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const [conf] = r.configs;
      for (const entry of fixture) {
        const unknownInterface = sectionKeys(conf, 'Interface').filter((k) => !entry.interfaceKeys.includes(k));
        const unknownPeer = sectionKeys(conf, 'Peer').filter((k) => !entry.peerKeys.includes(k));
        assert.deepEqual(unknownInterface, [], `${entry.client}@${entry.version} would reject [Interface] keys`);
        assert.deepEqual(unknownPeer, [], `${entry.client}@${entry.version} would reject [Peer] keys`);
      }
    });
  }
}

test('explicit disableCookies=on|off is the only documented exception, rejected by old Apple only', async () => {
  const old = fixture.find((e) => e.version === OLD_APPLE);
  const current = fixture.find((e) => e.version === 'v3.1.4');
  for (const value of ['on', 'off']) {
    const r = await generate({ mode: 'awg31', routeMode: 'full', disableCookies: value });
    assert.equal(r.status, 200);
    const keys = sectionKeys(r.configs[0], 'Interface');
    assert.deepEqual(keys.filter((k) => !old.interfaceKeys.includes(k)), ['disablecookies']);
    assert.deepEqual(keys.filter((k) => !current.interfaceKeys.includes(k)), []);
  }
});

test('AWG 3.1 default config writes neither RandomTrailers nor DisableCookies', async () => {
  const r = await generate({ mode: 'awg31', routeMode: 'full' });
  assert.doesNotMatch(r.configs[0], /^(RandomTrailers|DisableCookies)\s*=/m);
  assert.equal(r.body.awg.capabilities.disableCookies.effectiveState, 'disabled');
  assert.ok(!r.body.awg.enabledFeatures.includes('disable-cookies'));
});

test('vpn:// import of the default AWG 3.1 config still carries protocol version 3.1', async () => {
  const r = await generate({ mode: 'awg31', routeMode: 'full', link: '1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.awg.vpnImport.protocolVersion, '3.1');
});
