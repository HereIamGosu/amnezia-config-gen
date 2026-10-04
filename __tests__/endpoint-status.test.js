const assert = require('node:assert/strict');
const { test } = require('node:test');

const { portState, overallState, isMeasured, STATES, MESSAGES } = require('../src/server/endpointStatus');

const unmeasured = { status: 'candidate', tcp_success_rate_24h: null, last_checked_at: null };
const healthy = { status: 'active', tcp_success_rate_24h: 0.97, last_checked_at: '2026-10-03T19:00:00Z' };
const failing = { status: 'active', tcp_success_rate_24h: 0.1, last_checked_at: '2026-10-03T19:00:00Z' };

test('states are exactly ok, degraded, down, unknown, each with a message', () => {
  assert.deepEqual([...STATES], ['ok', 'degraded', 'down', 'unknown']);
  for (const state of STATES) assert.ok(MESSAGES[state], state);
});

test('an endpoint is measured only with a recorded check and a finite success rate', () => {
  assert.equal(isMeasured(unmeasured), false);
  assert.equal(isMeasured({ ...healthy, last_checked_at: null }), false);
  assert.equal(isMeasured({ ...healthy, tcp_success_rate_24h: null }), false);
  assert.equal(isMeasured({ ...healthy, tcp_success_rate_24h: Number.NaN }), false);
  assert.equal(isMeasured(healthy), true);
  assert.equal(isMeasured(null), false);
});

test('port state: no measurements is unknown, never down', () => {
  assert.equal(portState([]), 'unknown', 'no candidates at all is still not a measured failure');
  assert.equal(portState([unmeasured, unmeasured]), 'unknown');
  assert.equal(portState(undefined), 'unknown');
});

test('port state from measurements: ok, degraded, down', () => {
  assert.equal(portState([healthy, healthy]), 'ok');
  assert.equal(portState([healthy, failing]), 'degraded');
  assert.equal(portState([failing, failing]), 'down');
  assert.equal(portState([healthy, unmeasured]), 'ok', 'unmeasured candidates do not drag a port down');
  assert.equal(portState([failing, unmeasured]), 'down');
  assert.equal(portState([{ ...healthy, tcp_success_rate_24h: 0.5 }]), 'ok', 'threshold is inclusive');
});

test('overall state ignores unknown ports while any port has data', () => {
  assert.equal(overallState(['unknown', 'unknown']), 'unknown');
  assert.equal(overallState([]), 'unknown');
  assert.equal(overallState(['ok', 'unknown', 'unknown']), 'ok');
  assert.equal(overallState(['ok', 'down']), 'degraded');
  assert.equal(overallState(['ok', 'degraded', 'unknown']), 'degraded');
  assert.equal(overallState(['down', 'down', 'unknown']), 'down');
});

const makeRes = () => {
  const out = { headers: {}, statusCode: null, body: null };
  out.setHeader = (k, v) => { out.headers[k] = v; };
  out.status = (code) => { out.statusCode = code; return out; };
  out.json = (body) => { out.body = body; return out; };
  return out;
};

test('/api/status with the built-in endpoint list reports unknown, not degraded', async () => {
  for (const m of ['../api/status', '../api/warp', '../src/server/endpointCache']) delete require.cache[require.resolve(m)];
  const handler = require('../api/status');
  const res = makeRes();
  await handler({ method: 'GET', url: '/api/status', query: {}, headers: {} }, res);
  const body = res.body;
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(body.status, 'unknown');
  assert.equal(body.health_source, 'none');
  assert.equal(body.message, MESSAGES.unknown);
  assert.deepEqual(new Set(Object.values(body.ports)), new Set(['unknown']), 'no port is reported down without data');
  assert.equal(body.candidates['2408'], 11);
  assert.equal(body.candidates['500'], 0);
  assert.equal(body.active_endpoints, 11);
  assert.equal(body.cache_source, 'fallback');
  assert.ok(!Number.isNaN(Date.parse(body.updated_at)));
  assert.doesNotMatch(JSON.stringify(body), /\d+\.\d+\.\d+\.\d+/, 'no endpoint IPs leak');
});

test('/api/status reports measured health once the registry provides it', async () => {
  for (const m of ['../api/status', '../api/warp', '../src/server/endpointCache']) delete require.cache[require.resolve(m)];
  const registry = require('../src/server/endpointCache');
  const original = registry.getTopEndpoints;
  registry.getTopEndpoints = async ({ port }) => (port === 2408 ? [healthy, failing] : []);
  try {
    const handler = require('../api/status');
    const res = makeRes();
    await handler({ method: 'GET', url: '/api/status', query: {}, headers: {} }, res);
    assert.equal(res.body.ports['2408'], 'degraded');
    assert.equal(res.body.ports['500'], 'unknown');
    assert.equal(res.body.status, 'degraded');
    assert.equal(res.body.health_source, 'runtime');
  } finally {
    registry.getTopEndpoints = original;
    delete require.cache[require.resolve('../api/status')];
  }
});

test('/api/status reports unknown when the status cannot be computed', async () => {
  for (const m of ['../api/status', '../api/warp', '../src/server/endpointCache']) delete require.cache[require.resolve(m)];
  const registry = require('../src/server/endpointCache');
  const original = registry.getTopEndpoints;
  registry.getTopEndpoints = async () => { throw new Error('registry unavailable'); };
  try {
    const handler = require('../api/status');
    const res = makeRes();
    await handler({ method: 'GET', url: '/api/status', query: {}, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'unknown');
    assert.deepEqual(new Set(Object.values(res.body.ports)), new Set(['unknown']));
  } finally {
    registry.getTopEndpoints = original;
    delete require.cache[require.resolve('../api/status')];
  }
});

test('main page banner appears only for measured problems and is localized', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  // Баннер на главной рисует status.js (скрипты генератора — __tests__/helpers/frontend-scripts.js).
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'static', 'status.js'), 'utf8');
  const start = script.indexOf('const fetchServiceStatus');
  const body = script.slice(start, script.indexOf('};', start));
  assert.match(body, /data\.status === 'degraded' \|\| data\.status === 'down'/);
  assert.doesNotMatch(body, /unknown/, 'unknown must not raise the banner');
  assert.doesNotMatch(body, /data\.message/, 'the English API message is not shown to users');
  assert.match(body, /status_banner_degraded/);
  assert.match(body, /status_banner_down/);
  assert.match(body, /bannerEl\.dataset\.i18n = key/, 'the banner follows locale loads and language switches');
  for (const lang of ['ru', 'en']) {
    const locale = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'locales', `${lang}.json`), 'utf8'));
    for (const key of ['status_unknown', 'status_pool_unmeasured', 'status_banner_degraded', 'status_banner_down']) {
      assert.ok(locale[key], `${lang}.${key}`);
    }
  }
});
