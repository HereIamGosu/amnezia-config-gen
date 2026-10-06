const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const LiveStatus = require('../public/static/live-status.js');
const { readAppScript, readAllAppScripts } = require('./helpers/frontend-scripts');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// Shape of /api/status with the built-in endpoint list (no runtime health data).
const STATUS = {
  status: 'unknown',
  updated_at: '2026-10-03T18:33:23.808Z',
  active_endpoints: 11,
  ports: { 500: 'unknown', 2408: 'unknown' },
  candidates: { 500: 0, 2408: 11 },
  health_source: 'none',
  cache_source: 'fallback',
};
const HEALTH = {
  services: {
    api: { ok: true, latencyMs: 14 },
    engage: { ok: false, latencyMs: null },
    cidr: { ok: true, latencyMs: 40 },
  },
  checkedAt: '2026-10-03T18:33:07.303Z',
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

const jsonResponse = (body, { status = 200, headers = {} } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (name) => headers[name] ?? null },
  json: async () => body,
});

test('buildSnapshot maps live API payloads to service cards', () => {
  const snap = LiveStatus.buildSnapshot(STATUS, HEALTH);
  assert.equal(snap.checkedAt, '2026-10-03T18:33:07.303Z');
  assert.deepEqual(snap.services.map((s) => [s.key, s.status]), [
    ['warp_api', 'ok'],
    ['warp_engage', 'error'],
    ['cidr_source', 'ok'],
    ['endpoint_pool', 'unknown'],
  ]);
  const pool = snap.services.at(-1);
  assert.equal(pool.activeEndpoints, 11);
  assert.deepEqual(pool.candidatePorts, ['2408']);
  assert.equal(pool.fallback, true);
  assert.equal(pool.measured, false);
  assert.equal(snap.services[1].latencyMs, null);
});

test('buildSnapshot passes on whether Endpoint Lab is published; anything but a boolean is unknown', () => {
  assert.deepEqual(LiveStatus.buildSnapshot({ ...STATUS, lab: { available: true } }, HEALTH).lab, { available: true });
  assert.deepEqual(LiveStatus.buildSnapshot({ ...STATUS, lab: { available: false } }, HEALTH).lab, { available: false });
  for (const lab of [undefined, null, 'yes', {}, { available: 'true' }]) {
    assert.deepEqual(LiveStatus.buildSnapshot({ ...STATUS, lab }, HEALTH).lab, { available: null }, JSON.stringify(lab));
  }
});

test('buildSnapshot omits the CIDR card when the probe is absent and maps down to error', () => {
  const health = { ...HEALTH, services: { api: HEALTH.services.api, engage: HEALTH.services.engage } };
  const snap = LiveStatus.buildSnapshot({ ...STATUS, status: 'down' }, health);
  assert.equal(snap.services.some((s) => s.key === 'cidr_source'), false);
  assert.equal(snap.services.at(-1).status, 'error');
});

test('measured pool states keep their meaning; unknown is a distinct state', () => {
  const measured = { ...STATUS, health_source: 'runtime' };
  assert.equal(LiveStatus.buildSnapshot({ ...measured, status: 'ok' }, HEALTH).services.at(-1).status, 'ok');
  assert.equal(LiveStatus.buildSnapshot({ ...measured, status: 'degraded' }, HEALTH).services.at(-1).status, 'degraded');
  assert.equal(LiveStatus.buildSnapshot({ ...measured, status: 'down' }, HEALTH).services.at(-1).status, 'error');
  const pool = LiveStatus.buildSnapshot({ ...measured, status: 'ok' }, HEALTH).services.at(-1);
  assert.equal(pool.measured, true);
  assert.doesNotMatch(LiveStatus.renderCardsHtml({ checkedAt: HEALTH.checkedAt, services: [pool] }), /не измеряется/);
});

test('buildSnapshot rejects malformed payloads instead of rendering partial data', () => {
  const bad = [
    [null, HEALTH],
    [STATUS, null],
    [{ ...STATUS, status: 'weird' }, HEALTH],
    [{ ...STATUS, updated_at: 'nope' }, HEALTH],
    [STATUS, { ...HEALTH, checkedAt: undefined }],
    [STATUS, { ...HEALTH, services: { api: { ok: 'yes' }, engage: HEALTH.services.engage } }],
    [STATUS, { checkedAt: HEALTH.checkedAt }],
  ];
  for (const [s, h] of bad) {
    assert.throws(() => LiveStatus.buildSnapshot(s, h), (err) => err.kind === 'invalid');
  }
});

