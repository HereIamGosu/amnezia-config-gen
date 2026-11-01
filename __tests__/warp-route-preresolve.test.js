// __tests__/warp-route-preresolve.test.js
// Split routes are resolved once per request and before any WARP registration (3.1.9, spec R6 4.5): a route list
// that comes back empty answers 502 without spending a registration, count=3 shares one resolution, and the
// IPv4-only filter of a registration without IPv6 (3.1.8) still applies per config. T-C7, T-C7b, T-C8 of R6.
// No network: the harness answers Cloudflare and the route list hosts.

'use strict';

const assert = require('node:assert/strict');
const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const registration = require('../src/server/warpRegistration');
const { generate, registrationAnswer, labProvider, labSnapshot, LAB_POOL } = require('./helpers/warp-harness');

const CLOUDFLARE = 'api.cloudflareclient.com';
const OPENCCK = 'iplist.opencck.org';
const line = (conf, key) => conf.split('\n').find((l) => l.startsWith(`${key} =`));
const cloudflareCalls = (out) => out.requests.filter((r) => r.hostname === CLOUDFLARE).length;

/** Registration k (POST, PATCH, GET) gets answers[k - 1]; the route list hosts get `lists(request)`. */
const answers = (registrations, lists) => {
  let calls = 0;
  return (_n, request) => {
    if (request.hostname !== CLOUDFLARE) return lists(request);
    calls += 1;
    return registrations[Math.min(Math.ceil(calls / 3), registrations.length) - 1];
  };
};

/** Replaces fetchCidrsForDomains of the module /api/warp will load (freshLists may have replaced it). */
const mockLists = (impl) => mock.method(require('../src/server/ipListFetch'), 'fetchCidrsForDomains', impl);

/** The route list fetchers keep a 10-minute cache: a test that fakes the list hosts starts with fresh modules. */
const freshLists = () => {
  for (const id of ['../src/server/ipListFetch', '../src/server/communityIpFetch']) delete require.cache[require.resolve(id)];
};

const unhandled = [];
const onUnhandled = (reason) => unhandled.push(reason);
beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  registration.__stats.reset();
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
});
afterEach(async () => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  process.off('unhandledRejection', onUnhandled);
  registration.__stats.reset();
  mock.restoreAll();
  assert.deepEqual(unhandled, [], 'no promise rejection may go unhandled');
});

