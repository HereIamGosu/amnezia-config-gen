// __tests__/lab-auto.test.js
// Phase D, Lab Auto (`endpointMode=lab`) through the real /api/warp handler: the failure matrix, request
// validation and the hostname mode staying exactly as before. Every failure is a controlled error before any
// WARP registration; no case ever succeeds with a hostname endpoint.

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { inflateSync } = require('node:zlib');
const {
  NOW, labEndpoint, labSnapshot, LAB_POOL, labProvider, generate, endpointOf,
} = require('./helpers/warp-harness');

const endpointsOf = (pool) => new Set(pool.map((e) => `${e.ip}:${e.port}`));
const ENGAGE = 'engage.cloudflareclient.com';
// Nothing internal may reach the user: paths, errno names, exception text, stack frames, Lab files.
const INTERNALS = /\/run\/|\/var\/|\/etc\/|ENOENT|EIO|Error:|\n\s+at |active-pool|lab\.db|wg\.key|identity|snapshot_/i;

const assertLabSuccess = (r, n, pool = LAB_POOL) => {
  const allowed = endpointsOf(pool);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.success, true);
  assert.equal(r.body.count, n);
  assert.equal(r.configs.length, n);
  for (const [i, cfg] of r.body.configs.entries()) {
    assert.equal(cfg.endpointSource, 'lab', `config ${i + 1} must come from the Lab`);
    assert.ok(allowed.has(endpointOf(r.configs[i])), `config ${i + 1} endpoint ${endpointOf(r.configs[i])} is from the pool`);
    assert.doesNotMatch(r.configs[i], new RegExp(ENGAGE));
  }
  assert.equal(new Set(r.configs.map((c) => endpointOf(c).split(':')[0])).size, n, 'distinct endpoint IPs');
};

const assertFailClosed = (r, code) => {
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body).sort(), ['error', 'message', 'success']);
  assert.equal(r.body.success, false);
  assert.equal(r.body.error, code);
  assert.equal(r.headers.getHeader('Retry-After'), '60');
  assert.doesNotMatch(r.body.message, INTERNALS);
  assert.equal(r.apiCalls, 0, 'no WARP device is registered when the Lab cannot select');
  assert.equal(r.configs.length, 0);
};

const labAuto = (extra = {}) => ({ mode: 'awg2', endpointMode: 'lab', port: '4500', ...extra });

// ── healthy Lab ────────────────────────────────────────────────────────────────

test('healthy Lab with enough ACTIVE: each config gets its own fresh Lab endpoint', async () => {
  for (const [query, n] of [[labAuto(), 1], [labAuto({ port: '2408', count: '2' }), 2], [labAuto({ count: '3', port: '' }), 3]]) {
    const r = await generate(query, { lab: labProvider(labSnapshot(LAB_POOL)) });
    assertLabSuccess(r, n);
    const ports = r.configs.map((c) => Number(endpointOf(c).split(':')[1]));
    assert.deepEqual(r.body.lab, {
      requested: n, selected: n, requestedPort: query.port ? Number(query.port) : null, portMatched: true, ports,
    });
    assert.equal(r.body.warning, undefined, 'nothing to warn about');
    if (query.port) assert.ok(ports.every((p) => p === Number(query.port)), 'requested port kept');
  }
});

test('a degraded Lab still serves endpoints it verified within their TTL', async () => {
  const r = await generate(labAuto(), { lab: labProvider(labSnapshot(LAB_POOL, { lab_status: 'degraded' })) });
  assertLabSuccess(r, 1);
});

// ── fail closed ────────────────────────────────────────────────────────────────