test('buildSnapshot rejects stale probe results using server timestamps only', () => {
  const old = { ...HEALTH, checkedAt: '2026-10-03T18:20:00.000Z' }; // 13 min before updated_at
  assert.throws(() => LiveStatus.buildSnapshot(STATUS, old), (err) => err.kind === 'stale');
  const future = { ...HEALTH, checkedAt: '2026-10-03T18:40:00.000Z' };
  assert.throws(() => LiveStatus.buildSnapshot(STATUS, future), (err) => err.kind === 'stale');
  // Probe finishing a few seconds after /api/status answered is normal.
  const slightlyAfter = { ...HEALTH, checkedAt: '2026-10-03T18:33:28.000Z' };
  assert.doesNotThrow(() => LiveStatus.buildSnapshot(STATUS, slightlyAfter));
});

test('fetchJson requests without cache and classifies failures', async () => {
  let seenInit;
  const ok = await LiveStatus.fetchJson(async (url, init) => { seenInit = init; return jsonResponse({ a: 1 }); }, '/x', 1000);
  assert.deepEqual(ok, { a: 1 });
  assert.equal(seenInit.cache, 'no-store');
  assert.ok(seenInit.signal);

  await assert.rejects(
    LiveStatus.fetchJson(async () => jsonResponse({}, { status: 429, headers: { 'Retry-After': '30' } }), '/x', 1000),
    (err) => err.kind === 'rate_limited' && err.retryAfterMs === 30_000,
  );
  await assert.rejects(LiveStatus.fetchJson(async () => jsonResponse({}, { status: 502 }), '/x', 1000), (err) => err.kind === 'http');
  await assert.rejects(LiveStatus.fetchJson(async () => { throw new TypeError('fail'); }, '/x', 1000), (err) => err.kind === 'network');
  await assert.rejects(
    LiveStatus.fetchJson(async () => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => { throw new SyntaxError('bad'); } }), '/x', 1000),
    (err) => err.kind === 'invalid',
  );
});

test('fetchJson aborts a hanging request after the timeout', async () => {
  const hanging = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const started = Date.now();
  await assert.rejects(LiveStatus.fetchJson(hanging, '/x', 50), (err) => err.kind === 'timeout');
  assert.ok(Date.now() - started < 2000);
});

test('loadSnapshot fetches both live endpoints and nothing else', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return jsonResponse(url === '/api/status' ? STATUS : HEALTH);
  };
  const snap = await LiveStatus.loadSnapshot({ fetchImpl });
  assert.deepEqual(urls.sort(), ['/api/healthcheck', '/api/status']);
  assert.equal(snap.services.length, 4);
});

test('parseRetryAfter accepts delta-seconds only', () => {
  assert.equal(LiveStatus.parseRetryAfter('30'), 30_000);
  assert.equal(LiveStatus.parseRetryAfter(null), null);
  assert.equal(LiveStatus.parseRetryAfter('0'), null);
  assert.equal(LiveStatus.parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT'), null);
});

test('renderCardsHtml escapes every interpolated value', () => {
  const snap = LiveStatus.buildSnapshot(STATUS, HEALTH);
  const labels = { ...LiveStatus.DEFAULT_LABELS, names: { ...LiveStatus.DEFAULT_LABELS.names, warp_api: '<img src=x onerror=alert(1)>' } };
  const html = LiveStatus.renderCardsHtml(snap, labels);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /14 мс/);
  assert.match(html, /нет соединения/);
  assert.match(html, /адресов: 11 · порты: 2408/);
  assert.match(html, /data-service="endpoint_pool"[\s\S]*state-icon--unknown[\s\S]*не измеряется/);
  assert.doesNotMatch(html, /Нестабильно|state-icon--degraded/, 'missing telemetry is not shown as a failure');
});

