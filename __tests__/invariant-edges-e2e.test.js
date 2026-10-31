// __tests__/invariant-edges-e2e.test.js
// Edges of I6–I8 and I11 through the real /api/warp handler (no network), where the invariant files check only
// builder functions or only the status code: every Lab refusal code before WARP registration, router caps without
// mobile, mobile+router+ipv6 with several configs, and the IPv4-only boundary of the opencck stage.

'use strict';

const assert = require('node:assert/strict');
const { describe, test, mock } = require('node:test');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const { labSnapshot, LAB_POOL, labProvider, generate, iso, NOW } = require('./helpers/warp-harness');
const { fetchCidrsForDomains } = require('../src/server/ipListFetch');

const MODES = ['legacy', 'awg2', 'awg3', 'awg31'];
const AWG_MODES = ['awg2', 'awg3', 'awg31'];
const num = (conf, key) => Number(new RegExp(`^${key} = (\\d+)$`, 'm').exec(conf)?.[1]);

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

describe('I8: router caps apply without mobile too (AWG modes; legacy is the todo below)', () => {
  for (const mode of AWG_MODES) {
    test(`${mode}: router=1 keeps Jc <= 2 and Jmin/Jmax inside the router bounds`, async () => {
      for (let i = 0; i < 10; i += 1) {
        const r = await generate({ mode, router: '1', count: '2' });
        assert.equal(r.status, 200);
        for (const conf of r.configs) {
          assert.ok(num(conf, 'Jc') <= 2, `Jc ${num(conf, 'Jc')}`);
          assert.ok(num(conf, 'Jmin') >= 40 && num(conf, 'Jmin') <= 128, `Jmin ${num(conf, 'Jmin')}`);
          // Jmin = Jmax = 128 is common here (Jmin is drawn up to 800, then clamped); see the 2026-10-31 audit.
          assert.ok(num(conf, 'Jmax') <= 128 && num(conf, 'Jmax') >= num(conf, 'Jmin'), `Jmax ${num(conf, 'Jmax')}`);
        }
      }
    });
  }
});

describe('I8: router caps in legacy mode', () => {
  // Known gap (2026-10-31): router caps apply only to the AWG 2.0/3.x obfuscation object (api/warp.js
  // applyRouterModeCaps on awg2Obf), so legacy keeps Jc=120 (Jc=3 with mobile) under router=1, while I8 in
  // CLAUDE.md says Jc <= 2 without a mode exception. Owner decides: caps for legacy, or I8 narrowed to AWG modes.
  test('legacy: router=1 keeps Jc <= 2, with and without mobile', { todo: 'I8 scope for legacy is undecided' }, async () => {
    for (const extra of [{}, { mobile: '1' }]) {
      const r = await generate({ mode: 'legacy', router: '1', ...extra });
      assert.equal(r.status, 200);
      assert.ok(num(r.configs[0], 'Jc') <= 2, `Jc ${num(r.configs[0], 'Jc')} with ${JSON.stringify(extra)}`);
    }
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
        // Legacy Jc under router=1 is the open question below; it is not asserted here.
        if (AWG_MODES.includes(mode)) assert.equal(num(conf, 'Jc'), 2, 'I8: router cap wins over mobile Jc=3');
        assert.equal(num(conf, 'Jmin'), 64);
        assert.equal(num(conf, 'Jmax'), 128);
      }
    });
  }
});

describe('I6: the opencck stage stays IPv4-only by default', () => {
  // Known gap (2026-10-31): flattenCidrMap keeps whatever the cidr4 answer holds, so an IPv6 entry in it reaches
  // split-mode AllowedIPs without ipv6=1 (mobile mode filters it later, desktop does not). Remove `todo` with the fix.
  test('an IPv6 entry in a cidr4 answer is dropped without includeIpv6', { todo: 'ipListFetch trusts the cidr4 answer' }, async () => {
    const httpsMock = mock.method(https, 'request', (options, cb) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      const req = new EventEmitter();
      req.write = () => {};
      req.destroy = () => {};
      req.setTimeout = () => req;
      req.end = () => setImmediate(() => {
        cb(res);
        res.emit('data', Buffer.from(JSON.stringify({ 'v6-leak.example': ['203.0.113.0/24', '2001:db8::/32'] })));
        res.emit('end');
      });
      return req;
    });
    try {
      const { cidrs } = await fetchCidrsForDomains(['v6-leak.example']);
      assert.ok(cidrs.includes('203.0.113.0/24'));
      assert.deepEqual(cidrs.filter((c) => c.includes(':')), []);
    } finally {
      httpsMock.mock.restore();
    }
  });
});
