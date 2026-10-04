// __tests__/lab-core.test.js
// Endpoint Lab: проверка недоверенных данных, общее состояние, форматирование и список — public/lab/lab-core.js.

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Core = require('../public/lab/lab-core.js');
const ru = require('../public/locales/ru.json');
const en = require('../public/locales/en.json');

const NOW = Date.parse('2026-10-04T18:30:00Z');
const iso = (ms) => new Date(ms).toISOString();
const tRu = (key) => (ru[key] !== undefined ? ru[key] : key);
const tEn = (key) => (en[key] !== undefined ? en[key] : key);

const endpoint = (over = {}) => ({
  ip: '162.159.192.18',
  port: 2408,
  state: 'ACTIVE',
  source: 'consumer_official_seed',
  lastVerifiedAt: iso(NOW - 18e3),
  expiresAt: iso(NOW + 6 * 60e3),
  session: 'first',
  https: 'ok',
  reliability: 0.994,
  ...over,
});

const overview = (over = {}) => ({
  schemaVersion: 1,
  status: 'ok',
  generatedAt: iso(NOW - 20e3),
  counts: { active: 1, verified: 2, suspect: 0, quarantine: 0, dead: 0 },
  freshness: { lastSuccessAt: iso(NOW - 14e3), oldestActiveVerifiedAt: iso(NOW - 120e3), activeTtlSec: 420 },
  sessions: { firstSession: 0.73, retryRescued: 0.25, failed: 0.02 },
  activeHistory: [{ at: iso(NOW - 60e3), active: 1 }],
  events: [{ type: 'restored', endpoint: '162.159.192.18:2408', at: iso(NOW - 60e3) }],
  endpoints: [endpoint()],
  ...over,
});

const norm = (raw) => Core.normalizeOverview(raw, NOW);

test('valid overview becomes a view model without issues', () => {
  const r = norm(overview());
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
  assert.equal(r.view.status, 'ok');
  assert.equal(r.view.endpoints[0].id, '162.159.192.18:2408');
  assert.equal(r.view.sessions.finalSuccess, 0.98);
});

test('malformed top level is rejected, not rendered', () => {
  for (const raw of [null, 'oops', [], 42, overview({ schemaVersion: 2 }), overview({ status: 'great' }), overview({ generatedAt: 'yesterday' }), overview({ generatedAt: 12 })]) {
    assert.equal(norm(raw).ok, false, JSON.stringify(raw));
  }
  assert.equal(norm(overview({ status: 'DEGRADED' })).view.status, 'degraded', 'status enum is case-insensitive');
});

test('broken sections become null (partial data) and are reported', () => {
  const r = norm(overview({
    counts: { active: -1, verified: 2, suspect: 0, quarantine: 0, dead: 0 },
    sessions: { firstSession: 0.9, retryRescued: 0.4, failed: 0.2 },
    freshness: 'soon',
    activeHistory: undefined,
  }));
  assert.equal(r.ok, true);
  assert.equal(r.view.counts, null);
  assert.equal(r.view.sessions, null, 'fractions that do not add up to 1 are refused');
  assert.equal(r.view.freshness, null);
  assert.equal(r.view.activeHistory, null);
  assert.ok(r.issues.includes('counts') && r.issues.includes('sessions') && r.issues.includes('activeHistory:missing'));
});

