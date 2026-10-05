// src/server/labPublic.js
// Endpoint Lab public data for the website (/api/lab): a thin, read-only transport of files the Lab host
// exports into its secret-free public directory. Node never reads lab.db, keys or the Lab's private state.
//
//   full mode:           web-overview.json + web-endpoints/<sha256(id)[:32]>.json   (Lab exporter, contract v1)
//   compatibility mode:  active-pool.json (schema 2) + lab-status.json (schema 1) → a partial overview with
//                        what these files prove: status, freshness, the fresh ACTIVE list. Counts and sessions
//                        are null (the operational counters have another meaning); no history, no events.
//                        coverage: "active-only".
//
// Every file is untrusted: size-checked before parsing, validated, and re-projected onto the browser contract
// (only known keys leave this module). What the projection removes as invalid is listed in `partial`, so the
// page can say that part of the data failed validation. Contract: docs/specs/endpoint-lab-frontend.md.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { validateLabSnapshot } = require('./endpointProvider');

const SCHEMA_VERSION = 1;
const STATUS_SCHEMA_VERSION = 1;
const FILES = Object.freeze({
  overview: 'web-overview.json',
  detailsDir: 'web-endpoints',
  pool: 'active-pool.json',
  status: 'lab-status.json',
});
const MAX_BYTES = Object.freeze({
  overview: 2 * 1024 * 1024,
  detail: 256 * 1024,
  pool: 64 * 1024,
  status: 256 * 1024,
});
const LIMITS = Object.freeze({ endpoints: 500, events: 100, activeHistory: 1500, timeline: 96, buckets: 120, detailEvents: 100 });
const STATUSES = ['ok', 'degraded', 'unavailable'];
const STATES = ['ACTIVE', 'VERIFIED', 'SUSPECT', 'QUARANTINE', 'DEAD', 'DISCOVERED', 'CHECKING'];
// Listed one by one; the other states are public only as counts and as transitions in the event feed.
const PUBLIC_STATES = ['ACTIVE', 'VERIFIED', 'SUSPECT'];
// The exporter's public error codes (endpoint_lab.WEB_ERROR_CODES); anything else becomes "unknown".
const ERROR_CODES = ['timeout', 'handshake_no_response', 'handshake_invalid', 'dns_failed', 'https_timeout',
  'https_tls_failed', 'traffic_failed', 'targets_unreachable', 'unknown'];
const EVENT_TYPES = ['restored', 'promoted', 'discovery', 'suspect', 'excluded', 'demoted', 'dead'];
const SESSIONS = ['first', 'retry', 'failed'];
const CHECK_RESULTS = ['ok', 'fail'];
const HISTORY_RESULTS = ['first', 'retry', 'fail'];
const RANGES = { all: null, '24h': 24 * 3600e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };
// Bucket sets the exporter writes; "all" uses the longest one (observations are kept 14 days on the Lab).
const RANGE_BUCKETS = { all: '30d', '24h': '24h', '7d': '7d', '30d': '30d' };
const NEGATIVE_SOURCE = 'negative_control';
const TOKEN_RE = /^[a-z][a-z0-9_]{0,39}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const FUTURE_SKEW_MS = 5 * 60e3;
const RETRY_AFTER_S = 60;

class LabDataError extends Error {
  /** @param {'lab_not_available'|'lab_malformed'} code */
  constructor(code, reason) {
    super(reason);
    this.code = code;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isFraction = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const isIso = (v) => typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v));

// RFC 5737 TEST-NET-1 is the Lab's negative control: never public, whatever a file says.
const isNegativeControlIp = (ip) => net.isIPv4(ip) && ip.startsWith('192.0.2.');

/** "1.2.3.4:2408" / "[2606:4700::1]:2408" → canonical id, or null. Never used as a path. */
const canonicalEndpointId = (value) => {
  if (typeof value !== 'string' || value.length > 60) return null;
  let m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(value);
  let ip;
  if (m && net.isIPv4(m[1])) ip = m[1];
  else {
    m = /^\[([0-9a-fA-F:.]{2,45})\]:(\d{1,5})$/.exec(value);
    if (!m || !net.isIPv6(m[1])) return null;
    // Canonical (compressed, lowercase) form: "2606:4700:0:0::1" and "2606:4700::1" are one endpoint.
    ip = new URL(`http://[${m[1]}]/`).hostname.slice(1, -1);
  }
  const port = Number(m[2]);
  if (!isInt(port, 1, 65535)) return null;
  return net.isIPv6(ip) ? `[${ip}]:${port}` : `${ip}:${port}`;
};

