// __tests__/endpoint-provider.test.js
// Endpoint Lab Phase C: provider abstraction, fail-closed snapshot parsing, diverse selection and shadow mode.
// Shadow mode must never change a /api/warp response.

'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test, mock } = require('node:test');
const https = require('node:https');
const net = require('node:net');

const {
  validateLabSnapshot, LabEndpointProvider, ShadowRecorder, createShadowFromEnv, BuiltinEndpointProvider,
  MAX_SNAPSHOT_BYTES,
} = require('../src/server/endpointProvider');

const NOW = Date.parse('2026-10-04T18:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const IP_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;

function endpoint(ip, port, { verifiedAgo = 60, expiresIn = 360, ms = 50 } = {}) {
  return { ip, port, family: 4, state: 'active', lab_verified_at: iso(NOW - verifiedAgo * 1000),
    expires_at: iso(NOW + expiresIn * 1000), source_class: 'consumer_official_seed',
    probe_completion_ms: 80, traffic_total_ms: ms };
}

function snapshot(endpoints, overrides = {}) {
  return { schema_version: 2, generated_at: iso(NOW - 20000), expires_at: iso(NOW + 160000), lab_status: 'ok',
    active_count: endpoints.length, endpoints, ...overrides };
}

const POOL = [endpoint('162.159.192.1', 2408), endpoint('162.159.192.2', 500), endpoint('162.159.192.3', 1701),
  endpoint('162.159.192.4', 4500), endpoint('162.159.195.1', 2408)];

function providerFor(doc, opts = {}) {
  const text = typeof doc === 'string' ? doc : JSON.stringify(doc);
  const calls = { read: 0 };
  const provider = new LabEndpointProvider({
    path: '/run/endpoint-lab/active-pool.json',
    now: () => NOW,
    stat: () => ({ mtimeMs: opts.mtime ?? 1, size: opts.size ?? Buffer.byteLength(text) }),
    readFile: () => { calls.read += 1; return text; },
    random: opts.random ?? (() => 0.42),
  });
  return { provider, calls };
}

// ── snapshot validation (fail closed) ───────────────────────────────────────────

test('valid snapshot yields only fresh active endpoints', () => {
  const doc = snapshot([...POOL, endpoint('162.159.192.9', 2408, { expiresIn: -5 })]);
  const parsed = validateLabSnapshot(doc, NOW);
  assert.equal(parsed.labStatus, 'ok');
  assert.equal(parsed.endpoints.length, POOL.length);
  assert.deepEqual(validateLabSnapshot(snapshot(POOL, { expires_at: iso(NOW - 1000) }), NOW).endpoints, []);
});

test('snapshot validation rejects anything unexpected', () => {
  const bad = [
    snapshot(POOL, { schema_version: 1 }),
    { ...snapshot(POOL), extra: true },
    snapshot(POOL, { lab_status: 'great' }),
    snapshot(POOL, { active_count: 99 }),
    snapshot(POOL, { generated_at: iso(NOW + 3600 * 1000) }),
    snapshot(POOL, { generated_at: '2026-10-04 18:00:00' }),
    snapshot([endpoint('8.8.8.8', 2408)]),
    snapshot([endpoint('162.159.192.1', 51820)]),
    snapshot([{ ...endpoint('162.159.192.1', 2408), private_key: 'x' }]),
    snapshot([{ ...endpoint('162.159.192.1', 2408), family: 6 }]),
    'not an object',
    null,
  ];
  for (const doc of bad) {
    assert.throws(() => validateLabSnapshot(doc, NOW), Error, JSON.stringify(doc)?.slice(0, 60));
  }
});

// ── Lab provider ───────────────────────────────────────────────────────────────

test('missing, oversized, corrupt, stale and empty snapshots are unavailable', () => {
  const missing = new LabEndpointProvider({ path: '/nope', stat: () => { throw new Error('ENOENT'); } });
  assert.equal(missing.select({ count: 1 }).reason, 'snapshot_missing');
  assert.equal(providerFor(snapshot(POOL), { size: MAX_SNAPSHOT_BYTES + 1 }).provider.select().reason, 'snapshot_too_large');
  assert.equal(providerFor('{oops').provider.select().reason, 'snapshot_invalid_json');
  assert.equal(providerFor(snapshot(POOL, { lab_status: 'x' })).provider.select().reason, 'snapshot_rejected');
  assert.equal(providerFor(snapshot(POOL, { expires_at: iso(NOW - 1) })).provider.select().reason, 'snapshot_stale');
  assert.equal(providerFor(snapshot([])).provider.select().reason, 'pool_empty');
});

test('snapshot is re-read only when it changes', () => {
  const { provider, calls } = providerFor(snapshot(POOL));
  provider.select();
  provider.select({ count: 2 });
  assert.equal(calls.read, 1);
});

test('count 3 gets three distinct IPs and distinct ports while possible', () => {
  let seed = 0;
  const { provider } = providerFor(snapshot(POOL), { random: () => { seed = (seed * 7 + 3) % 10; return seed / 10; } });
  for (let i = 0; i < 20; i += 1) {
    const r = provider.select({ count: 3 });
    assert.equal(r.available, true);
    assert.equal(r.distinct, 3);
    assert.equal(new Set(r.endpoints.map((e) => e.ip)).size, 3);
    assert.equal(new Set(r.endpoints.map((e) => e.port)).size, 3);
  }
});

test('fewer distinct endpoints instead of duplicates', () => {
  const { provider } = providerFor(snapshot([endpoint('162.159.192.1', 2408), endpoint('162.159.192.1', 500)]));
  const r = provider.select({ count: 3 });
  assert.equal(r.distinct, 1);
  assert.equal(r.requested, 3);
});

test('requested port is preferred, with a recorded fallback', () => {
  const { provider } = providerFor(snapshot(POOL));
  const r = provider.select({ count: 1, port: 4500 });
  assert.equal(r.portMatched, true);
  assert.equal(r.endpoints[0].port, 4500);
  const { provider: p2 } = providerFor(snapshot([endpoint('162.159.192.1', 2408)]));
  const r2 = p2.select({ count: 1, port: 4500 });
  assert.equal(r2.portMatched, false);
  assert.equal(r2.endpoints[0].port, 2408);
});

test('a short requested port is filled from other ports with distinct IPs', () => {
  const { provider } = providerFor(snapshot(POOL));
  const r = provider.select({ count: 3, port: 2408 });
  assert.equal(r.distinct, 3);
  assert.equal(new Set(r.endpoints.map((e) => e.ip)).size, 3);
  assert.equal(r.endpoints.filter((e) => e.port === 2408).length, 2);  // both 2408 endpoints come first
  assert.equal(r.portMatched, false);
});

test('builtin provider is the default and the factory needs explicit env', () => {
  assert.equal(new BuiltinEndpointProvider().name, 'builtin');
  assert.equal(createShadowFromEnv({}), null);
  assert.equal(createShadowFromEnv({ ENDPOINT_SHADOW: 'lab' }), null);
  assert.ok(createShadowFromEnv({ ENDPOINT_SHADOW: 'lab', ENDPOINT_LAB_POOL_PATH: '/x' }) instanceof ShadowRecorder);
});

// ── shadow recorder ────────────────────────────────────────────────────────────

test('shadow keeps aggregates only and never logs endpoints', () => {
  const lines = [];
  let t = NOW;
  const { provider } = providerFor(snapshot(POOL));
  const shadow = new ShadowRecorder({ provider, log: (l) => lines.push(l), now: () => t, flushEveryMs: 1000 });
  shadow.observe({ count: 1 });
  shadow.observe({ count: 3, port: 2408 });
  shadow.observe({ count: 2 });
  const s = shadow.summary();
  assert.equal(s.requests, 3);
  assert.equal(s.shadow_lab_available, 3);
  assert.equal(s.shadow_selected, 6);
  assert.equal(s.shadow_distinct_count_for_count_2_3['3'].distinct_sum, 3);
  t += 2000;
  shadow.observe({ count: 1 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[endpoint-shadow\] \{/);
  assert.doesNotMatch(lines[0].replace(/"window_(start|end)":"[^"]+"/g, ''), IP_RE);
});

test('shadow counts unavailability reasons and swallows provider errors', () => {
  const shadow = new ShadowRecorder({ provider: { select: () => ({ available: false, reason: 'snapshot_stale', endpoints: [] }) },
    log: () => {}, now: () => NOW });
  shadow.observe({ count: 1 });
  const broken = new ShadowRecorder({ provider: { select: () => { throw new Error('boom'); } }, log: () => {}, now: () => NOW });
  assert.doesNotThrow(() => broken.observe({ count: 1 }));
  assert.deepEqual(shadow.summary().shadow_lab_unavailable, { snapshot_stale: 1 });
  assert.equal(broken.summary().shadow_errors, 1);
});

// ── /api/warp integration: shadow never changes the response ────────────────────

const FAKE_WARP_RESPONSE = JSON.stringify({
  result: {
    id: 'shadow-id', token: 'shadow-token',
    config: {
      peers: [{ public_key: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=', endpoint: { v4: '162.159.192.1:2408' } }],
      interface: { addresses: { v4: '172.16.0.2', v6: 'fd01::2' } },
    },
  },
});

function installWarpMock() {
  return mock.method(https, 'request', (options, cb) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => setImmediate(() => { cb(res); res.emit('data', Buffer.from(FAKE_WARP_RESPONSE)); res.emit('end'); });
    return req;
  });
}

function makeReq(query) {
  return { method: 'GET', url: `/api/warp?${new URLSearchParams(query)}`, query, body: null,
    socket: { remoteAddress: '10.0.0.1' }, headers: {} };
}

function makeRes(events) {
  let status = 200;
  let body = null;
  const res = {
    setHeader() {},
    status(code) { status = code; return res; },
    json(data) { body = data; events.push('json'); return res; },
    getStatus: () => status,
    getBody: () => body,
  };
  return res;
}

const shape = (body) => ({ success: body.success, mode: body.mode, count: body.count, keys: Object.keys(body).sort(),
  configKeys: body.configs.map((c) => Object.keys(c).sort()), endpointSource: body.configs.map((c) => c.endpointSource) });

async function generate(query, shadow) {
  delete require.cache[require.resolve('../api/warp')];
  const httpsMock = installWarpMock();
  const realNet = net.createConnection;
  net.createConnection = () => { const s = new EventEmitter(); s.destroy = () => {}; setImmediate(() => s.emit('connect')); return s; };
  try {
    const handler = require('../api/warp');
    handler.__internals.setEndpointShadow(shadow);
    const events = [];
    const res = makeRes(events);
    if (shadow) shadow.events = events;
    await handler(makeReq(query), res);
    return { status: res.getStatus(), body: res.getBody(), events };
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNet;
  }
}

test('shadow observes Auto requests after the response and leaves it unchanged', async () => {
  const observed = [];
  const shadow = { observe(req) { this.events.push('shadow'); observed.push(req); } };
  const plain = await generate({ mode: 'awg2', count: '2', port: '4500' }, null);
  const shadowed = await generate({ mode: 'awg2', count: '2', port: '4500' }, shadow);
  assert.equal(shadowed.status, 200);
  assert.deepEqual(shape(shadowed.body), shape(plain.body));
  assert.deepEqual(shadowed.events, ['json', 'shadow']); // response first, shadow afterwards
  assert.deepEqual(observed, [{ count: 2, port: 4500 }]);
});

test('a failing shadow cannot break generation; manual endpoints are not observed', async () => {
  const throwing = { observe() { this.events.push('shadow'); throw new Error('lab exploded'); } };
  const r = await generate({ mode: 'awg2' }, throwing);
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  const counting = { calls: 0, observe() { this.calls += 1; } };
  await generate({ mode: 'awg2', peerEndpoint: '162.159.192.1:2408' }, counting);
  assert.equal(counting.calls, 0);
});