test('endpoint items: invalid dropped, duplicates dropped, states normalized, list bounded', () => {
  const r = norm(overview({
    endpoints: [
      endpoint(),
      endpoint({ state: 'DEAD' }), // дубликат id
      endpoint({ ip: '999.1.1.1' }),
      endpoint({ ip: '<img src=x onerror=alert(1)>' }),
      endpoint({ ip: '162.159.192.77', port: 70000 }),
      endpoint({ ip: '162.159.192.78', port: 2408.5 }),
      endpoint({ ip: '162.159.192.9', state: 'probing' }),
      endpoint({ ip: '162.159.192.10', state: 'teleporting', source: 'partner_feed', reliability: 1.7, session: 'maybe', https: 'yes' }),
      endpoint({ ip: '2606:4700:D0::A29F:C001' }),
    ],
  }));
  const list = r.view.endpoints;
  assert.deepEqual(list.map((e) => e.id), ['162.159.192.18:2408', '162.159.192.9:2408', '162.159.192.10:2408', '[2606:4700:d0::a29f:c001]:2408']);
  assert.equal(list[1].state, 'CHECKING', 'transient backend states are shown as CHECKING');
  assert.equal(list[2].state, 'UNKNOWN');
  assert.equal(list[2].source, 'other');
  assert.equal(list[2].reliability, null, 'percentages outside 0..1 are refused');
  assert.equal(list[2].session, null);
  assert.equal(list[2].https, null);
  assert.ok(r.issues.includes('endpoints:dropped:5'));

  const many = Array.from({ length: 700 }, (_, i) => endpoint({ ip: `10.0.${Math.floor(i / 250)}.${i % 250}` }));
  assert.equal(norm(overview({ endpoints: many })).view.endpoints.length, Core.LIMITS.endpoints);
});

test('timestamps: unparseable or from the future are refused', () => {
  assert.equal(Core.parseTime('nope', NOW), null);
  assert.equal(Core.parseTime(iso(NOW + 60 * 60e3), NOW), null);
  assert.equal(Core.parseTime(iso(NOW + 60e3), NOW), NOW, 'small clock skew is clamped to now');
  assert.equal(Core.parseTime(12345, NOW), null);
});

test('server text is cleaned of control and bidi characters and truncated', () => {
  const nasty = ['a', String.fromCharCode(0), 'b', String.fromCharCode(0x202e), 'c', String.fromCharCode(10), 'd'].join('');
  assert.equal(Core.cleanText(nasty), 'a b c d');
  assert.equal(Core.cleanText('x'.repeat(500)).length, Core.LIMITS.text);
  assert.equal(Core.cleanText(42), null);
});

test('Lab state: unavailable > stale > empty > degraded > ok', () => {
  const v = (raw) => norm(raw).view;
  assert.equal(Core.deriveLabState(null, NOW), 'nodata');
  assert.equal(Core.deriveLabState(v(overview()), NOW), 'ok');
  assert.equal(Core.deriveLabState(v(overview({ status: 'degraded' })), NOW), 'degraded');
  assert.equal(Core.deriveLabState(v(overview({ status: 'unavailable', generatedAt: iso(NOW - 3600e3) })), NOW), 'unavailable');
  assert.equal(Core.deriveLabState(v(overview({ generatedAt: iso(NOW - 11 * 60e3) })), NOW), 'stale', 'old snapshot');
  assert.equal(Core.deriveLabState(v(overview({
    freshness: { lastSuccessAt: iso(NOW - 11 * 60e3), oldestActiveVerifiedAt: null, activeTtlSec: 420 },
  })), NOW), 'stale', 'last success older than the ACTIVE TTL');
  assert.equal(Core.deriveLabState(v(overview({ endpoints: [endpoint({ state: 'VERIFIED' })] })), NOW), 'empty');
  assert.equal(Core.deriveLabState(v(overview({ endpoints: [endpoint({ expiresAt: iso(NOW - 1000) })] })), NOW), 'empty', 'expired ACTIVE is not fresh');
  assert.equal(Core.deriveLabState(v(overview({ status: 'degraded', endpoints: [] , counts: { active: 0, verified: 1, suspect: 0, quarantine: 0, dead: 3 } })), NOW), 'empty');
});

test('one DEAD endpoint does not make the Lab unavailable', () => {
  const view = norm(overview({ endpoints: [endpoint(), endpoint({ ip: '1.1.1.1', state: 'DEAD' })] })).view;
  assert.equal(Core.deriveLabState(view, NOW), 'ok');
});

