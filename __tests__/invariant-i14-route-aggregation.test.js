// __tests__/invariant-i14-route-aggregation.test.js
// I14 (CLAUDE.md, 3.1.9): the AllowedIPs of a split config cover exactly the IPv4 addresses S \ E_fixed, where S is
// the union of the routes of the selected presets and E_fixed the WARP endpoint subnets, in no more blocks than that
// set needs. Short copies of T-A1, T-A3 and T-A4 (cidr-aggregate.test.js) on the cut used by /api/warp, and one
// check through the handler. The oracle (helpers/cidr-coverage.js) shares no code with the aggregator.

'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { aggregateCidrs } = require('../src/server/cidrAggregate');
const { WARP_ENDPOINT_PREFIXES_V4 } = require('../src/server/warpEndpointPrefixes');
const { coversSame, paint16, minimalCount, mulberry32, randomBlocks16, parse } = require('./helpers/cidr-coverage');
const { generate, registrationAnswer } = require('./helpers/warp-harness');

const E_FIXED = ['162.159.192.0/24', '162.159.193.0/24', '162.159.195.0/24', '162.159.204.0/24'];
const cut = (list) => aggregateCidrs(list, { exclude: WARP_ENDPOINT_PREFIXES_V4 }).cidrs;

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

describe('I14 through /api/warp', () => {
  const LIST = ['162.158.0.0/15', '188.114.96.0/22', '10.0.0.0/9', '10.128.0.0/9', '203.0.113.4/32', '203.0.113.5/32'];
  /** Cloudflare registers; opencck answers LIST for every site it is asked about; the other list hosts fail. */
  const network = (_n, request) => {
    if (request.hostname === 'api.cloudflareclient.com') return registrationAnswer();
    if (request.hostname !== 'iplist.opencck.org') return { status: 500, body: '' };
    const sites = new URLSearchParams(request.path.slice(2)).getAll('site');
    return { status: 200, body: JSON.stringify(Object.fromEntries(sites.map((s) => [s, LIST]))) };
  };

  test('a split config of discord: AllowedIPs is S \\ E_fixed in ten plus three blocks', async () => {
    const out = await generate({ mode: 'awg2', routeMode: 'split', presets: 'discord' }, { cloudflare: network });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const allowed = /^AllowedIPs = (.+)$/m.exec(out.configs[0])[1].split(', ');
    assert.equal(coversSame(allowed, LIST, { minus: E_FIXED }).ok, true);
    // 162.158.0.0/15 without E_fixed is ten blocks; 188.114.96.0/22, 10.0.0.0/8 and 203.0.113.4/31 one each.
    assert.equal(allowed.length, 13);
  });
});
