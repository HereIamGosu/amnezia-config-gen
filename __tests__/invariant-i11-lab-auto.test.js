// __tests__/invariant-i11-lab-auto.test.js
// Invariant I11: Lab Auto changes only the endpoint. For the same request, hostname mode and Lab Auto produce
// configs with the same sections, keys, order and values except the Endpoint and fields that are random by
// design; both satisfy I1–I10 in every supported mode. Lab Auto never succeeds with a non-Lab endpoint.
// The invariant checks use the same patterns as __tests__/invariant-i1..i10.

'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { inflateSync } = require('node:zlib');
const { labSnapshot, LAB_POOL, labProvider, generate, endpointOf, parseConf } = require('./helpers/warp-harness');

const MODES = ['legacy', 'awg2', 'awg3', 'awg31'];
const VARIANTS = [
  {}, { count: '3' }, { mobile: '1' }, { router: '1' }, { mobile: '1', router: '1' }, { ipv6: '1' },
  { mobile: '1', ipv6: '1' }, { cps5: '1' }, { link: '1' }, { port: '2408', count: '2' }, { routeMode: 'full' },
  { routeMode: 'split', presets: 'control4' }, { dns: 'adguard' }, { cps: 'sip' },
];
// Differ between two identical hostname requests too (measured): keys, junk sizes and CPS packets.
const RANDOM_BY_DESIGN = new Set(['PrivateKey', 'Jc', 'Jmin', 'Jmax', 'I1', 'I2', 'I3', 'I4', 'I5']);
const AWG_MODES = new Set(['awg2', 'awg3', 'awg31']);
const POOL_ENDPOINTS = new Set(LAB_POOL.map((e) => `${e.ip}:${e.port}`));