test('ACTIVE and VERIFIED stay distinct; expired ACTIVE is shown as EXPIRED', () => {
  const [active, verified, expired] = norm(overview({
    endpoints: [endpoint(), endpoint({ ip: '1.1.1.2', state: 'VERIFIED' }), endpoint({ ip: '1.1.1.3', expiresAt: iso(NOW - 5e3) })],
  })).view.endpoints;
  assert.equal(Core.displayState(active, NOW), 'ACTIVE');
  assert.equal(Core.displayState(verified, NOW), 'VERIFIED');
  assert.equal(Core.displayState(expired, NOW), 'EXPIRED');
  assert.notEqual(ru.lab_state_ACTIVE, ru.lab_state_VERIFIED);
  assert.notEqual(en.lab_state_ACTIVE, en.lab_state_VERIFIED);
});

test('relative time formatting', () => {
  assert.equal(Core.formatAgo(2e3, tRu), 'только что');
  assert.equal(Core.formatAgo(38e3, tRu), '38 сек. назад');
  assert.equal(Core.formatAgo(2 * 60e3 + 5e3, tRu), '2 мин. назад');
  assert.equal(Core.formatAgo((14 * 60 + 27) * 60e3, tRu), '14 ч 27 мин. назад');
  assert.equal(Core.formatAgo(3 * 3600e3, tRu), '3 ч назад');
  assert.equal(Core.formatAgo(50 * 3600e3, tRu), '2 дн. назад');
  assert.equal(Core.formatAgo(-5e3, tRu), 'только что', 'clock skew never shows negative age');
  assert.equal(Core.formatAgo(38e3, tEn), '38 s ago');
  assert.equal(Core.formatLeft((6 * 60 + 42) * 1e3, tRu), '6 мин 42 сек.');
  assert.equal(Core.formatLeft(-1, tRu), 'истёк');
  assert.equal(Core.formatSpan(420, tRu), '7 мин');
  assert.equal(Core.formatSpan(86400, tEn), '24 h');
});

test('percent formatting', () => {
  assert.equal(Core.formatPercent(0.982, 'ru'), '98%');
  assert.equal(Core.formatPercent(0.994, 'ru', 1), '99,4%');
  assert.equal(Core.formatPercent(0.994, 'en', 1), '99.4%');
  assert.equal(Core.formatPercent(0.9996, 'ru'), '99%', 'failures never round up to 100%');
  assert.equal(Core.formatPercent(1, 'ru'), '100%');
  assert.equal(Core.formatPercent(null, 'ru'), '—');
  assert.equal(Core.formatPercent(1.5, 'ru'), '—');
  assert.equal(Core.formatPercent(Number.NaN, 'ru'), '—');
});

test('Russian plural forms', () => {
  const forms = { one: 'one', few: 'few', many: 'many', other: 'other' };
  assert.equal(Core.plural('ru', 1, forms), 'one');
  assert.equal(Core.plural('ru', 3, forms), 'few');
  assert.equal(Core.plural('ru', 5, forms), 'many');
  assert.equal(Core.plural('en', 3, forms), 'other');
});

test('filters: search, state (ACTIVE includes expired), port, source', () => {
  const list = norm(overview({
    endpoints: [
      endpoint(),
      endpoint({ ip: '162.159.193.33', port: 4500, source: 'experimental', state: 'VERIFIED' }),
      endpoint({ ip: '188.114.97.1', state: 'ACTIVE', expiresAt: iso(NOW - 1) }),
    ],
  })).view.endpoints;
  const ids = (f) => Core.filterEndpoints(list, { query: '', state: 'all', port: 'all', source: 'all', ...f }, NOW).map((e) => e.id);
  assert.deepEqual(ids({ query: '193.33' }), ['162.159.193.33:4500']);
  assert.deepEqual(ids({ query: ':4500' }), ['162.159.193.33:4500']);
  assert.deepEqual(ids({ state: 'ACTIVE' }), ['162.159.192.18:2408', '188.114.97.1:2408']);
  assert.deepEqual(ids({ port: '2408' }), ['162.159.192.18:2408', '188.114.97.1:2408']);
  assert.deepEqual(ids({ source: 'experimental' }), ['162.159.193.33:4500']);
});