const endpointIdOf = (ip, port) => (net.isIPv6(ip) ? `[${ip}]:${port}` : `${ip}:${port}`);

/** Same naming as the Lab exporter: sha256(endpoint_id)[:32].json — the request string never builds a path. */
const detailFileName = (endpointId) => `${crypto.createHash('sha256').update(endpointId, 'ascii').digest('hex').slice(0, 32)}.json`;

// ── File access ───────────────────────────────────────────────

const cache = new Map();

/** Parsed JSON of one public file, size-checked first; { missing: true } when absent. Cached by mtime+size. */
const readJson = (file, maxBytes) => {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { missing: true };
  }
  if (!st.isFile()) return { missing: true };
  if (st.size > maxBytes) throw new LabDataError('lab_malformed', 'file too large');
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return { doc: hit.doc };
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return { missing: true };
  }
  if (buf.length > maxBytes) throw new LabDataError('lab_malformed', 'file too large');
  let doc;
  try {
    doc = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new LabDataError('lab_malformed', 'not JSON');
  }
  if (cache.size > 64) cache.clear();
  cache.set(file, { key, doc });
  return { doc };
};

// ── Projection onto the browser contract ──────────────────────

/** Sections where the projection removed something invalid: the response's `partial` list. */
const partialSet = () => {
  const set = new Set();
  return { mark: (section) => () => set.add(section), list: () => [...set].sort() };
};

/** Optional field: absent or null stays null; a present value must pass `ok`, otherwise it is dropped and reported. */
const opt = (v, ok, bad) => {
  if (v === undefined || v === null) return null;
  if (ok(v)) return v;
  bad();
  return null;
};

const isToken = (v) => typeof v === 'string' && TOKEN_RE.test(v);
const publicErrorCode = (v) => (ERROR_CODES.includes(v) ? v : 'unknown');

/**
 * One endpoint item, or null when it is dropped. Policy drops are silent (the negative control, states that are
 * public only as counts); an invalid item or field calls bad().
 */
const projectEndpoint = (e, bad) => {
  if (!isObject(e) || typeof e.ip !== 'string' || !(net.isIPv4(e.ip) || net.isIPv6(e.ip)) || !isInt(e.port, 1, 65535)) {
    bad();
    return null;
  }
  if (isNegativeControlIp(e.ip) || e.source === NEGATIVE_SOURCE) return null;
  if (!STATES.includes(e.state)) {
    bad();
    return null;
  }
  if (!PUBLIC_STATES.includes(e.state)) return null;
  return {
    ip: e.ip,
    port: e.port,
    state: e.state,
    source: opt(e.source, isToken, bad),
    lastVerifiedAt: opt(e.lastVerifiedAt, isIso, bad),
    expiresAt: opt(e.expiresAt, isIso, bad),
    session: opt(e.session, (v) => SESSIONS.includes(v), bad),
    https: opt(e.https, (v) => CHECK_RESULTS.includes(v), bad),
    reliability: opt(e.reliability, isFraction, bad),
  };
};

const bounded = (list, limit, what) => {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list) || list.length > limit) throw new LabDataError('lab_malformed', `${what} not a bounded array`);
  return list;
};

const projectCounts = (c, bad) => {
  if (c === undefined || c === null) return null;
  const keys = ['active', 'verified', 'suspect', 'quarantine', 'dead'];
  if (isObject(c) && keys.every((k) => isInt(c[k], 0, 100000))) return Object.fromEntries(keys.map((k) => [k, c[k]]));
  bad();
  return null;
};

const projectFreshness = (f, bad) => {
  if (f === undefined || f === null) return null;
  if (!isObject(f)) {
    bad();
    return null;
  }
  return {
    lastSuccessAt: opt(f.lastSuccessAt, isIso, bad),
    oldestActiveVerifiedAt: opt(f.oldestActiveVerifiedAt, isIso, bad),
    activeTtlSec: opt(f.activeTtlSec, (v) => isInt(v, 1, 7 * 86400), bad),
    validUntil: opt(f.validUntil, isIso, bad),
  };
};

const projectSessions = (s, bad) => {
  if (s === undefined || s === null) return null;
  if (!isObject(s) || !isFraction(s.firstSession) || !isFraction(s.retryRescued) || !isFraction(s.failed)) {
    bad();
    return null;
  }
  return {
    firstSession: s.firstSession, retryRescued: s.retryRescued, failed: s.failed,
    window: opt(s.window, (v) => v === '15m', bad), samples: opt(s.samples, (v) => isInt(v, 1, 1e7), bad),
  };
};

