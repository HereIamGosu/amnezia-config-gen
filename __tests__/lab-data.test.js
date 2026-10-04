// __tests__/lab-data.test.js
// Endpoint Lab: единственный адаптер данных (public/lab/lab-data.js) — запросы, ошибки, Retry-After, опрос.

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Data = require('../public/lab/lab-data.js');

const NOW = Date.parse('2026-10-04T18:30:00Z');
const good = {
  schemaVersion: 1,
  status: 'ok',
  generatedAt: new Date(NOW - 10e3).toISOString(),
  endpoints: [],
};

const response = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const api = { overview: '/api/lab', endpoint: (id, range) => `/api/lab?endpoint=${encodeURIComponent(id)}&range=${range}` };

test('the page reads the same-origin /api/lab; without addresses it answers not-connected and makes no request', async () => {
  assert.equal(Data.LAB_API.overview, '/api/lab');
  assert.equal(Data.LAB_API.endpoint('[2606:4700::1]:2408', '24h'), '/api/lab?endpoint=%5B2606%3A4700%3A%3A1%5D%3A2408&range=24h');
  let calls = 0;
  const source = Data.createLabSource({ fetchImpl: () => { calls += 1; }, api: { overview: null, endpoint: null }, now: () => NOW });
  assert.equal(source.connected, false);
  assert.deepEqual(await source.loadOverview(), { kind: 'not-connected' });
  assert.deepEqual(await source.loadEndpoint('162.159.192.18:2408'), { kind: 'not-connected' });
  assert.equal(calls, 0);
});

test('ok response passes validation; extra request options stay same-origin and uncached', async () => {
  let seen;
  const source = Data.createLabSource({ api, now: () => NOW, fetchImpl: async (url, opts) => { seen = { url, opts }; return response(200, good); } });
  const r = await source.loadOverview();
  assert.equal(r.kind, 'ok');
  assert.equal(r.view.status, 'ok');
  assert.equal(seen.url, '/api/lab');
  assert.equal(seen.opts.cache, 'no-store');
  assert.equal(seen.opts.credentials, 'same-origin');
  assert.equal(seen.opts.method, undefined, 'read-only: GET only');
});

test('HTTP errors, network errors, bad JSON and wrong schema are controlled results', async () => {
  const run = (fetchImpl) => Data.createLabSource({ api, now: () => NOW, fetchImpl }).loadOverview();
  const http = await run(async () => response(503, 'down', { 'Retry-After': '120' }));
  assert.deepEqual(http, { kind: 'error', reason: 'http', status: 503, code: null, retryAfterMs: 120_000 });
  assert.deepEqual(await run(async () => { throw new TypeError('Failed to fetch'); }), { kind: 'error', reason: 'network' });
  assert.deepEqual(await run(async () => response(200, '<html>')), { kind: 'malformed', reason: 'json' });
  assert.deepEqual(await run(async () => response(200, { ...good, schemaVersion: 9 })), { kind: 'malformed', reason: 'schema' });
  assert.deepEqual(await run(async () => response(200, 'x'.repeat(2_000_001))), { kind: 'malformed', reason: 'too-large' });
});

test('endpoint ids are validated before any request is built', async () => {
  let calls = 0;
  const source = Data.createLabSource({ api, now: () => NOW, fetchImpl: async () => { calls += 1; return response(200, {}); } });
  assert.deepEqual(await source.loadEndpoint('../../etc/passwd'), { kind: 'malformed', reason: 'id' });
  assert.equal(calls, 0);
});

test('Retry-After: seconds or HTTP date, clamped', () => {
  assert.equal(Data.parseRetryAfter(null, NOW), null);
  assert.equal(Data.parseRetryAfter('1', NOW), 5_000);
  assert.equal(Data.parseRetryAfter('90', NOW), 90_000);
  assert.equal(Data.parseRetryAfter('99999', NOW), 600_000);
  assert.equal(Data.parseRetryAfter(new Date(NOW + 60e3).toUTCString(), NOW), 60_000);
  assert.equal(Data.parseRetryAfter('soon', NOW), null);
});