test('default order is pinned: refreshed data does not reshuffle rows; new rows go last', () => {
  const order = new Map();
  const a = { id: 'a', ip: '1.1.1.1', family: 4, port: 1, state: 'ACTIVE', reliability: 0.9 };
  const b = { id: 'b', ip: '1.1.1.2', family: 4, port: 1, state: 'VERIFIED', reliability: 0.99 };
  assert.deepEqual(Core.sortEndpoints([b, a], null, order).map((e) => e.id), ['a', 'b']);
  const a2 = { ...a, state: 'DEAD' };
  const c = { id: 'c', ip: '1.1.1.0', family: 4, port: 1, state: 'ACTIVE', reliability: 1 };
  assert.deepEqual(Core.sortEndpoints([c, b, a2], null, order).map((e) => e.id), ['a', 'b', 'c'], 'state change keeps the row in place');
  assert.deepEqual(Core.sortEndpoints([c, b, a2], { key: 'reliability', dir: 'desc' }, order).map((e) => e.id), ['c', 'b', 'a']);
  assert.deepEqual(Core.sortEndpoints([c, b, a2], { key: 'endpoint', dir: 'asc' }, order).map((e) => e.id), ['c', 'a', 'b']);
});

test('endpoint ids parse IPv4 and bracketed IPv6 only', () => {
  assert.deepEqual(Core.parseEndpointId('162.159.192.18:2408'), { ip: '162.159.192.18', family: 4, port: 2408, id: '162.159.192.18:2408' });
  assert.equal(Core.parseEndpointId('[2606:4700::1]:500').id, '[2606:4700::1]:500');
  for (const bad of ['162.159.192.18', '162.159.192.18:0', '162.159.192.18:65536', 'evil.com:443', '[zz::1]:5', '<b>:1']) {
    assert.equal(Core.parseEndpointId(bad), null, bad);
  }
});

test('fixtures are allowed only on localhost and only by known name', () => {
  assert.equal(Core.fixtureFromLocation('?fixture=healthy', 'localhost'), 'healthy');
  assert.equal(Core.fixtureFromLocation('?fixture=stale', '127.0.0.1'), 'stale');
  assert.equal(Core.fixtureFromLocation('?fixture=empty', 'lab.localhost'), 'empty');
  assert.equal(Core.fixtureFromLocation('?fixture=healthy', 'awgconfig.com'), null);
  assert.equal(Core.fixtureFromLocation('?fixture=healthy', 'localhost.awgconfig.com'), null);
  assert.equal(Core.fixtureFromLocation('?fixture=healthy', '203.0.113.7'), null);
  assert.equal(Core.fixtureFromLocation('?fixture=../../etc', 'localhost'), null);
  for (const name of ['healthy', 'degraded', 'unavailable', 'stale', 'empty', 'mixed']) assert.ok(Core.FIXTURE_NAMES.includes(name));
});

test('coverage: active-only marks the compatibility list, anything else reads as full', () => {
  assert.equal(norm(overview()).view.coverage, 'full');
  assert.equal(norm(overview({ coverage: 'active-only' })).view.coverage, 'active-only');
  assert.equal(norm(overview({ coverage: 'everything' })).view.coverage, 'full');
});

test('details: a missing lastError is unknown, null means no error', () => {
  const base = { schemaVersion: 1, endpoint: endpoint() };
  const unknown = Core.normalizeEndpointDetails(base, NOW).view;
  assert.equal(unknown.lastErrorKnown, false);
  const none = Core.normalizeEndpointDetails({ ...base, lastError: null }, NOW).view;
  assert.deepEqual([none.lastErrorKnown, none.lastError], [true, null]);
  const coded = Core.normalizeEndpointDetails({ ...base, lastError: { code: 'traffic_failed', at: iso(NOW - 5e3) } }, NOW).view;
  assert.deepEqual(coded.lastError, { code: 'traffic_failed', message: null, at: NOW - 5e3 });
});
