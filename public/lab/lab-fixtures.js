// public/lab/lab-fixtures.js
//
// Демо-данные Endpoint Lab для локальной разработки и визуальной проверки: /lab?fixture=<имя>
// на localhost. На боевом домене lab.js этот файл не загружает (LabCore.fixtureFromLocation).
// Фикстуры отдают «сырой» JSON в формате публичного контракта, поэтому проходят ту же проверку,
// что и ответ API. Значения выдуманы; ключей, токенов и внутренних путей здесь нет и быть не должно.

'use strict';

(function initLabFixtures(root) {
  const MIN = 60e3;
  const HOUR = 60 * MIN;
  const iso = (ms) => new Date(ms).toISOString();

  /** Детерминированный ГПСЧ (mulberry32): одинаковая картинка при каждом открытии. */
  const rng = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  const hash = (text) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
  };

  const PORTS = [2408, 500, 1701, 4500, 854, 894, 908, 7559];
  const PREFIXES = ['162.159.192', '162.159.193', '162.159.195', '188.114.96', '188.114.97', '188.114.98', '188.114.99'];
  const SOURCES = ['consumer_official_seed', 'experimental', 'phase_a_verified', 'legacy_builtin', 'cloudflare_one_observation', 'community'];

  // Адреса из макета — первыми, чтобы картинка совпадала с дизайном.
  const PINNED = [
    { ip: '162.159.192.18', port: 2408, state: 'ACTIVE', source: 'consumer_official_seed', ago: 18, session: 'first', https: 'ok', reliability: 0.994 },
    { ip: '162.159.192.54', port: 4500, state: 'ACTIVE', source: 'experimental', ago: 42, session: 'retry', https: 'ok', reliability: 0.978 },
    { ip: '188.114.97.1', port: 2408, state: 'SUSPECT', source: 'phase_a_verified', ago: null, session: 'failed', https: null, reliability: 0.82 },
    { ip: '162.159.193.33', port: 4500, state: 'ACTIVE', source: 'experimental', ago: 128, session: 'first', https: 'ok', reliability: 0.961 },
    { ip: '172.64.33.12', port: 2408, state: 'ACTIVE', source: 'consumer_official_seed', ago: 301, session: 'first', https: 'ok', reliability: 0.947 },
  ];

  const ACTIVE_TTL_SEC = 7 * 60;

  /** Список endpoint'ов с заданным числом в каждом состоянии. */
  const buildEndpoints = (counts, now, seed, { stale = false } = {}) => {
    const rand = rng(seed);
    const list = [];
    const used = new Set();
    const remaining = { ...counts };
    for (const p of PINNED) {
      if (!remaining[p.state]) continue;
      remaining[p.state] -= 1;
      used.add(`${p.ip}:${p.port}`);
      const verifiedAt = p.ago === null ? now - 26 * MIN : now - p.ago * 1000 - (stale ? 11 * MIN : 0);
      list.push({
        ip: p.ip,
        port: p.port,
        state: p.state,
        source: p.source,
        lastVerifiedAt: iso(verifiedAt),
        expiresAt: p.state === 'ACTIVE' ? iso(verifiedAt + ACTIVE_TTL_SEC * 1000) : null,
        session: p.session,
        https: p.https,
        reliability: p.reliability,
      });
    }
    for (const [state, n] of Object.entries(remaining)) {
      for (let i = 0; i < n; i += 1) {
        let ip;
        let port;
        do {
          ip = `${PREFIXES[Math.floor(rand() * PREFIXES.length)]}.${1 + Math.floor(rand() * 254)}`;
          port = PORTS[Math.floor(rand() * PORTS.length)];
        } while (used.has(`${ip}:${port}`));
        used.add(`${ip}:${port}`);
        const fresh = state === 'ACTIVE' || state === 'VERIFIED';
        const age = fresh ? 10e3 + rand() * 6 * MIN : 20 * MIN + rand() * 6 * HOUR;
        const verifiedAt = now - age - (stale ? 11 * MIN : 0);
        const reliability = {
          ACTIVE: 0.9 + rand() * 0.099,
          VERIFIED: 0.8 + rand() * 0.18,
          SUSPECT: 0.6 + rand() * 0.25,
          QUARANTINE: 0.3 + rand() * 0.3,
          DEAD: rand() * 0.2,
        }[state];
        const firstOk = rand() < 0.75;
        list.push({
          ip,
          port,
          state,
          source: SOURCES[Math.floor(rand() * SOURCES.length)],
          lastVerifiedAt: state === 'DEAD' && rand() < 0.5 ? null : iso(verifiedAt),
          expiresAt: state === 'ACTIVE' ? iso(verifiedAt + ACTIVE_TTL_SEC * 1000) : null,
          session: fresh ? (firstOk ? 'first' : 'retry') : 'failed',
          https: fresh ? 'ok' : (state === 'DEAD' ? null : 'fail'),
          reliability: Math.round(reliability * 1000) / 1000,
        });
      }
    }
    return list;
  };

  /** ACTIVE за последние 24 ч, точка раз в 5 минут; заканчивается на текущем значении. */
  const buildActiveHistory = (now, seed, end, { min = 18, max = 31, gapFrom = null } = {}) => {
    const rand = rng(seed);
    const points = [];
    let v = Math.round((min + max) / 2);
    const step = 5 * MIN;
    const n = 288;
    for (let i = n; i >= 0; i -= 1) {
      const at = now - i * step;
      if (gapFrom !== null && now - at < gapFrom) break;
      v = Math.max(min, Math.min(max, v + Math.round((rand() - 0.5) * 3)));
      points.push({ at: iso(at), active: i < 6 ? Math.round(v + (end - v) * (1 - i / 6)) : v });
    }
    return points;
  };

  const buildEvents = (now, kind) => {
    const base = [
      { type: 'restored', endpoint: '162.159.192.18:2408', at: now - 1 * MIN },
      { type: 'discovery', count: 3, at: now - 8 * MIN },
      { type: 'excluded', endpoint: '188.114.97.1:2408', at: now - 13 * MIN },
      { type: 'demoted', endpoint: '162.159.193.33:4500', at: now - 27 * MIN },
      { type: 'promoted', endpoint: '162.159.195.77:500', at: now - 41 * MIN },
      { type: 'suspect', endpoint: '188.114.98.140:1701', at: now - 58 * MIN },
      { type: 'restored', endpoint: '162.159.192.201:854', at: now - 74 * MIN },
      { type: 'discovery', count: 1, at: now - 98 * MIN },
      { type: 'dead', endpoint: '188.114.99.23:908', at: now - 2.4 * HOUR },
      { type: 'promoted', endpoint: '162.159.193.12:2408', at: now - 3.1 * HOUR },
      { type: 'excluded', endpoint: '188.114.96.61:4500', at: now - 4.7 * HOUR },
      { type: 'discovery', count: 5, at: now - 6.2 * HOUR },
      { type: 'restored', endpoint: '188.114.96.61:4500', at: now - 7.9 * HOUR },
      { type: 'demoted', endpoint: '162.159.195.9:894', at: now - 11 * HOUR },
      { type: 'promoted', endpoint: '162.159.195.9:894', at: now - 15 * HOUR },
      { type: 'discovery', count: 2, at: now - 21 * HOUR },
    ];
    if (kind === 'degraded') {
      base.unshift(
        { type: 'excluded', endpoint: '162.159.193.88:2408', at: now - 1.5 * MIN },
        { type: 'suspect', endpoint: '162.159.192.140:500', at: now - 3 * MIN },
      );
    }
    return base.map((e) => ({ ...e, at: iso(e.at) }));
  };

  const overviewBase = (now, { status, counts, sessions, seed, generatedAgo = 20e3, lastSuccessAgo = 14e3, oldestAgo = 3 * MIN + 12e3, stale, historyEnd, kind }) => {
    // Как в контракте: поштучно только ACTIVE, VERIFIED, SUSPECT; QUARANTINE и DEAD — только в счётчиках.
    const byState = { ACTIVE: counts.active, VERIFIED: counts.verified, SUSPECT: counts.suspect };
    return {
      schemaVersion: 1,
      status,
      generatedAt: iso(now - generatedAgo),
      counts,
      freshness: {
        lastSuccessAt: iso(now - lastSuccessAgo),
        oldestActiveVerifiedAt: counts.active ? iso(now - oldestAgo) : null,
        activeTtlSec: ACTIVE_TTL_SEC,
      },
      sessions,
      activeHistory: buildActiveHistory(now, seed, historyEnd ?? counts.active, stale ? { gapFrom: 11 * MIN } : {}),
      events: buildEvents(now - (stale ? 11 * MIN : 0), kind),
      endpoints: buildEndpoints(byState, now, seed, { stale }),
    };
  };

  const OVERVIEWS = {
    healthy: (now) => overviewBase(now, {
      status: 'ok',
      seed: 7,
      counts: { active: 24, verified: 44, suspect: 1, quarantine: 3, dead: 12 },
      sessions: { firstSession: 0.73, retryRescued: 0.25, failed: 0.02 },
    }),
    degraded: (now) => overviewBase(now, {
      status: 'degraded',
      seed: 11,
      kind: 'degraded',
      generatedAgo: 62e3,
      lastSuccessAgo: 64e3,
      counts: { active: 18, verified: 12, suspect: 6, quarantine: 5, dead: 14 },
      sessions: { firstSession: 0.58, retryRescued: 0.27, failed: 0.15 },
    }),
    unavailable: (now) => ({
      ...overviewBase(now, {
        status: 'unavailable',
        seed: 13,
        generatedAgo: 40e3,
        lastSuccessAgo: 26 * MIN,
        stale: true,
        historyEnd: 0,
        counts: { active: 0, verified: 18, suspect: 2, quarantine: 4, dead: 12 },
        sessions: { firstSession: 0, retryRescued: 0, failed: 1 },
      }),
    }),
    stale: (now) => overviewBase(now, {
      status: 'ok',
      seed: 17,
      generatedAgo: 11 * MIN,
      lastSuccessAgo: 11 * MIN,
      oldestAgo: 17 * MIN,
      stale: true,
      counts: { active: 24, verified: 18, suspect: 2, quarantine: 4, dead: 12 },
      sessions: { firstSession: 0.71, retryRescued: 0.26, failed: 0.03 },
    }),
    empty: (now) => overviewBase(now, {
      status: 'ok',
      seed: 19,
      counts: { active: 0, verified: 6, suspect: 3, quarantine: 8, dead: 20 },
      sessions: { firstSession: 0.31, retryRescued: 0.22, failed: 0.47 },
      historyEnd: 0,
    }),
    mixed: (now) => {
      const data = overviewBase(now, {
        status: 'ok',
        seed: 23,
        counts: { active: 9, verified: 6, suspect: 3, quarantine: 3, dead: 4 },
        sessions: { firstSession: 0.69, retryRescued: 0.27, failed: 0.04 },
      });
      data.endpoints.push(
        { ip: '2606:4700:d0::a29f:c001', port: 2408, state: 'ACTIVE', source: 'cloudflare_one_observation', lastVerifiedAt: iso(now - 33e3), expiresAt: iso(now + 6 * MIN), session: 'first', https: 'ok', reliability: 0.991 },
        { ip: '162.159.192.9', port: 1701, state: 'PROBING', source: 'experimental', lastVerifiedAt: null, expiresAt: null, session: null, https: null, reliability: null },
        { ip: '162.159.195.200', port: 894, state: 'DISCOVERED', source: 'community', lastVerifiedAt: null, expiresAt: null, session: null, https: null, reliability: null },
        { ip: '162.159.193.4', port: 500, state: 'ACTIVE', source: 'legacy_builtin', lastVerifiedAt: iso(now - 9 * MIN), expiresAt: iso(now - 2 * MIN), session: 'first', https: 'ok', reliability: 0.93 },
        { ip: '188.114.96.200', port: 2408, state: 'MYSTERY_STATE', source: 'partner_feed', lastVerifiedAt: iso(now - 5 * MIN), expiresAt: null, session: 'first', https: 'ok', reliability: 0.5 },
        // Должны быть отброшены проверкой: неверный IP, порт, дубликат.
        { ip: '999.1.1.1', port: 2408, state: 'ACTIVE' },
        { ip: '162.159.192.77', port: 70000, state: 'ACTIVE' },
        { ip: '162.159.192.18', port: 2408, state: 'DEAD' },
        { ip: '<img src=x onerror=alert(1)>', port: 2408, state: 'ACTIVE' },
      );
      return data;
    },
    partial: (now) => {
      const data = OVERVIEWS.healthy(now);
      data.sessions = { firstSession: 0.9, retryRescued: 0.4, failed: 0.2 };
      delete data.activeHistory;
      data.events = [{ type: 'teleported', endpoint: '1.1.1.1:2408', at: iso(now) }, 'garbage'];
      return data;
    },
    malformed: () => ({ schemaVersion: 1, status: 'great', generatedAt: 12 }),
    error: () => ({ __error: 'http', status: 503 }),
    loading: () => new Promise(() => {}),
  };

  const STATE_SEQUENCE = ['ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE', 'VERIFIED', 'ACTIVE', 'SUSPECT', 'ACTIVE'];

  const RANGE_BUCKETS = { '24h': [48, 30 * MIN], '7d': [56, 3 * HOUR], '30d': [60, 12 * HOUR], all: [60, 12 * HOUR] };

  const endpointDetails = (name, id, range, now) => {
    if (name === 'loading') return new Promise(() => {});
    if (name === 'error') return { __error: 'http', status: 503 };
    const overview = (OVERVIEWS[name] || OVERVIEWS.healthy)(now);
    const item = (overview.endpoints || []).find((ep) => {
      const epId = ep.ip && ep.ip.includes(':') ? `[${ep.ip}]:${ep.port}` : `${ep.ip}:${ep.port}`;
      return epId === id;
    });
    if (!item) return { __error: 'http', status: 404 };
    const rand = rng(hash(id));
    const verified = item.lastVerifiedAt ? Date.parse(item.lastVerifiedAt) : null;
    const ok = item.state === 'ACTIVE' || item.state === 'VERIFIED';
    const check = (offsetSec) => (verified ? { result: ok ? 'ok' : 'fail', at: iso(verified - offsetSec * 1000) } : null);
    const [count, step] = RANGE_BUCKETS[range] || RANGE_BUCKETS.all;
    const buckets = [];
    for (let i = count - 1; i >= 0; i -= 1) {
      const total = 2 + Math.floor(rand() * 7);
      const fail = rand() < (ok ? 0.08 : 0.4) ? 1 + Math.floor(rand() * 2) : 0;
      const retry = Math.floor(rand() * (total - fail) * 0.4);
      buckets.push({ at: iso(now - i * step), first: Math.max(0, total - fail - retry), retry, fail });
    }
    const events = [];
    let t = now - 6 * MIN;
    for (let i = 0; i < 14; i += 1) {
      const roll = rand();
      const result = roll < (ok ? 0.08 : 0.45) ? 'fail' : roll < 0.3 ? 'retry' : 'first';
      events.push({ at: iso(t), result, error: result === 'fail' ? (rand() < 0.7 ? 'handshake_no_response' : 'https_timeout') : null });
      t -= (15 + rand() * 30) * MIN;
    }
    const timeline = [];
    for (let i = 47; i >= 0; i -= 1) {
      const s = ok ? STATE_SEQUENCE[Math.floor(rand() * STATE_SEQUENCE.length)] : (rand() < 0.5 ? 'SUSPECT' : 'QUARANTINE');
      timeline.push({ at: iso(now - i * 30 * MIN), state: i === 0 ? item.state : s });
    }
    const details = {
      schemaVersion: 1,
      endpoint: item,
      checks: { handshake: check(6), tunnel: check(2), https: check(0) },
      stability: { h1: ok ? 0.992 : 0.41, h24: ok ? 0.988 : 0.57, observations: 120 + Math.floor(rand() * 200) },
      timeline,
      lastError: ok ? null : { code: 'handshake_no_response', at: iso(now - 26 * MIN) },
      history: { range, buckets, events },
    };
    if (name === 'mixed' && item.state === 'MYSTERY_STATE') {
      // Строка с разметкой должна показаться как текст, а не выполниться.
      details.lastError = { code: 'odd', message: '<img src=x onerror="window.__labXss=1">', at: iso(now - MIN) };
    }
    if (name === 'partial') delete details.history;
    return details;
  };

  root.LabFixtures = Object.freeze({
    overview: (name, now) => Promise.resolve((OVERVIEWS[name] || OVERVIEWS.healthy)(now)),
    endpoint: (name, id, range, now) => Promise.resolve(endpointDetails(name, id, range, now)),
  });
})(window);
