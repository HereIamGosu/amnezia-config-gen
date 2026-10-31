// __tests__/invariant-edges-e2e.test.js
// Edges of I6–I8 and I11 through the real /api/warp handler (no network), where the invariant files check only
// builder functions or only the status code: every Lab refusal code before WARP registration, router caps without
// mobile and in legacy, mobile+router+ipv6 with several configs, and the IPv4-only boundary of the opencck stage.

'use strict';

const assert = require('node:assert/strict');
const { describe, test, mock } = require('node:test');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const { labSnapshot, LAB_POOL, labProvider, generate, iso, NOW } = require('./helpers/warp-harness');
const { fetchCidrsForDomains } = require('../src/server/ipListFetch');

const MODES = ['legacy', 'awg2', 'awg3', 'awg31'];
const num = (conf, key) => Number(new RegExp(`^${key} = (\\d+)$`, 'm').exec(conf)?.[1]);

/** Router caps (I8): Jc <= 2, Jmin in [40, 64], Jmax <= 128 and at least Jmin + 64 (spread rule of 2.7.0). */
const assertRouterJunk = (conf, label) => {
  const jc = num(conf, 'Jc');
  const jmin = num(conf, 'Jmin');
  const jmax = num(conf, 'Jmax');
  assert.ok(jc >= 1 && jc <= 2, `${label}: Jc ${jc}`);
  assert.ok(jmin >= 40 && jmin <= 64, `${label}: Jmin ${jmin}`);
  assert.ok(jmax <= 128 && jmax - jmin >= 64, `${label}: Jmin ${jmin} Jmax ${jmax}`);
};

describe('I11: a Lab Auto refusal is 503 lab_* before any WARP registration', () => {
  const refusals = {
    lab_no_endpoints: () => labProvider(labSnapshot([])),
    lab_unavailable: () => labProvider(labSnapshot(LAB_POOL), { missing: true }),
    lab_stale: () => labProvider(labSnapshot(LAB_POOL, { generated_at: iso(NOW - 900000), expires_at: iso(NOW - 1000) })),
    'lab_unavailable (unreadable file)': () => labProvider('{not json'),
  };
  for (const mode of MODES) {
    for (const [name, lab] of Object.entries(refusals)) {
      test(`${mode}: ${name}`, async () => {
        const r = await generate({ mode, endpointMode: 'lab', count: '2', link: '1' }, { lab: lab() });
        assert.equal(r.status, 503);
        assert.equal(r.body.error, name.split(' ')[0]);
        assert.equal(r.apiCalls, 0, 'no Cloudflare registration');
        assert.equal(r.configs.length, 0);
        assert.equal(r.body.vpnLink, undefined);
        assert.match(String(r.headers.getHeader('Retry-After')), /^\d+$/);
      });
    }
  }
});

describe('I8: router caps apply in every mode, with and without mobile', () => {
  for (const mode of MODES) {
    test(`${mode}: router=1`, async () => {
      for (let i = 0; i < 10; i += 1) {
        const r = await generate({ mode, router: '1', count: '2' });
        assert.equal(r.status, 200);
        r.configs.forEach((conf, n) => assertRouterJunk(conf, `${mode} #${i}.${n}`));
      }
    });

    test(`${mode}: mobile=1 + router=1 gives Jc=2, Jmin=64, Jmax=128`, async () => {
      const r = await generate({ mode, mobile: '1', router: '1' });
      assert.equal(r.status, 200);
      assert.equal(num(r.configs[0], 'Jc'), 2, 'router cap wins over mobile Jc=3');
      assert.equal(num(r.configs[0], 'Jmin'), 64);
      assert.equal(num(r.configs[0], 'Jmax'), 128);
    });
  }

  test('legacy without router keeps its template junk', async () => {
    const conf = (await generate({ mode: 'legacy' })).configs[0];
    assert.deepEqual([num(conf, 'Jc'), num(conf, 'Jmin'), num(conf, 'Jmax')], [120, 23, 911]);
  });

  test('legacy router=1 + ipv6=1 keeps the IPv6 default route (router is not mobile)', async () => {
    const conf = (await generate({ mode: 'legacy', router: '1', ipv6: '1' })).configs[0];
    assert.match(conf, /^\s*AllowedIPs = 0\.0\.0\.0\/0, ::\/0$/m);
    assert.match(conf.split('\n').find((l) => l.startsWith('Address =')), /:/);
  });
});

describe('I6–I8: mobile+router+ipv6 holds for every config of a count=3 request', () => {
  for (const mode of MODES) {
    test(mode, async () => {
      const r = await generate({ mode, mobile: '1', router: '1', ipv6: '1', count: '3' });
      assert.equal(r.status, 200);
      assert.equal(r.configs.length, 3);
      for (const conf of r.configs) {
        const address = conf.split('\n').find((l) => l.startsWith('Address ='));
        assert.doesNotMatch(address, /:/, 'I7: mobile overrides ipv6=1 in Address');
        assert.match(conf, /^\s*AllowedIPs = 0\.0\.0\.0\/0$/m, 'I6/I7: IPv4-only AllowedIPs');
        assert.equal(num(conf, 'Jc'), 2, 'I8: router cap wins over mobile Jc=3');
        assert.equal(num(conf, 'Jmin'), 64);
        assert.equal(num(conf, 'Jmax'), 128);
      }
    });
  }
});

describe('I6: the opencck stage stays IPv4-only by default', () => {
  const answer = (body) => mock.method(https, 'request', (options, cb) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.setTimeout = () => req;
    req.end = () => setImmediate(() => {
      cb(res);
      res.emit('data', Buffer.from(JSON.stringify(body(options.path))));
      res.emit('end');
    });
    return req;
  });

  test('an IPv6 entry in a cidr4 answer is dropped without includeIpv6', async () => {
    const httpsMock = answer(() => ({ 'v6-leak.example': ['203.0.113.0/24', '2001:db8::/32', '198.51.100.7'] }));
    try {
      const { cidrs } = await fetchCidrsForDomains(['v6-leak.example']);
      // Only the IPv6 entry goes; a bare IPv4 address is kept exactly as before the filter.
      assert.deepEqual([...cidrs], ['198.51.100.7', '203.0.113.0/24']);
    } finally {
      httpsMock.mock.restore();
    }
  });

  test('with includeIpv6 the cidr6 answer is kept', async () => {
    const httpsMock = answer((p) => (p.includes('data=cidr6')
      ? { 'v6-opt-in.example': ['2001:db8::/32'] }
      : { 'v6-opt-in.example': ['203.0.113.0/24'] }));
    try {
      const { cidrs } = await fetchCidrsForDomains(['v6-opt-in.example'], { includeIpv6: true });
      assert.deepEqual([...cidrs], ['2001:db8::/32', '203.0.113.0/24']);
    } finally {
      httpsMock.mock.restore();
    }
  });
});