const projectEvent = (e, bad) => {
  if (!isObject(e) || !isIso(e.at) || !EVENT_TYPES.includes(e.type)) {
    bad();
    return null;
  }
  if (e.type === 'discovery') {
    if (isInt(e.count, 0, 100000)) return { type: e.type, count: e.count, at: e.at };
    bad();
    return null;
  }
  const id = canonicalEndpointId(e.endpoint);
  if (!id) {
    bad();
    return null;
  }
  if (isNegativeControlIp(id.replace(/:\d+$/, ''))) return null;
  return { type: e.type, endpoint: id, at: e.at };
};

/** Shared top-level checks for the exporter files (fail closed on the frame, drop bad items). */
const checkFrame = (doc, nowMs) => {
  if (!isObject(doc) || doc.schemaVersion !== SCHEMA_VERSION) throw new LabDataError('lab_malformed', 'schema');
  if (!isIso(doc.generatedAt) || Date.parse(doc.generatedAt) > nowMs + FUTURE_SKEW_MS) {
    throw new LabDataError('lab_malformed', 'generatedAt');
  }
};

const projectOverview = (doc, nowMs) => {
  checkFrame(doc, nowMs);
  if (!STATUSES.includes(doc.status)) throw new LabDataError('lab_malformed', 'status');
  const endpoints = bounded(doc.endpoints, LIMITS.endpoints, 'endpoints');
  const events = bounded(doc.events, LIMITS.events, 'events');
  const history = bounded(doc.activeHistory, LIMITS.activeHistory, 'activeHistory');
  const p = partialSet();
  const keep = (section, ok) => (item) => {
    if (!ok(item)) p.mark(section)();
    return ok(item);
  };
  const point = (pt) => isObject(pt) && isIso(pt.at) && isInt(pt.active, 0, 100000);
  const out = {
    schemaVersion: SCHEMA_VERSION,
    status: doc.status,
    generatedAt: doc.generatedAt,
    coverage: 'full',
    counts: projectCounts(doc.counts, p.mark('counts')),
    freshness: projectFreshness(doc.freshness, p.mark('freshness')),
    sessions: projectSessions(doc.sessions, p.mark('sessions')),
    activeHistory: history ? history.filter(keep('activeHistory', point)).map((pt) => ({ at: pt.at, active: pt.active })) : null,
    events: events ? events.map((e) => projectEvent(e, p.mark('events'))).filter(Boolean) : null,
    endpoints: endpoints ? endpoints.map((e) => projectEndpoint(e, p.mark('endpoints'))).filter(Boolean) : null,
    retryAfterSec: isInt(doc.retryAfterSec, 1, 3600) ? doc.retryAfterSec : RETRY_AFTER_S,
  };
  const partial = p.list();
  return partial.length ? { ...out, partial } : out;
};

const projectCheck = (c, bad) => {
  if (c === undefined || c === null) return null;
  if (isObject(c) && CHECK_RESULTS.includes(c.result)) return { result: c.result, at: opt(c.at, isIso, bad) };
  bad();
  return null;
};

