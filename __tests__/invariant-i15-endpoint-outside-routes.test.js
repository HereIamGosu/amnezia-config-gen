// __tests__/invariant-i15-endpoint-outside-routes.test.js
// I15 (CLAUDE.md, 3.2.0, spec 3.2.0 §5.4): in a split config AllowedIPs does not cover the Endpoint address — for
// hostname through E4/E6 (engage = 162.159.192.1, 2606:4700:d0::a29f:c001), for Lab Auto and the built-in endpoints
// by the choice of the candidate, for a manual override by the cut of its /32 (/128). Through the real /api/warp
// handler without network; coverage is decided by helpers/cidr-coverage.js, which shares no code with the server.

'use strict';

const assert = require('node:assert/strict');
const { describe, test, beforeEach } = require('node:test');
const { generate, registrationAnswer, endpointOf, labProvider, labSnapshot, labEndpoint, LAB_POOL } = require('./helpers/warp-harness');
const { coversSame, coversSame6 } = require('./helpers/cidr-coverage');
const { __internals: { FALLBACK_ENDPOINTS } } = require('../api/warp');
const { HARDCODED_FALLBACK } = require('../src/server/endpointCache');

const CLOUDFLARE = 'api.cloudflareclient.com';
const OPENCCK = 'iplist.opencck.org';
const E4 = ['162.159.192.0/24', '162.159.193.0/24', '162.159.195.0/24', '162.159.204.0/24'];
const E6 = ['2606:4700:d0::/48', '2606:4700:d1::/48'];
// Cloudflare networks as public lists bring them: engage and the whole Lab and FALLBACK pool lie inside.
const ROUTES = ['162.158.0.0/15', '188.114.96.0/20', '104.16.0.0/13', '198.51.100.0/24'];
const ROUTES6 = ['2606:4700::/32', '2001:db8::/32'];

const network = (_n, request) => {
  if (request.hostname === CLOUDFLARE) return registrationAnswer();
  if (request.hostname !== OPENCCK) return { status: 500, body: '' };
  const sites = new URLSearchParams(request.path.slice(2)).getAll('site');
  const list = request.path.includes('data=cidr6') ? ROUTES6 : ROUTES;
  return { status: 200, body: JSON.stringify(Object.fromEntries(sites.map((s) => [s, list]))) };
};
const freshLists = () => {
  for (const id of ['../src/server/ipListFetch', '../src/server/communityIpFetch']) delete require.cache[require.resolve(id)];
};
beforeEach(freshLists);

const split = (query, opts = {}) => generate({ mode: 'awg2', routeMode: 'split', presets: 'discord', ...query }, { cloudflare: network, ...opts });
const allowedOf = (conf) => /^AllowedIPs = (.+)$/m.exec(conf)[1].split(', ');
const v4 = (list) => list.filter((c) => !c.includes(':'));
const v6 = (list) => list.filter((c) => c.includes(':'));
const warnings = (body) => [].concat(body.warning ?? []);
const cloudflareCalls = (out) => out.requests.filter((r) => r.hostname === CLOUDFLARE).length;
/** Whether the AllowedIPs of a config route `address` into the tunnel: adding its /32 (/128) changes nothing. */
const routes = (conf, address) => (address.includes(':')
  ? coversSame6(v6(allowedOf(conf)), [...v6(allowedOf(conf)), `${address}/128`]).ok
  : coversSame(v4(allowedOf(conf)), [...v4(allowedOf(conf)), `${address}/32`]).ok);
const endpointAddress = (conf) => endpointOf(conf).replace(/:\d+$/, '').replace(/^\[(.+)\]$/, '$1');