test('poll delay: 30 s when healthy, growing backoff on errors, none when not connected', () => {
  assert.equal(Data.POLL_INTERVAL_MS, 30_000);
  assert.equal(Data.nextPollDelay({ kind: 'not-connected' }, 0), null);
  assert.equal(Data.nextPollDelay({ kind: 'ok' }, 0), 30_000);
  assert.equal(Data.nextPollDelay({ kind: 'ok', retryAfterMs: 120_000 }, 0), 120_000);
  assert.equal(Data.nextPollDelay({ kind: 'ok', retryAfterMs: 5_000 }, 0), 30_000, 'the server cannot make us poll faster');
  assert.equal(Data.nextPollDelay({ kind: 'error' }, 1), 30_000);
  assert.equal(Data.nextPollDelay({ kind: 'error' }, 2), 60_000);
  assert.equal(Data.nextPollDelay({ kind: 'error' }, 10), Data.BACKOFF_MAX_MS);
  assert.equal(Data.nextPollDelay({ kind: 'error', retryAfterMs: 200_000 }, 1), 200_000);
});

test('poller: one request at a time, pauses in a hidden tab, refreshes on return', async () => {
  const timers = [];
  const listeners = {};
  const doc = { hidden: false, addEventListener: (n, fn) => { listeners[n] = fn; }, removeEventListener: () => {} };
  let clock = NOW;
  let loads = 0;
  let release;
  const load = () => {
    loads += 1;
    return new Promise((resolve) => { release = () => resolve({ kind: 'ok' }); });
  };
  const results = [];
  const poller = Data.createPoller({
    load,
    onResult: (r) => results.push(r.kind),
    doc,
    now: () => clock,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  poller.start();
  poller.refresh(); // запрос уже идёт — второй не запускается
  assert.equal(loads, 1);
  release();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(results, ['ok']);
  assert.equal(timers.at(-1).ms, 30_000);

  doc.hidden = true;
  listeners.visibilitychange();
  clock += 5 * 60e3;
  doc.hidden = false;
  listeners.visibilitychange(); // давно не обновлялись — сразу запрос
  assert.equal(loads, 2);
  poller.stop();
});

test('fixture source never touches the network', async () => {
  let calls = 0;
  const fixtures = { overview: async () => good, endpoint: async () => ({ __error: 'http', status: 404 }) };
  const source = Data.createLabSource({ fetchImpl: () => { calls += 1; }, fixture: 'healthy', fixtures, now: () => NOW });
  assert.equal(source.connected, true);
  assert.equal((await source.loadOverview()).kind, 'ok');
  assert.deepEqual(await source.loadEndpoint('1.1.1.1:2408'), { kind: 'error', reason: 'http', status: 404 });
  assert.equal(calls, 0);
});

test('API error codes from /api/lab are read from a short JSON body; anything else is ignored', async () => {
  const run = (status, body) => Data.createLabSource({
    api, now: () => NOW, fetchImpl: async () => response(status, body, { 'Retry-After': '60' }),
  }).loadOverview();
  assert.deepEqual(await run(503, { success: false, code: 'lab_not_available' }),
    { kind: 'error', reason: 'http', status: 503, code: 'lab_not_available', retryAfterMs: 60_000 });
  assert.equal((await run(503, { code: 'lab_malformed' })).code, 'lab_malformed');
  assert.equal((await run(503, { code: '<script>' })).code, null);
  assert.equal((await run(502, '<html>bad gateway</html>')).code, null);
  assert.equal((await run(503, `{"code":"lab_not_available","pad":"${'x'.repeat(2000)}"}`)).code, null, 'long bodies are not parsed');
  const detail = await Data.createLabSource({ api, now: () => NOW, fetchImpl: async () => response(404, { code: 'endpoint_not_found' }) })
    .loadEndpoint('162.159.192.18:2408');
  assert.equal(detail.code, 'endpoint_not_found');
});