/** @returns {object|null} null when the endpoint is not listed one by one (not public); throws when malformed. */
const projectDetail = (doc, endpointId, range, nowMs) => {
  checkFrame(doc, nowMs);
  const p = partialSet();
  let invalid = false;
  const endpoint = projectEndpoint(doc.endpoint, () => {
    invalid = true;
    p.mark('endpoint')();
  });
  if (!endpoint) {
    if (invalid) throw new LabDataError('lab_malformed', 'detail endpoint');
    return null; // the negative control, or a state that is public only as counts and transitions
  }
  if (endpointIdOf(endpoint.ip, endpoint.port) !== endpointId) {
    throw new LabDataError('lab_malformed', 'detail does not belong to the requested endpoint');
  }
  const present = (v) => v !== undefined && v !== null;
  const timeline = bounded(doc.timeline, LIMITS.timeline, 'timeline');
  if (present(doc.historyBuckets) && !isObject(doc.historyBuckets)) p.mark('history')();
  const buckets = isObject(doc.historyBuckets) ? bounded(doc.historyBuckets[RANGE_BUCKETS[range]], LIMITS.buckets, 'buckets') : null;
  const events = bounded(doc.historyEvents, LIMITS.detailEvents, 'historyEvents');
  const since = RANGES[range] === null ? -Infinity : nowMs - RANGES[range];
  let checks = null;
  if (isObject(doc.checks)) {
    const bad = p.mark('checks');
    checks = { handshake: projectCheck(doc.checks.handshake, bad), tunnel: projectCheck(doc.checks.tunnel, bad), https: projectCheck(doc.checks.https, bad) };
  } else if (present(doc.checks)) p.mark('checks')();
  let stability = null;
  if (isObject(doc.stability)) {
    const bad = p.mark('stability');
    const st = doc.stability;
    stability = { h1: opt(st.h1, isFraction, bad), h24: opt(st.h24, isFraction, bad), observations: opt(st.observations, (v) => isInt(v, 0, 1e7), bad) };
  } else if (present(doc.stability)) p.mark('stability')();
  // lastError: absent = unknown (the key stays absent), null = no error recorded, an object = the last error.
  let lastError;
  if (doc.lastError === null) lastError = null;
  else if (isObject(doc.lastError)) {
    if (typeof doc.lastError.code !== 'string') p.mark('lastError')();
    lastError = { code: publicErrorCode(doc.lastError.code), at: opt(doc.lastError.at, isIso, p.mark('lastError')) };
  } else if (doc.lastError !== undefined) p.mark('lastError')();
  const keep = (section, ok) => (item) => {
    if (!ok(item)) p.mark(section)();
    return ok(item);
  };
  const out = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: doc.generatedAt,
    endpoint,
    checks,
    stability,
    timeline: timeline ? timeline.filter(keep('timeline', (pt) => isObject(pt) && isIso(pt.at) && STATES.includes(pt.state)))
      .map((pt) => ({ at: pt.at, state: pt.state })) : null,
    ...(lastError === undefined ? {} : { lastError }),
    history: {
      range,
      buckets: buckets ? buckets.filter(keep('history', (b) => isObject(b) && isIso(b.at) && ['first', 'retry', 'fail'].every((k) => isInt(b[k], 0, 100000))))
        .map((b) => ({ at: b.at, first: b.first, retry: b.retry, fail: b.fail })) : [],
      events: events ? events.filter(keep('history', (e) => isObject(e) && isIso(e.at) && HISTORY_RESULTS.includes(e.result)))
        .filter((e) => Date.parse(e.at) >= since)
        .map((e) => (e.result === 'fail' && e.error !== undefined ? { at: e.at, result: e.result, error: publicErrorCode(e.error) } : { at: e.at, result: e.result })) : [],
    },
  };
  const partial = p.list();
  return partial.length ? { ...out, partial } : out;
};

// ── Compatibility mode: active-pool.json + lab-status.json ────

const ageToIso = (generatedAtMs, ageS) => (isInt(ageS, 0, 10 * 365 * 86400) ? new Date(generatedAtMs - ageS * 1000).toISOString().replace('.000Z', 'Z') : null);

const readCompat = (dir, nowMs) => {
  const pool = readJson(path.join(dir, FILES.pool), MAX_BYTES.pool);
  const status = readJson(path.join(dir, FILES.status), MAX_BYTES.status);
  if (pool.missing && status.missing) throw new LabDataError('lab_not_available', 'no public Lab files');
  if (pool.missing || status.missing) throw new LabDataError('lab_malformed', 'compatibility files incomplete');
  let snapshot;
  try {
    snapshot = validateLabSnapshot(pool.doc, nowMs);
  } catch {
    throw new LabDataError('lab_malformed', 'active-pool.json');
  }
  const st = status.doc;
  if (!isObject(st) || st.schema_version !== STATUS_SCHEMA_VERSION || !isIso(st.generated_at)) {
    throw new LabDataError('lab_malformed', 'lab-status.json');
  }
  return { snapshot, pool: pool.doc, status: st, statusAtMs: Date.parse(st.generated_at) };
};

/**
 * Partial overview from the operational files. Only what they prove: status, freshness and the fresh ACTIVE
 * list (ACTIVE implies https "ok": the Lab sets ACTIVE only after a TLS-verified HTTPS request through the
 * tunnel, endpoint_lab.apply_outcome / deep_verify). Not published: counts (lab-status.json counts every row,
 * the negative control included), sessions (stats_15m.sessions uses another definition than the contract),
 * history, events, per-endpoint session and reliability. Missing data shows less, never a guessed number.
 */