describe('one resolution per request', () => {
  test('count=3 with presets resolves the route list once, and every config gets it', async () => {
    const fetchMock = mockLists(async () => ({ cidrs: ['203.0.113.0/24'], source: 'opencck' }));
    const out = await generate({ mode: 'awg2', count: '3', routeMode: 'split', presets: 'discord' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(out.configs.length, 3);
    for (const conf of out.configs) assert.equal(line(conf, 'AllowedIPs'), 'AllowedIPs = 203.0.113.0/24');
  });

  test('count=3, ipv6=1, the second registration without IPv6: only its config loses the IPv6 routes', async () => {
    freshLists();
    const lists = (request) => {
      if (request.hostname !== OPENCCK) return { status: 500, body: '' };
      const cidrs = request.path.includes('data=cidr6') ? ['2001:db8::/32'] : ['203.0.113.0/24'];
      return { status: 200, body: JSON.stringify({ 'discord.com': cidrs }) };
    };
    const out = await generate({ mode: 'awg2', count: '3', ipv6: '1', routeMode: 'split', presets: 'discord' }, {
      cloudflare: answers([registrationAnswer(), registrationAnswer({ v6: null }), registrationAnswer()], lists),
    });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.requests.filter((r) => r.hostname === OPENCCK).length, 2, 'cidr4 and cidr6, once each');
    assert.equal(line(out.configs[0], 'AllowedIPs'), 'AllowedIPs = 2001:db8::/32, 203.0.113.0/24');
    assert.equal(line(out.configs[1], 'AllowedIPs'), 'AllowedIPs = 203.0.113.0/24');
    assert.equal(line(out.configs[2], 'AllowedIPs'), 'AllowedIPs = 2001:db8::/32, 203.0.113.0/24');
  });

  test('mobile=1 + ipv6=1: the lists are asked for IPv4 only and AllowedIPs has no IPv6 (I7)', async () => {
    const fetchMock = mockLists(async () => ({ cidrs: ['203.0.113.0/24'], source: 'opencck' }));
    const out = await generate({ mode: 'awg2', mobile: '1', ipv6: '1', routeMode: 'split', presets: 'discord' });
    assert.equal(out.status, 200);
    assert.equal(fetchMock.mock.calls[0].arguments[1].includeIpv6, false);
    assert.doesNotMatch(line(out.configs[0], 'AllowedIPs'), /:/);
  });
});

describe('a route list that fails answers before any registration', () => {
  test('T-C8 an empty list without static routes → 502 «пустой ответ», no Cloudflare request', async () => {
    mockLists(async () => ({ cidrs: [], source: 'opencck' }));
    const out = await generate({ mode: 'awg2', count: '3', routeMode: 'split', presets: 'discord' });
    assert.equal(out.status, 502);
    assert.equal(out.body.success, false);
    assert.match(out.body.message, /пустой ответ/);
    assert.equal(cloudflareCalls(out), 0);
  });

  test('T-C7b every list source fails → 502, no registration, nothing unhandled', async () => {
    freshLists();
    const out = await generate({ mode: 'awg2', routeMode: 'split', presets: 'discord' }, {
      cloudflare: answers([registrationAnswer()], () => ({ status: 500, body: 'down' })),
    });
    assert.equal(out.status, 502);
    assert.match(out.body.message, /пустой ответ/);
    assert.equal(cloudflareCalls(out), 0);
    assert.ok(out.requests.some((r) => r.hostname === OPENCCK), 'the lists were asked');
  });

  test('a 502 by routes is not a registration outcome: the counters stay empty', async () => {
    mockLists(async () => ({ cidrs: [], source: 'opencck' }));
    const out = await generate({ mode: 'awg2', routeMode: 'split', presets: 'discord' });
    assert.equal(out.status, 502);
    const lines = [];
    assert.equal(registration.flushRegistrationStats((l) => lines.push(l)), null);
    assert.deepEqual(lines, []);
  });

  test('Lab Auto: the 502 comes after the Lab selection, which has nothing to undo; no registration', async () => {
    mockLists(async () => ({ cidrs: [], source: 'opencck' }));
    const lab = labProvider(labSnapshot(LAB_POOL));
    const out = await generate({ mode: 'awg2', endpointMode: 'lab', count: '2', routeMode: 'split', presets: 'discord' }, { lab });
    assert.equal(out.status, 502);
    assert.equal(cloudflareCalls(out), 0);
    assert.equal(lab.calls.select, 1);
    const again = await generate({ mode: 'awg2', endpointMode: 'lab', count: '2' }, { lab });
    assert.equal(again.status, 200, 'the same provider still selects');
  });

  test('a list source that throws → its error, no registration', async () => {
    mockLists(async () => { throw Object.assign(new Error('lists exploded'), { statusCode: 503 }); });
    const out = await generate({ mode: 'awg2', routeMode: 'split', presets: 'discord' });
    assert.equal(out.status, 503);
    assert.equal(cloudflareCalls(out), 0);
  });

  test('T-C7 an unknown preset → 400 before registration (3.1.1 guard, unchanged)', async () => {
    const out = await generate({ mode: 'awg2', routeMode: 'split', presets: 'no-such-preset' });
    assert.equal(out.status, 400);
    assert.equal(cloudflareCalls(out), 0);
  });
});

describe('the full tunnel does not resolve routes', () => {
  test('routeMode=full with presets: no list request, AllowedIPs 0.0.0.0/0', async () => {
    const fetchMock = mockLists(async () => ({ cidrs: ['203.0.113.0/24'], source: 'opencck' }));
    const out = await generate({ mode: 'awg2', routeMode: 'full', presets: 'discord' });
    assert.equal(out.status, 200);
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(line(out.configs[0], 'AllowedIPs'), 'AllowedIPs = 0.0.0.0/0');
  });
});