describe('I15 hostname: E4 and E6 keep engage outside AllowedIPs', () => {
  test('engage.cloudflareclient.com: 162.159.192.1 and 2606:4700:d0::a29f:c001 are not routed', async () => {
    const out = await split({ ipv6: '1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(endpointOf(out.configs[0]), 'engage.cloudflareclient.com:4500');
    assert.equal(routes(out.configs[0], '162.159.192.1'), false);
    assert.equal(routes(out.configs[0], '2606:4700:d0::a29f:c001'), false);
    assert.equal(routes(out.configs[0], '188.114.96.3'), true, 'ordinary Cloudflare sites stay routed');
    assert.equal(coversSame(v4(allowedOf(out.configs[0])), ROUTES, { minus: E4 }).ok, true);
    assert.equal(coversSame6(v6(allowedOf(out.configs[0])), ROUTES6, { minus: E6 }).ok, true);
  });
});

describe('I15 Lab Auto: the selection skips the endpoints the routes cover', () => {
  test('a pool half inside the routes: every Lab endpoint is outside AllowedIPs (20 requests, count=3)', async () => {
    for (let i = 0; i < 20; i += 1) {
      const out = await split({ endpointMode: 'lab', count: '3', port: '' }, { lab: labProvider(labSnapshot(LAB_POOL)) });
      assert.equal(out.status, 200, JSON.stringify(out.body));
      for (const conf of out.configs) {
        assert.equal(routes(conf, endpointAddress(conf)), false, endpointOf(conf));
        assert.doesNotMatch(endpointOf(conf), /^188\.114\./);
      }
    }
  });

  test('a pool only inside the routes → 503 lab_endpoints_in_routes before registration, never hostname', async () => {
    const pool = [labEndpoint('188.114.96.31', 4500), labEndpoint('188.114.97.41', 500)];
    const out = await split({ endpointMode: 'lab', count: '2' }, { lab: labProvider(labSnapshot(pool)) });
    assert.equal(out.status, 503, JSON.stringify(out.body));
    assert.deepEqual(Object.keys(out.body).sort(), ['error', 'message', 'success']);
    assert.equal(out.body.error, 'lab_endpoints_in_routes');
    assert.equal(out.headers.getHeader('Retry-After'), '60');
    assert.equal(cloudflareCalls(out), 0);
    assert.equal(out.configs.length, 0);
  });

  test('the same pool with the full tunnel: no route filter, the Lab endpoint is used', async () => {
    const pool = [labEndpoint('188.114.96.31', 4500)];
    const out = await generate({ mode: 'awg2', endpointMode: 'lab' }, { cloudflare: network, lab: labProvider(labSnapshot(pool)) });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(endpointOf(out.configs[0]), '188.114.96.31:4500');
  });
});

describe('I15 built-in endpoints (templates without engageHost): only a filter of the candidates', () => {
  test('the built-in pools always hold endpoints inside E4, in three /24s, so a candidate always remains', () => {
    for (const pool of [FALLBACK_ENDPOINTS, HARDCODED_FALLBACK]) {
      const inE4 = pool.filter((e) => coversSame(E4, [...E4, `${e.ip}/32`]).ok);
      assert.ok(new Set(inE4.map((e) => e.cidr24)).size >= 3, JSON.stringify(inE4));
    }
  });

  for (const template of ['awg2_random', 'awg2_dpi']) {
    for (const port of ['4500', '2408']) {
      test(`${template}, port ${port}: the Endpoint is never inside AllowedIPs (25 requests, count=3)`, async () => {
        for (let i = 0; i < 25; i += 1) {
          freshLists();
          const out = await split({ template, port, count: '3' });
          assert.equal(out.status, 200, JSON.stringify(out.body));
          for (const conf of out.configs) {
            assert.doesNotMatch(endpointOf(conf), /^188\.114\./, 'the 188.114.96.0/20 candidates are inside the routes');
            assert.equal(routes(conf, endpointAddress(conf)), false, endpointOf(conf));
          }
        }
      });
    }
  }

  // Spec 3.2.0 §5.4 p. 3 as written: the cloudflare preset from the snapshot (its official ips-v4 hold 188.114.96.0/20),
  // a port other than 2408, random choice.
  test('the cloudflare preset, port 4500, awg2_random: never a 188.114.x endpoint (25 requests, count=3)', async () => {
    for (let i = 0; i < 25; i += 1) {
      const out = await split({ presets: 'cloudflare', template: 'awg2_random', port: '4500', count: '3' });
      assert.equal(out.status, 200, JSON.stringify(out.body));
      for (const conf of out.configs) {
        assert.ok(routes(conf, '188.114.96.3'), 'the preset routes 188.114.96.0/20');
        assert.doesNotMatch(endpointOf(conf), /^188\.114\./);
        assert.equal(routes(conf, endpointAddress(conf)), false, endpointOf(conf));
      }
    }
  });
});

describe('I15 manual override: its /32 (/128) leaves AllowedIPs, with a warning', () => {
  test('an override inside the routes: AllowedIPs = S \\ (E4 ∪ O4), the warning names it', async () => {
    const out = await split({ peerEndpoint: '188.114.96.7:2408' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(endpointOf(out.configs[0]), '188.114.96.7:2408');
    assert.equal(routes(out.configs[0], '188.114.96.7'), false);
    assert.equal(coversSame(allowedOf(out.configs[0]), ROUTES, { minus: [...E4, '188.114.96.7/32'] }).ok, true);
    assert.deepEqual(warnings(out.body).filter((w) => w.startsWith('Endpoint override')), ['Endpoint override inside routes: 188.114.96.7']);
  });

  test('an override outside the routes: AllowedIPs = S \\ E4, no warning', async () => {
    const out = await split({ peerEndpoint: '203.0.113.9:2408' });
    assert.equal(out.status, 200);
    assert.equal(coversSame(allowedOf(out.configs[0]), ROUTES, { minus: E4 }).ok, true);
    assert.deepEqual(warnings(out.body), []);
  });

  test('an IPv6 override with ipv6=1: the IPv6 part is S6 \\ (E6 ∪ O6); without ipv6=1 nothing to cut', async () => {
    const out = await split({ peerEndpoint: '[2606:4700:4700::1111]:2408', ipv6: '1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(routes(out.configs[0], '2606:4700:4700::1111'), false);
    assert.equal(coversSame6(v6(allowedOf(out.configs[0])), ROUTES6, { minus: [...E6, '2606:4700:4700::1111/128'] }).ok, true);
    assert.deepEqual(warnings(out.body), ['Endpoint override inside routes: 2606:4700:4700::1111']);
    const plain = await split({ peerEndpoint: '[2606:4700:4700::1111]:2408' });
    assert.equal(plain.status, 200);
    assert.deepEqual(v6(allowedOf(plain.configs[0])), []);
    assert.deepEqual(warnings(plain.body), []);
  });

  test('the full tunnel is never cut, with an override inside 0.0.0.0/0', async () => {
    const out = await generate({ mode: 'awg2', peerEndpoint: '188.114.96.7:2408' }, { cloudflare: network });
    assert.equal(out.status, 200);
    assert.deepEqual(allowedOf(out.configs[0]), ['0.0.0.0/0']);
    assert.equal(out.body.warning, undefined);
  });

  test('an override that is not a valid address → 400 before registration (was accepted, and 500 with routes)', async () => {
    for (const bad of ['999.1.1.1:2408', '1.2.3.4:0', '1.2.3.4:70000', '01.2.3.4:2408', '[2606:zz::1]:2408', '[::1::2]:2408']) {
      for (const query of [{ peerEndpoint: bad }, { endpoint: bad }]) {
        const out = await split(query);
        assert.equal(out.status, 400, `${bad}: ${JSON.stringify(out.body)}`);
        assert.equal(out.body.error, 'peer_endpoint_invalid');
        assert.equal(out.requests.length, 0, `${bad}: no route list, no registration`);
      }
    }
  });

  test('a value that is not an IP endpoint is ignored as before (hostname)', async () => {
    const out = await split({ peerEndpoint: 'engage.cloudflareclient.com:2408' });
    assert.equal(out.status, 200);
    assert.equal(endpointOf(out.configs[0]), 'engage.cloudflareclient.com:4500');
  });
});
