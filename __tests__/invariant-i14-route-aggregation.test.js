// __tests__/invariant-i14-route-aggregation.test.js
// I14 (CLAUDE.md, 3.1.9, generalised in 3.2.0): the IPv4 part of a split AllowedIPs covers exactly S \ (E4 ∪ O4),
// where S is the union of the routes of the selected presets, E4 the WARP endpoint subnets and O4 the /32 of a
// manual override covered by S, in no more blocks than that set needs; with ipv6=1 the IPv6 part is S6 \ (E6 ∪ O6),
// entries that do not touch the subtrahend pass unchanged. Short copies of T-A1, T-A3 and T-A4
// (cidr-aggregate.test.js) on the cut used by /api/warp, and checks through the handler. The oracle
// (helpers/cidr-coverage.js) shares no code with the aggregator.

'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { aggregateCidrs } = require('../src/server/cidrAggregate');
const { WARP_ENDPOINT_PREFIXES_V4, WARP_ENDPOINT_PREFIXES_V6 } = require('../src/server/warpEndpointPrefixes');
const { coversSame, coversSame6, paint16, minimalCount, mulberry32, randomBlocks16, parse } = require('./helpers/cidr-coverage');
const { generate, registrationAnswer } = require('./helpers/warp-harness');

const E_FIXED = ['162.159.192.0/24', '162.159.193.0/24', '162.159.195.0/24', '162.159.204.0/24'];
const E6 = ['2606:4700:d0::/48', '2606:4700:d1::/48'];
const cut = (list) => aggregateCidrs(list, { exclude: WARP_ENDPOINT_PREFIXES_V4 }).cidrs;
const cut6 = (list) => aggregateCidrs(list, { exclude6: WARP_ENDPOINT_PREFIXES_V6 }).cidrs;

describe('I14: S \\ E_fixed, exactly and minimally', () => {
  test('E_fixed is the four WARP endpoint /24 of decision No. 18, nothing more', () => {
    assert.deepEqual([...WARP_ENDPOINT_PREFIXES_V4], E_FIXED);
  });

  for (const [name, cidr] of [['162.159.0.0/16 (holds E_fixed)', '162.159.0.0/16'], ['10.0.0.0/16 (outside E_fixed)', '10.0.0.0/16']]) {
    test(`100 seeded cases inside ${name}: exact coverage of S \\ E_fixed and the minimal number of blocks`, () => {
      const base = parse(cidr)[0];
      for (let seed = 1; seed <= 100; seed += 1) {
        const random = mulberry32(seed);
        const s = randomBlocks16(random, base, 1 + Math.floor(random() * 60));
        const out = cut(s);
        assert.equal(coversSame(out, s, { minus: E_FIXED }).ok, true, `seed ${seed}`);
        assert.equal(out.length, minimalCount(paint16(s, base, { minus: E_FIXED })), `seed ${seed}: minimal`);
      }
    });
  }

  test('edges: aligned /32 pairs merge, unaligned do not; 0.0.0.0/0 becomes the space without E_fixed', () => {
    assert.deepEqual(cut(['1.2.3.4/32', '1.2.3.5/32']), ['1.2.3.4/31']);
    assert.deepEqual(cut(['1.2.3.5/32', '1.2.3.6/32']), ['1.2.3.5/32', '1.2.3.6/32']);
    assert.deepEqual(cut(['10.0.0.0/9', '10.128.0.0/9']), ['10.0.0.0/8']);
    const space = cut(['0.0.0.0/0']);
    assert.equal(coversSame(space, ['0.0.0.0/0'], { minus: E_FIXED }).ok, true);
    // The holes lie in 162.159.192.0/19: one sibling block on each of the 19 levels above it, and inside it
    // 194/24, 196/22, 200/22, 205/24, 206/23, 208/20.
    assert.equal(space.length, 19 + 6);
  });
});

describe('I14 IPv6: S6 \\ E6, entries off E6 unchanged, no IPv6 aggregation', () => {
  test('E6 is the two WARP endpoint /48 (engage 2606:4700:d0::a29f:c001), nothing more', () => {
    assert.deepEqual([...WARP_ENDPOINT_PREFIXES_V6], E6);
  });

  test('the Cloudflare /32, the engage /48 and an unrelated network', () => {
    const s6 = ['2606:4700::/32', '2606:4700:d0::/48', '2001:db8::/33', '2001:db8:8000::/33'];
    const out = cut6(s6);
    assert.equal(coversSame6(out, s6, { minus: E6 }).ok, true);
    assert.equal(coversSame6(out, out, { minus: E6 }).ok, true, 'nothing of E6');
    assert.ok(out.includes('2001:db8::/33') && out.includes('2001:db8:8000::/33'), 'untouched entries stay as they were');
    assert.equal(out.length, 15 + 2);
  });

  test('the whole IPv6 space becomes the space without E6 (::/0 touches it)', () => {
    const out = cut6(['::/0']);
    assert.equal(coversSame6(out, ['::/0'], { minus: E6 }).ok, true);
    assert.equal(out.length, 47, 'one sibling on each of the 47 levels above the /47');
  });
});

describe('I14 through /api/warp', () => {
  const LIST = ['162.158.0.0/15', '188.114.96.0/22', '10.0.0.0/9', '10.128.0.0/9', '203.0.113.4/32', '203.0.113.5/32'];
  const LIST6 = ['2606:4700::/32', '2001:db8::/33', '2001:db8:8000::/33'];
  /** Cloudflare registers; opencck answers LIST (LIST6 for cidr6) for every site it is asked about. */
  const network = (_n, request) => {
    if (request.hostname === 'api.cloudflareclient.com') return registrationAnswer();
    if (request.hostname !== 'iplist.opencck.org') return { status: 500, body: '' };
    const sites = new URLSearchParams(request.path.slice(2)).getAll('site');
    const list = request.path.includes('data=cidr6') ? LIST6 : LIST;
    return { status: 200, body: JSON.stringify(Object.fromEntries(sites.map((s) => [s, list]))) };
  };
  const allowedOf = (conf) => /^AllowedIPs = (.+)$/m.exec(conf)[1].split(', ');

  test('a split config of discord: AllowedIPs is S \\ E_fixed in ten plus three blocks', async () => {
    const out = await generate({ mode: 'awg2', routeMode: 'split', presets: 'discord' }, { cloudflare: network });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const allowed = allowedOf(out.configs[0]);
    assert.equal(coversSame(allowed, LIST, { minus: E_FIXED }).ok, true);
    // 162.158.0.0/15 without E_fixed is ten blocks; 188.114.96.0/22, 10.0.0.0/8 and 203.0.113.4/31 one each.
    assert.equal(allowed.length, 13);
  });

  test('ipv6=1: the IPv4 part is S \\ E_fixed, the IPv6 part S6 \\ E6', async () => {
    const out = await generate({ mode: 'awg2', routeMode: 'split', presets: 'discord', ipv6: '1' }, { cloudflare: network });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const allowed = allowedOf(out.configs[0]);
    assert.equal(coversSame(allowed.filter((c) => !c.includes(':')), LIST, { minus: E_FIXED }).ok, true);
    const six = allowed.filter((c) => c.includes(':'));
    assert.equal(coversSame6(six, LIST6, { minus: E6 }).ok, true);
    assert.equal(six.length, 15 + 2);
  });
});