const decodeVpnLink = (link) => {
  const buf = Buffer.from(link.slice('vpn://'.length).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return JSON.parse(inflateSync(buf.slice(4)).toString('utf8'));
};

/** I1–I10 on one rendered config (patterns from the invariant-i*.test.js files). */
const assertInvariants = (conf, mode, v, vpnLink) => {
  assert.match(conf, /^I1 = /m, 'I1');
  assert.doesNotMatch(conf, /^i1 = /m, 'I1');
  assert.match(conf, /^MTU = 1280$/m, 'I4');
  if (AWG_MODES.has(mode)) {
    for (const n of [1, 2, 3, 4]) {
      assert.match(conf, new RegExp(`^S${n} = 0$`, 'm'), 'I2');
      assert.match(conf, new RegExp(`^H${n} = ${n}$`, 'm'), 'I3');
    }
  }
  if (mode === 'awg3' || mode === 'awg31') {
    assert.doesNotMatch(conf, /^HeaderProtectionKey\s*=/m, 'I4');
    assert.doesNotMatch(conf, /^RandomTrailers = on$/m, 'I4');
  }
  if (mode === 'awg2') {
    const iface = conf.split(/\n\[Peer\]/)[0];
    let prev = -1;
    for (const f of ['PrivateKey', 'Address', 'DNS', 'MTU', 'Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4', 'I1']) {
      const idx = iface.indexOf(`\n${f} =`);
      assert.ok(idx > prev, `I5: ${f}`);
      prev = idx;
    }
  }
  const mobile = v.mobile === '1';
  const split = v.routeMode === 'split';
  if (!split) {
    if (v.ipv6 === '1' && !mobile) assert.match(conf, /^\s*AllowedIPs = 0\.0\.0\.0\/0, ::\/0$/m, 'I6');
    else assert.match(conf, /^\s*AllowedIPs = 0\.0\.0\.0\/0$/m, 'I6');
  }
  if (mobile) {
    const address = conf.split('\n').find((l) => l.startsWith('Address ='));
    assert.doesNotMatch(address, /:/, 'I7: no IPv6 Address');
    assert.doesNotMatch(conf, /^\s*AllowedIPs = .*:/m, 'I7: no IPv6 AllowedIPs');
    const routerCaps = v.router === '1' && AWG_MODES.has(mode);
    assert.match(conf, new RegExp(`^Jc = ${routerCaps ? 2 : 3}$`, 'm'), routerCaps ? 'I8' : 'I7');
    assert.match(conf, /^Jmin = 64$/m, 'I7/I8');
    assert.match(conf, /^Jmax = 128$/m, 'I7/I8');
  }
  if (v.cps5 === '1' && AWG_MODES.has(mode)) {
    for (const n of [2, 3, 4, 5]) assert.match(conf, new RegExp(`^I${n} = <b 0x[0-9a-f]+>$`, 'm'), 'I9');
  } else {
    assert.doesNotMatch(conf, /^I[2-5] = /m, 'I9');
  }
  if (v.link === '1') {
    if (mode === 'awg3') {
      assert.equal(vpnLink, undefined, 'I10: no vpn:// for AWG 3.0');
    } else {
      const obj = decodeVpnLink(vpnLink);
      assert.equal(JSON.parse(obj.containers[0].awg.last_config).config, conf, 'I10 round-trip');
      assert.equal(obj.containers[0].awg.isThirdPartyConfig, true, 'I10');
    }
  }
};

/** Field-level difference of two configs; asserts the same layout. Returns the differing non-random fields. */
const semanticDiff = (hostConf, labConf) => {
  const layout = (c) => c.split('\n').map((l) => l.replace(/ = .*$/, ' = …'));
  assert.deepEqual(layout(labConf), layout(hostConf), 'same lines, blank lines and key order');
  const a = parseConf(hostConf);
  const b = parseConf(labConf);
  const diffs = [];
  a.forEach((section, i) => section.fields.forEach(([key, value], j) => {
    const other = b[i].fields[j][1];
    if (RANDOM_BY_DESIGN.has(key)) {
      if (/^J/.test(key)) assert.match(other, /^\d+$/);
      else if (key === 'PrivateKey') assert.match(other, /^[A-Za-z0-9+/]{43}=$/);
      else assert.match(other, /^<[\s\S]*>$/);
    } else if (value !== other) {
      diffs.push(`${section.name}.${key}`);
    }
  }));
  return diffs;
};

/** `cps=auto` picks one stable protocol per config at random (by design): keep only that it is a stable one. */
const autoCps = (o) => {
  if (o.cpsRequested !== 'auto') return o;
  assert.ok(['static', 'sip', 'stun'].includes(o.cpsResolved), o.cpsResolved);
  return { ...o, cpsResolved: 'auto:stable' };
};

const omit = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

/** Response fields that must not depend on the endpoint source. */
const responseShape = (body) => ({
  ...autoCps(omit(body, ['lab', 'warning', 'content', 'vpnLink', 'configs'])),
  hasContent: typeof body.content === 'string',
  topLevelMatchesFirst: body.content === body.configs[0].content && body.vpnLink === body.configs[0].vpnLink,
  configs: body.configs.map((cfg) => ({
    ...autoCps(omit(cfg, ['content', 'vpnLink', 'endpointSource', 'index'])), hasLink: Boolean(cfg.vpnLink),
  })),
});

for (const mode of MODES) {
  describe(`I11 ${mode}: Lab Auto changes only the endpoint`, () => {
    for (const variant of VARIANTS) {
      test(JSON.stringify(variant), async () => {
        const query = { mode, port: '4500', ...variant };
        const host = await generate(query, { lab: labProvider(labSnapshot(LAB_POOL)) });
        const lab = await generate({ ...query, endpointMode: 'lab' }, { lab: labProvider(labSnapshot(LAB_POOL)) });
        assert.equal(host.status, 200, JSON.stringify(host.body));
        assert.equal(lab.status, 200, JSON.stringify(lab.body));
        assert.equal(lab.configs.length, host.configs.length, 'the pool has enough distinct IPs for every count');

        host.configs.forEach((conf, i) => {
          assert.equal(host.body.configs[i].endpointSource, 'hostname');
          assert.equal(endpointOf(conf), `engage.cloudflareclient.com:${variant.port || 4500}`);
          assertInvariants(conf, mode, variant, host.body.configs[i].vpnLink);
        });
        lab.configs.forEach((conf, i) => {
          assert.equal(lab.body.configs[i].endpointSource, 'lab');
          assert.ok(POOL_ENDPOINTS.has(endpointOf(conf)), endpointOf(conf));
          assertInvariants(conf, mode, variant, lab.body.configs[i].vpnLink);
          assert.deepEqual(semanticDiff(host.configs[i], conf), ['Peer.Endpoint']);
        });
        assert.deepEqual(responseShape(lab.body), responseShape(host.body), 'response metadata other than lab/warning');
        for (const w of [].concat(lab.body.warning ?? [])) {
          if (!host.body.warning || ![].concat(host.body.warning).includes(w)) assert.match(w, /^Endpoint Lab: /);
        }
      });
    }

    test('a Lab Auto request without usable Lab data is never a hostname success', async () => {
      for (const lab of [labProvider(labSnapshot([])), labProvider(labSnapshot(LAB_POOL), { missing: true })]) {
        const r = await generate({ mode, port: '4500', endpointMode: 'lab', link: '1', count: '2' }, { lab });
        assert.equal(r.status, 503);
        assert.equal(r.body.success, false);
        assert.equal(r.configs.length, 0);
      }
    });
  });
}