const compatOverview = (c) => {
  const st = c.status;
  const health = isObject(st.lab) && typeof st.lab.health === 'string' ? st.lab.health.toLowerCase() : null;
  const status = STATUSES.includes(health) ? health : c.snapshot.labStatus;
  const generatedAtMs = Math.min(c.snapshot.generatedAtMs, c.statusAtMs);
  const fr = isObject(st.freshness) ? st.freshness : {};
  const ttls = new Set(c.snapshot.endpoints.map((e) => Math.round((e.expiresAtMs - e.verifiedAtMs) / 1000)));
  const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
  return {
    schemaVersion: SCHEMA_VERSION,
    status,
    generatedAt: iso(generatedAtMs),
    coverage: 'active-only',
    counts: null,
    freshness: {
      lastSuccessAt: ageToIso(c.statusAtMs, fr.newest_active_verified_s),
      oldestActiveVerifiedAt: ageToIso(c.statusAtMs, fr.oldest_active_verified_s),
      activeTtlSec: ttls.size === 1 ? [...ttls][0] : null,
      // the pool proves its list until expires_at: later the page shows STALE, not "no endpoints"
      validUntil: iso(c.snapshot.expiresAtMs),
    },
    sessions: null,
    endpoints: c.snapshot.endpoints.filter((e) => !isNegativeControlIp(e.ip)).map((e) => ({
      ip: e.ip, port: e.port, state: 'ACTIVE', source: TOKEN_RE.test(e.sourceClass) ? e.sourceClass : null,
      lastVerifiedAt: iso(e.verifiedAtMs), expiresAt: iso(e.expiresAtMs),
      session: null, https: 'ok', reliability: null,
    })),
    retryAfterSec: RETRY_AFTER_S,
  };
};

const compatDetail = (c, endpointId) => {
  const ep = c.snapshot.endpoints.find((e) => endpointIdOf(e.ip, e.port) === endpointId);
  if (!ep) return null;
  const overview = compatOverview(c);
  const item = overview.endpoints.find((e) => endpointIdOf(e.ip, e.port) === endpointId);
  const at = item.lastVerifiedAt;
  // The deep verification that made it ACTIVE proves all three checks at that moment; nothing else is known.
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: overview.generatedAt,
    endpoint: item,
    checks: { handshake: { result: 'ok', at }, tunnel: { result: 'ok', at }, https: { result: 'ok', at } },
  };
};

// ── Entry points ──────────────────────────────────────────────

const DEFAULT_DIR = '/run/endpoint-lab';

/** The public directory: an absolute ENDPOINT_LAB_PUBLIC_DIR (fixed at process start), else the read-only mount. */
const resolvePublicDir = (value) => (typeof value === 'string' && path.isAbsolute(value) ? path.resolve(value) : DEFAULT_DIR);

/**
 * Whether this deployment publishes Lab files at all (no reading, no validation). Without them (Vercel, forks,
 * no mount) /api/lab answers 503 lab_not_available; /api/status passes this flag so the generator page does not
 * ask for data that cannot exist. A present but broken file still counts: that 503 is a real failure.
 */
const isPublished = (dir) => [FILES.overview, FILES.pool, FILES.status].some((name) => {
  try {
    return fs.statSync(path.join(dir, name)).isFile();
  } catch {
    return false;
  }
});

/** @returns {object} browser overview (full or compatibility). Throws LabDataError. */
const loadOverview = (dir, nowMs = Date.now()) => {
  const full = readJson(path.join(dir, FILES.overview), MAX_BYTES.overview);
  if (!full.missing) return projectOverview(full.doc, nowMs);
  return compatOverview(readCompat(dir, nowMs));
};

/** @returns {object|null} browser endpoint details, or null when the endpoint is not public. Throws LabDataError. */
const loadEndpoint = (dir, endpointId, range, nowMs = Date.now()) => {
  const full = readJson(path.join(dir, FILES.overview), MAX_BYTES.overview);
  if (!full.missing) {
    const detail = readJson(path.join(dir, FILES.detailsDir, detailFileName(endpointId)), MAX_BYTES.detail);
    return detail.missing ? null : projectDetail(detail.doc, endpointId, range, nowMs);
  }
  return compatDetail(readCompat(dir, nowMs), endpointId);
};

module.exports = {
  FILES,
  MAX_BYTES,
  LIMITS,
  RANGES,
  RETRY_AFTER_S,
  LabDataError,
  DEFAULT_DIR,
  canonicalEndpointId,
  detailFileName,
  resolvePublicDir,
  isPublished,
  loadOverview,
  loadEndpoint,
  _cache: cache,
};