test('the status dialog uses the hero card rows; the Lab row only where the page polls the Lab', () => {
  const snap = LiveStatus.buildSnapshot(STATUS, HEALTH);
  const html = LiveStatus.renderCardsHtml(snap);
  const order = [...html.matchAll(/data-service="([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['generator', 'warp_api', 'warp_engage', 'cidr_source', 'endpoint_pool']);
  for (const name of ['Генератор API', 'Регистрация WARP', 'WARP endpoint', 'Источник CIDR']) assert.match(html, new RegExp(name));
  assert.doesNotMatch(html, /Cloudflare WARP \(engage\)|ОШИБКА|НЕТ ДАННЫХ/, 'old card names and states are gone');

  const withLab = LiveStatus.renderCardsHtml(snap, LiveStatus.DEFAULT_LABELS, { labHref: '/en/lab' });
  const labOrder = [...withLab.matchAll(/data-service="([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(labOrder, ['generator', 'warp_api', 'warp_engage', 'cidr_source', 'lab', 'endpoint_pool']);
  assert.match(withLab, /id="statusModalLabState"/);
  assert.match(withLab, /<a class="status-detail__link" href="\/en\/lab">Открыть Lab<\/a>/);
});

const makeHarness = ({ hidden = false } = {}) => {
  let mono = 0;
  let wall = 1_000_000;
  let nextId = 1;
  const timers = new Map();
  const listeners = new Set();
  const doc = {
    hidden,
    addEventListener: (type, fn) => { if (type === 'visibilitychange') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'visibilitychange') listeners.delete(fn); },
  };
  const winListeners = new Map();
  const win = {
    addEventListener: (type, fn) => { if (!winListeners.has(type)) winListeners.set(type, new Set()); winListeners.get(type).add(fn); },
    removeEventListener: (type, fn) => { winListeners.get(type)?.delete(fn); },
  };
  const events = [];
  return {
    doc,
    win,
    async fire(type) {
      for (const fn of [...(winListeners.get(type) || [])]) fn();
      await flush();
    },
    winListenerCount: () => [...winListeners.values()].reduce((n, set) => n + set.size, 0),
    events,
    timers,
    monoNow: () => mono,
    wallNow: () => wall,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: mono + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    // Advances both clocks, firing due timers in order.
    async advance(ms) {
      const target = mono + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((x, y) => x[1].at - y[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        wall += due[1].at - mono;
        mono = due[1].at;
        due[1].fn();
        await flush();
      }
      wall += target - mono;
      mono = target;
    },
    // Device sleep: the wall clock moves, the monotonic clock and timers do not.
    sleep(ms) { wall += ms; },
    async setHidden(value) {
      doc.hidden = value;
      for (const fn of [...listeners]) fn();
      await flush();
    },
    listenerCount: () => listeners.size,
  };
};

const makePoller = (h, load, opts = {}) => LiveStatus.createPoller({
  load,
  onLoading: () => h.events.push('loading'),
  onData: (v) => h.events.push(`data:${v}`),
  onError: (err, { retryAt }) => h.events.push(`error:${err.kind}:${retryAt == null ? 'none' : retryAt - h.wallNow()}`),
  pollMs: 60_000,
  minGapMs: 15_000,
  staleAfterMs: 120_000,
  doc: h.doc,
  win: h.win,
  monoNow: h.monoNow,
  wallNow: h.wallNow,
  setTimer: h.setTimer,
  clearTimer: h.clearTimer,
  ...opts,
});

test('poller loads on start and polls once per interval while visible', async () => {
  const h = makeHarness();
  let calls = 0;
  const poller = makePoller(h, async () => { calls += 1; return calls; });
  poller.start();
  await flush();
  assert.deepEqual(h.events, ['loading', 'data:1']);
  await h.advance(59_000);
  assert.equal(calls, 1);
  await h.advance(1_000);
  assert.equal(calls, 2);
  await h.advance(600_000);
  assert.equal(calls, 12);
  assert.ok(!h.events.slice(2).includes('loading'), 'a render refreshed every minute never expires');
  poller.stop();
  assert.equal(h.timers.size, 0);
  assert.equal(h.listenerCount(), 0);
  assert.equal(h.winListenerCount(), 0);
});

test('poller makes no requests while the tab is hidden and refreshes when it becomes visible', async () => {
  const h = makeHarness({ hidden: true });
  let calls = 0;
  const poller = makePoller(h, async () => { calls += 1; return calls; });
  poller.start();
  await flush();
  await h.advance(600_000);
  assert.equal(calls, 0);
  assert.equal(h.timers.size, 0);

  await h.setHidden(false);
  assert.equal(calls, 1);

  await h.setHidden(true);
  assert.equal(h.timers.size, 0, 'hidden tab must not keep any timer');
  await h.advance(600_000);
  assert.equal(calls, 1);

  h.events.length = 0;
  await h.setHidden(false);
  assert.deepEqual(h.events, ['loading', 'data:2'], 'stale render is cleared before refreshing');
  poller.stop();
});

test('poller clears a render after device sleep even though the monotonic clock paused', async () => {
  const h = makeHarness();
  let calls = 0;
  const poller = makePoller(h, async () => { calls += 1; return calls; });
  poller.start();
  await flush();
  await h.advance(5_000);
  await h.setHidden(true); // phone locked
  h.sleep(3_600_000);
  h.events.length = 0;
  await h.setHidden(false); // unlocked an hour later, performance.now() moved 0 ms
  assert.deepEqual(h.events, ['loading', 'data:2'], 'old cards are removed and a fresh request is made at once');
  poller.stop();
});

test('poller expires a render when sleep happens without a visibilitychange', async () => {
  const h = makeHarness();
  let calls = 0;
  let release;
  const poller = makePoller(h, () => {
    calls += 1;
    if (calls === 1) return Promise.resolve(1);
    return new Promise((r) => { release = r; });
  });
  poller.start();
  await flush();
  h.sleep(3_600_000); // laptop lid closed, no events
  h.events.length = 0;
  await h.advance(5_000); // first expiry check after wake
  assert.deepEqual(h.events, ['loading']);
  assert.equal(calls, 2, 'refresh starts right after the stale render is cleared');
  release(2);
  await flush();
  assert.deepEqual(h.events, ['loading', 'data:2']);
  poller.stop();
});

test('poller clears a stale render on focus after a wake without visibilitychange', async () => {
  const h = makeHarness();
  let calls = 0;
  const poller = makePoller(h, async () => { calls += 1; return calls; });
  poller.start();
  await flush();
  h.sleep(3_600_000);
  h.events.length = 0;
  await h.fire('focus');
  assert.deepEqual(h.events, ['loading', 'data:2']);
  await h.fire('pageshow');
  assert.equal(calls, 2, 'focus/pageshow respect the minimum gap');
  poller.stop();
});

test('a long Retry-After keeps the error on screen instead of a fake loading state', async () => {
  const h = makeHarness();
  let i = 0;
  const poller = makePoller(h, async () => {
    i += 1;
    if (i === 1) throw new LiveStatus.LiveStatusError('rate_limited', '429', 600_000);
    return 'ok';
  });
  poller.start();
  await flush();
  await h.advance(300_000);
  assert.deepEqual(h.events, ['loading', 'error:rate_limited:600000']);
  h.events.length = 0;
  await h.setHidden(true);
  await h.setHidden(false);
  assert.deepEqual(h.events, [], 'the absolute retry time already on screen is still correct');
  await h.advance(300_000);
  assert.equal(i, 2);
  assert.equal(h.events.at(-1), 'data:ok');
  poller.stop();
});

test('reopening with an error shows loading when a new request starts at once', async () => {
  const h = makeHarness();
  let i = 0;
  let release;
  const poller = makePoller(h, () => {
    i += 1;
    if (i === 1) return new Promise((resolve, reject) => { release = () => reject(new LiveStatus.LiveStatusError('timeout', 't')); });
    return Promise.resolve('ok');
  });
  poller.start();
  await h.advance(8_000);
  release();
  await flush();
  poller.stop();
  await h.advance(8_000); // 16 s since the request started, 8 s since the error
  h.events.length = 0;
  poller.start();
  assert.deepEqual(h.events, ['loading']);
  await flush();
  assert.deepEqual(h.events, ['loading', 'data:ok']);
  poller.stop();
});

test('focus with a fresh render does not add requests', async () => {
  const h = makeHarness();
  let calls = 0;
  const poller = makePoller(h, async () => { calls += 1; return calls; });
  poller.start();
  await flush();
  for (let i = 0; i < 11; i += 1) {
    await h.advance(5_000);
    await h.fire('focus');
  }
  assert.equal(calls, 1, 'still one request in the first 55 s');
  await h.advance(5_000);
  assert.equal(calls, 2);
  poller.stop();
});

test('after a silent wake an overdue retry runs at once instead of a minute later', async () => {
  const h = makeHarness();
  let i = 0;
  let release;
  const poller = makePoller(h, () => {
    i += 1;
    if (i === 1) return Promise.reject(new LiveStatus.LiveStatusError('timeout', 't'));
    return new Promise((r) => { release = r; });
  });
  poller.start();
  await flush();
  await h.advance(1_000);
  h.sleep(3_600_000);
  h.events.length = 0;
  await h.advance(5_000);
  assert.equal(i, 2);
  assert.deepEqual(h.events, ['loading']);
  release('ok');
  await flush();
  assert.equal(h.events.at(-1), 'data:ok');
  poller.stop();
});

test('Retry-After that elapsed in real time during sleep no longer blocks', async () => {
  const h = makeHarness();
  let i = 0;
  const poller = makePoller(h, async () => {
    i += 1;
    if (i === 1) throw new LiveStatus.LiveStatusError('rate_limited', '429', 600_000);
    return 'ok';
  });
  poller.start();
  await flush();
  await h.advance(10_000);
  h.sleep(3_600_000);
  await h.advance(5_000);
  assert.equal(i, 2);
  assert.equal(h.events.at(-1), 'data:ok');
  poller.stop();
});

test('a 429 that arrives after stop() still blocks the next start', async () => {
  const h = makeHarness();
  let i = 0;
  let reject429;
  const poller = makePoller(h, () => {
    i += 1;
    if (i === 1) return new Promise((resolve, reject) => { reject429 = () => reject(new LiveStatus.LiveStatusError('rate_limited', '429', 600_000)); });
    return Promise.resolve('ok');
  });
  poller.start();
  await h.advance(1_000);
  poller.stop();
  await h.advance(1_000);
  reject429();
  await flush();
  await h.advance(14_000);
  poller.start();
  await flush();
  assert.equal(i, 1, 'no request while the server-imposed wait is running');
  assert.equal(h.events.at(-1), 'error:rate_limited:586000', 'the wait is shown, not an endless loading state');
  await h.advance(586_000);
  assert.equal(i, 2);
  poller.stop();
});

test('reopening while the old request runs, then a 429: the wait is shown, not loading', async () => {
  const h = makeHarness();
  let i = 0;
  let reject429;
  const poller = makePoller(h, () => {
    i += 1;
    if (i === 1) return new Promise((resolve, reject) => { reject429 = () => reject(new LiveStatus.LiveStatusError('rate_limited', '429', 600_000)); });
    return Promise.resolve('ok');
  });
  poller.start();
  await h.advance(1_000);
  poller.stop();
  await h.advance(500);
  poller.start(); // request #1 still in flight: loading is truthful
  assert.deepEqual(h.events, ['loading', 'loading']);
  await h.advance(1_500);
  reject429();
  await flush();
  assert.equal(h.events.at(-1), 'error:rate_limited:600000');
  await h.advance(599_000);
  assert.equal(i, 1);
  await h.advance(1_000);
  assert.equal(i, 2);
  assert.equal(h.events.at(-1), 'data:ok');
  poller.stop();
});

test('a shown Retry-After wait recovers after a silent wake (focus or periodic check)', async () => {
  const h = makeHarness();
  let i = 0;
  let reject429;
  const poller = makePoller(h, () => {
    i += 1;
    if (i === 1) return new Promise((resolve, reject) => { reject429 = () => reject(new LiveStatus.LiveStatusError('rate_limited', '429', 600_000)); });
    return Promise.resolve('ok');
  });
  poller.start();
  await h.advance(1_000);
  poller.stop();
  await h.advance(1_000);
  reject429();
  await flush();
  await h.advance(14_000);
  poller.start();
  await flush();
  assert.equal(h.events.at(-1), 'error:rate_limited:586000');
  h.sleep(3_600_000);
  await h.fire('focus');
  assert.equal(i, 2, 'the wait elapsed in real time, so the request goes out on focus');
  assert.equal(h.events.at(-1), 'data:ok');
  poller.stop();
});

test('a result that arrives while the tab is hidden is shown when it becomes visible', async () => {
  const h = makeHarness();
  let release;
  const poller = makePoller(h, () => new Promise((r) => { release = r; }));
  poller.start();
  await h.setHidden(true);
  release('late');
  await flush();
  assert.deepEqual(h.events, ['loading']);
  await h.setHidden(false);
  assert.deepEqual(h.events, ['loading', 'data:late']);
  poller.stop();
});

test('old data on screen is cleared on return even if the newest result is an error', async () => {
  const h = makeHarness();
  let i = 0;
  let fail;
  const poller = makePoller(h, () => {
    i += 1;
    if (i === 1) return Promise.resolve('d0');
    if (i === 2) return new Promise((resolve, reject) => { fail = () => reject(new LiveStatus.LiveStatusError('timeout', 't')); });
    return new Promise(() => {});
  });
  poller.start();
  await flush();
  await h.advance(60_000); // request #2 starts
  await h.setHidden(true);
  fail(); // fails while hidden: nothing rendered
  await flush();
  await h.advance(3_600_000);
  h.events.length = 0;
  await h.setHidden(false);
  assert.deepEqual(h.events, ['loading'], 'hour-old data is removed at once, request #3 in flight');
  poller.stop();
});

test('newer data that arrived while hidden replaces the older data on return', async () => {
  const h = makeHarness();
  let i = 0;
  let release;
  const poller = makePoller(h, () => {
    i += 1;
    if (i === 1) return Promise.resolve('d0');
    return new Promise((r) => { release = r; });
  });
  poller.start();
  await flush();
  await h.advance(60_000);
  await h.setHidden(true);
  release('d1');
  await flush();
  await h.advance(2_000);
  h.events.length = 0;
  await h.setHidden(false);
  assert.deepEqual(h.events, ['data:d1']);
  poller.stop();
});

test('start() in a hidden tab renders nothing until the tab is shown', async () => {
  const h = makeHarness({ hidden: true });
  const poller = makePoller(h, async () => 'ok');
  poller.start();
  await flush();
  assert.deepEqual(h.events, []);
  await h.setHidden(false);
  assert.deepEqual(h.events, ['loading', 'data:ok']);
  poller.stop();
});

test('poller enforces a minimum gap on rapid tab switching', async () => {
  const h = makeHarness();
  let calls = 0;
  const poller = makePoller(h, async () => { calls += 1; return calls; });
  poller.start();
  await flush();
  for (let i = 0; i < 10; i += 1) {
    await h.setHidden(true);
    await h.setHidden(false);
  }
  assert.equal(calls, 1);
  await h.advance(15_000);
  assert.equal(calls, 2);
  poller.stop();
});

test('poller replaces data with an error state and honours Retry-After on 429', async () => {
  const h = makeHarness();
  const results = [
    async () => 'ok',
    async () => { throw new LiveStatus.LiveStatusError('rate_limited', '429', 180_000); },
    async () => 'again',
  ];
  let i = 0;
  const poller = makePoller(h, () => results[i++]());
  poller.start();
  await flush();
  await h.advance(60_000);
  assert.deepEqual(h.events, ['loading', 'data:ok', 'error:rate_limited:180000']);
  await h.advance(100_000);
  assert.equal(i, 2, 'no request before Retry-After elapses');
  h.events.length = 0;
  await h.setHidden(true);
  await h.setHidden(false);
  assert.equal(i, 2, 'visibility change does not bypass the rate-limit backoff');
  assert.deepEqual(h.events, [], 'the absolute retry time already on screen is still correct');
  await h.advance(80_000);
  assert.equal(i, 3);
  assert.equal(h.events.at(-1), 'data:again');
  poller.stop();
});

test('poller retries a failed request after the poll interval', async () => {
  const h = makeHarness();
  let i = 0;
  const poller = makePoller(h, async () => {
    i += 1;
    if (i === 1) throw new LiveStatus.LiveStatusError('timeout', 't');
    return 'ok';
  });
  poller.start();
  await flush();
  assert.deepEqual(h.events, ['loading', 'error:timeout:60000']);
  await h.advance(60_000);
  assert.equal(h.events.at(-1), 'data:ok');
  poller.stop();
});

test('poller drops results of a request started before stop()', async () => {
  const h = makeHarness();
  let resolve;
  const poller = makePoller(h, () => new Promise((r) => { resolve = r; }));
  poller.start();
  poller.stop();
  resolve('late');
  await flush();
  assert.deepEqual(h.events, ['loading']);
  assert.equal(h.timers.size, 0);
});

test('reopening within the minimum gap replays the last result without a new request', async () => {
  const h = makeHarness();
  let calls = 0;
  const poller = makePoller(h, async () => { calls += 1; return calls; });
  poller.start();
  await flush();
  poller.stop();
  await h.advance(5_000);
  poller.start();
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(h.events, ['loading', 'data:1', 'data:1']);
  await h.advance(10_000);
  assert.equal(calls, 2);
  poller.stop();
});

test('reopening after the minimum gap clears the old render and fetches again', async () => {
  const h = makeHarness();
  let calls = 0;
  const poller = makePoller(h, async () => { calls += 1; return calls; });
  poller.start();
  await flush();
  poller.stop();
  await h.advance(20_000);
  poller.start();
  await flush();
  assert.deepEqual(h.events, ['loading', 'data:1', 'loading', 'data:2']);
  poller.stop();
});

test('status UI uses the live API and no committed or GitHub-hosted snapshot', () => {
  // Опрос статуса живёт в status.js; запрет снимков проверяется во всех скриптах генератора.
  const statusScript = readAppScript('status.js');
  const statusPage = read('public/status.html');
  // Скрипт status.html вынесен из inline (CSP без 'unsafe-inline') — запреты действуют и на него.
  const statusPageScript = read('public/static/status-page.js');
  const html = read('public/index.html');
  assert.match(statusPage, /static\/status-page\.js/);
  assert.match(statusPageScript, /LiveStatus\.createPoller/, 'status.html polls the live API');
  for (const source of [readAllAppScripts(), statusPage, statusPageScript]) {
    assert.doesNotMatch(source, /status\.json/);
    assert.doesNotMatch(source, /raw\.githubusercontent\.com/);
    assert.doesNotMatch(source, /healthcheck-snapshots/);
  }
  assert.match(statusPage, /static\/live-status\.js/);
  assert.match(statusScript, /LiveStatus\.createPoller/);
  assert.match(statusScript, /statusPoller\.stop\(\)/);
  assert.ok(html.indexOf('static/live-status.js') < html.indexOf('static/status.js'));
  assert.ok(html.indexOf('static/live-status.js') < html.indexOf('static/script.js'));
  assert.match(html, /<div id="statusModalContent" class="status-loading-msg">/, 'i18n must not overwrite a rendered status');
});

test('status API handlers forbid caching and the healthcheck probes the CIDR source', async () => {
  const healthSrc = read('api/healthcheck.js');
  assert.match(healthSrc, /iplist\.opencck\.org/);
  for (const file of ['api/status.js', 'api/healthcheck.js']) {
    assert.match(read(file), /setHeader\('Cache-Control', 'no-store'\)/, file);
  }
  const vercel = JSON.parse(read('vercel.json'));
  const apiRule = vercel.headers.find((rule) => rule.source === '/api/(.*)');
  assert.ok(apiRule.headers.some((h) => h.key === 'Cache-Control' && h.value === 'no-store'));
});

test('RU and EN locales define the live status strings', () => {
  const ru = JSON.parse(read('public/locales/ru.json'));
  const en = JSON.parse(read('public/locales/en.json'));
  for (const key of ['status_unavailable', 'status_retry_at', 'status_reason_timeout', 'status_reason_rate_limited',
    'status_reason_other', 'status_auto_refresh', 'status_pool_name', 'status_pool_detail', 'status_latency', 'status_unreachable']) {
    assert.ok(ru[key], `ru.${key}`);
    assert.ok(en[key], `en.${key}`);
  }
  assert.equal(ru.status_not_yet, undefined, 'GitHub Actions snapshot text must be gone');
});

test('the committed status snapshot and its serving rules are gone', () => {
  assert.equal(fs.existsSync(path.join(root, 'public', 'status.json')), false);
  const vercel = JSON.parse(read('vercel.json'));
  assert.equal(vercel.headers.some((rule) => rule.source === '/status.json'), false);
  const csp = vercel.headers.flatMap((rule) => rule.headers).find((h) => h.key === 'Content-Security-Policy').value;
  assert.doesNotMatch(csp, /raw\.githubusercontent\.com/, 'no browser code fetches GitHub snapshots any more');
  assert.match(csp, /connect-src 'self'/);
});