const FAILURES = [
  ['stale snapshot', () => labProvider(labSnapshot(LAB_POOL, { expires_at: new Date(NOW - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') })), 'lab_stale'],
  ['no snapshot file (Lab unavailable / not mounted)', () => labProvider(labSnapshot(LAB_POOL), { missing: true }), 'lab_unavailable'],
  ['Lab reports itself unavailable', () => labProvider(labSnapshot(LAB_POOL, { lab_status: 'unavailable' })), 'lab_unavailable'],
  ['malformed: not JSON', () => labProvider('{"schema_version": 2, "endpoints": ['), 'lab_unavailable'],
  ['malformed: other schema', () => labProvider(labSnapshot(LAB_POOL, { schema_version: 3 })), 'lab_unavailable'],
  ['malformed: endpoint outside WARP prefixes', () => labProvider(labSnapshot([...LAB_POOL, labEndpoint('8.8.8.8', 2408)])), 'lab_unavailable'],
  ['partial: one endpoint with unknown fields rejects the whole file', () => labProvider(labSnapshot([...LAB_POOL, { ...labEndpoint('162.159.192.99', 2408), extra: 1 }])), 'lab_unavailable'],
  ['0 ACTIVE', () => labProvider(labSnapshot([])), 'lab_no_endpoints'],
  ['every endpoint expired while the file is not', () => labProvider(labSnapshot(LAB_POOL.map((e) => ({ ...e, expires_at: '2026-10-05T20:59:00Z' })))), 'lab_no_endpoints'],
];

for (const [name, make, code] of FAILURES) {
  test(`fail closed: ${name} → ${code}, never hostname`, async () => {
    for (const query of [labAuto(), labAuto({ count: '3' }), labAuto({ mode: 'legacy' }), labAuto({ mode: 'awg31', link: '1' })]) {
      const r = await generate(query, { lab: make() });
      assertFailClosed(r, code);
    }
  });
}

test('a provider that answers ok without endpoints, or with an unknown code, still fails closed', async () => {
  const stub = (answer) => ({ provider: { selectForGeneration: () => answer } });
  assertFailClosed(await generate(labAuto(), { lab: stub({ ok: true, endpoints: [], requested: 1, distinct: 0 }) }), 'lab_no_endpoints');
  assertFailClosed(await generate(labAuto(), { lab: stub({ ok: false, code: 'snapshot_rejected' }) }), 'lab_unavailable');
});

// ── count and diversity ────────────────────────────────────────────────────────

test('1 ACTIVE + count=1 → success with that endpoint', async () => {
  const pool = [labEndpoint('162.159.192.11', 2408)];
  const r = await generate(labAuto({ port: '2408' }), { lab: labProvider(labSnapshot(pool)) });
  assertLabSuccess(r, 1, pool);
  assert.equal(endpointOf(r.configs[0]), '162.159.192.11:2408');
});

test('1 ACTIVE + count>1 → one config, never a duplicate IP, with an explicit warning', async () => {
  const pool = [labEndpoint('162.159.192.11', 2408)];
  const r = await generate(labAuto({ port: '2408', count: '3' }), { lab: labProvider(labSnapshot(pool)) });
  assertLabSuccess(r, 1, pool);
  assert.equal(r.body.lab.requested, 3);
  assert.equal(r.body.lab.selected, 1);
  assert.match(String(r.body.warning), /^Endpoint Lab: only 1 distinct fresh verified endpoint\(s\) for 3 requested configs\.$/);
});

test('two endpoints on one IP are one endpoint for diversity', async () => {
  const pool = [labEndpoint('162.159.192.11', 2408), labEndpoint('162.159.192.11', 500)];
  const r = await generate(labAuto({ count: '2', port: '' }), { lab: labProvider(labSnapshot(pool)) });
  assertLabSuccess(r, 1, pool);
});

// ── port semantics ─────────────────────────────────────────────────────────────

test('requested port present in the pool: every config uses it', async () => {
  const r = await generate(labAuto({ port: '500', count: '2' }), { lab: labProvider(labSnapshot(LAB_POOL)) });
  assertLabSuccess(r, 2);
  assert.ok(r.configs.every((c) => endpointOf(c).endsWith(':500')));
  assert.equal(r.body.lab.portMatched, true);
});

test('requested port absent from the pool: the documented fallback to other Lab ports, reported', async () => {
  // 880 is allowlisted for hostname mode, but the Lab verifies only 2408/500/1701/4500.
  const r = await generate(labAuto({ port: '880', count: '2' }), { lab: labProvider(labSnapshot(LAB_POOL)) });
  assertLabSuccess(r, 2);
  assert.equal(r.body.lab.requestedPort, 880);
  assert.equal(r.body.lab.portMatched, false);
  assert.ok(r.configs.every((c) => !endpointOf(c).endsWith(':880')));
  assert.match(String(r.body.warning), /^Endpoint Lab: not enough fresh verified endpoints on port 880; other verified ports were used \(/);
  // Partly short: the requested port first, the rest from other ports.
  const mixed = await generate(labAuto({ port: '4500', count: '3' }), { lab: labProvider(labSnapshot(LAB_POOL)) });
  assertLabSuccess(mixed, 3);
  assert.equal(mixed.configs.filter((c) => endpointOf(c).endsWith(':4500')).length, 2, 'both 4500 endpoints first');
  assert.equal(mixed.body.lab.portMatched, false);
});

// ── partial snapshot and time ──────────────────────────────────────────────────

test('partial snapshot: expired endpoints are skipped, fresh ones still served', async () => {
  const pool = [labEndpoint('162.159.192.11', 2408), ...LAB_POOL.slice(1).map((e) => ({ ...e, expires_at: '2026-10-05T20:59:00Z' }))];
  const r = await generate(labAuto({ port: '', count: '3' }), { lab: labProvider(labSnapshot(pool)) });
  assertLabSuccess(r, 1, pool.slice(0, 1));
  assert.equal(endpointOf(r.configs[0]), '162.159.192.11:2408');
});

test('snapshot expiring during the request: selection made once, before registration, is kept', async () => {
  const lab = labProvider(labSnapshot(LAB_POOL));
  const expiry = Date.parse(labSnapshot(LAB_POOL).expires_at);
  // The first Cloudflare request moves the clock past the snapshot and every endpoint expiry.
  const r = await generate(labAuto({ count: '3', port: '' }), { lab, onRegistration: () => { lab.clock.now = expiry + 3600e3; } });
  assertLabSuccess(r, 3);
  assert.equal(lab.calls.select, 1, 'never re-selected');
  // The next request sees the stale file and fails closed.
  assertFailClosed(await generate(labAuto(), { lab }), 'lab_stale');
});

// ── request validation ─────────────────────────────────────────────────────────

test('endpointMode is strict and validated before reading the Lab or registering', async () => {
  for (const [query, code] of [
    [{ mode: 'awg2', endpointMode: 'auto' }, 'invalid_endpoint_mode'],
    [{ mode: 'awg2', endpointMode: 'lab-auto' }, 'invalid_endpoint_mode'],
    [labAuto({ peerEndpoint: '162.159.192.1:2408' }), 'endpoint_mode_conflict'],
    [labAuto({ endpoint: '162.159.192.1:2408' }), 'endpoint_mode_conflict'],
    [labAuto({ template: 'awg2_random' }), 'lab_template_unsupported'],
  ]) {
    const lab = labProvider(labSnapshot(LAB_POOL));
    const r = await generate(query, { lab });
    assert.equal(r.status, 400, JSON.stringify(query));
    assert.equal(r.body.success, false);
    assert.equal(r.body.error, code);
    assert.equal(r.apiCalls, 0);
    assert.equal(lab.calls.select, 0);
  }
  assert.deepEqual((await generate({ mode: 'awg2', endpointMode: 'auto' })).body.allowedEndpointModes, ['hostname', 'lab']);
});

test('endpointMode works from the query in any case and from a POST body', async () => {
  assertLabSuccess(await generate(labAuto({ endpointMode: ' LAB ' }), { lab: labProvider(labSnapshot(LAB_POOL)) }), 1);
  const r = await generate({}, { method: 'POST', body: { mode: 'awg31', endpointMode: 'lab', port: 2408, count: 2 },
    lab: labProvider(labSnapshot(LAB_POOL)) });
  assertLabSuccess(r, 2);
  assert.equal(r.body.mode, 'awg31');
});

// ── hostname mode stays 2.7.4 ──────────────────────────────────────────────────

test('hostname mode (default or explicit) ignores the Lab completely', async () => {
  const shape = (body) => ({ keys: Object.keys(body).sort(), configKeys: body.configs.map((c) => Object.keys(c).sort()),
    sources: body.configs.map((c) => c.endpointSource), count: body.count, mode: body.mode });
  for (const lab of [labProvider(labSnapshot(LAB_POOL)), labProvider(labSnapshot([]), { missing: true })]) {
    const plain = await generate({ mode: 'awg2', port: '4500', count: '2', link: '1' }, { lab });
    const explicit = await generate({ mode: 'awg2', port: '4500', count: '2', link: '1', endpointMode: 'hostname' }, { lab });
    for (const r of [plain, explicit]) {
      assert.equal(r.status, 200);
      assert.ok(r.configs.every((c) => endpointOf(c) === `${ENGAGE}:4500`));
      assert.equal(r.body.lab, undefined);
      assert.equal(r.body.warning, undefined);
    }
    assert.deepEqual(shape(explicit.body), shape(plain.body));
    assert.deepEqual(plain.body.configs.map((c) => c.endpointSource), ['hostname', 'hostname']);
    assert.equal(lab.calls.select, 0, 'the Lab is never consulted in hostname mode');
  }
});

test('shadow observes hostname requests only; Lab Auto is not a shadow sample', async () => {
  const observed = [];
  const shadow = { observe(req) { observed.push(req); } };
  await generate(labAuto(), { lab: labProvider(labSnapshot(LAB_POOL)), shadow });
  assert.deepEqual(observed, []);
  await generate({ mode: 'awg2', port: '4500' }, { lab: labProvider(labSnapshot(LAB_POOL)), shadow });
  assert.deepEqual(observed, [{ count: 1, port: 4500 }]);
});

// ── vpn:// import ──────────────────────────────────────────────────────────────

test('Lab Auto vpn:// links name the Lab IP and round-trip to the same config (I10)', async () => {
  const fromBase64Url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  for (const mode of ['legacy', 'awg2', 'awg31']) {
    const r = await generate(labAuto({ mode, link: '1', count: '2', port: '' }), { lab: labProvider(labSnapshot(LAB_POOL)) });
    assertLabSuccess(r, 2);
    for (const [i, cfg] of r.body.configs.entries()) {
      const buf = fromBase64Url(cfg.vpnLink.slice('vpn://'.length));
      const obj = JSON.parse(inflateSync(buf.slice(4)).toString('utf8'));
      const [ip, port] = endpointOf(r.configs[i]).split(':');
      assert.equal(obj.hostName, ip);
      assert.equal(obj.containers[0].awg.port, port);
      assert.equal(JSON.parse(obj.containers[0].awg.last_config).config, r.configs[i]);
    }
  }
});
