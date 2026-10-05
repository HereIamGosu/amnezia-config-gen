// src/server/labPublic.js
// Endpoint Lab public data for the website (/api/lab): a thin, read-only transport of files the Lab host
// exports into its secret-free public directory. Node never reads lab.db, keys or the Lab's private state.
//
//   full mode:           web-overview.json + web-endpoints/<sha256(id)[:32]>.json   (Lab exporter, contract v1)
//   compatibility mode:  active-pool.json (schema 2) + lab-status.json (schema 1) → a partial overview with
//                        real data only (ACTIVE endpoints, counts, freshness, 15-minute sessions); no history,
//                        no events, no non-ACTIVE list. coverage: "active-only".
//
// Every file is untrusted: size-checked before parsing, validated, and re-projected onto the browser contract
// (only known keys leave this module). Contract: docs/specs/endpoint-lab-frontend.md.

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
const isoOrNull = (v) => (isIso(v) ? v : null);
const pick = (v, allowed) => (typeof v === 'string' && allowed.includes(v) ? v : null);

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

const projectEndpoint = (e) => {
  if (!isObject(e) || typeof e.ip !== 'string' || !(net.isIPv4(e.ip) || net.isIPv6(e.ip)) || !isInt(e.port, 1, 65535)) return null;
  if (isNegativeControlIp(e.ip) || e.source === NEGATIVE_SOURCE) return null;
  return {
    ip: e.ip,
    port: e.port,
    state: pick(e.state, STATES) || 'UNKNOWN',
    source: typeof e.source === 'string' && TOKEN_RE.test(e.source) ? e.source : null,
    lastVerifiedAt: isoOrNull(e.lastVerifiedAt),
    expiresAt: isoOrNull(e.expiresAt),
    session: pick(e.session, SESSIONS),
    https: pick(e.https, CHECK_RESULTS),
    reliability: isFraction(e.reliability) ? e.reliability : null,
  };
};

const bounded = (list, limit, what) => {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list) || list.length > limit) throw new LabDataError('lab_malformed', `${what} not a bounded array`);
  return list;
};

const projectCounts = (c) => {
  if (!isObject(c)) return null;
  const keys = ['active', 'verified', 'suspect', 'quarantine', 'dead'];
  return keys.every((k) => isInt(c[k], 0, 100000)) ? Object.fromEntries(keys.map((k) => [k, c[k]])) : null;
};

const projectSessions = (s) => {
  if (!isObject(s) || !isFraction(s.firstSession) || !isFraction(s.retryRescued) || !isFraction(s.failed)) return null;
  return { firstSession: s.firstSession, retryRescued: s.retryRescued, failed: s.failed, window: s.window === '15m' ? '15m' : null };
};

const projectEvent = (e) => {
  if (!isObject(e) || !isIso(e.at)) return null;
  const type = pick(e.type, EVENT_TYPES);
  if (!type) return null;
  if (type === 'discovery') return isInt(e.count, 0, 100000) ? { type, count: e.count, at: e.at } : null;
  const id = canonicalEndpointId(e.endpoint);
  if (!id || isNegativeControlIp(id.replace(/:\d+$/, ''))) return null;
  return { type, endpoint: id, at: e.at };
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
  const f = isObject(doc.freshness) ? doc.freshness : null;
  return {
    schemaVersion: SCHEMA_VERSION,
    status: doc.status,
    generatedAt: doc.generatedAt,
    coverage: 'full',
    counts: projectCounts(doc.counts),
    freshness: f ? {
      lastSuccessAt: isoOrNull(f.lastSuccessAt),
      oldestActiveVerifiedAt: isoOrNull(f.oldestActiveVerifiedAt),
      activeTtlSec: isInt(f.activeTtlSec, 1, 7 * 86400) ? f.activeTtlSec : null,
    } : null,
    sessions: projectSessions(doc.sessions),
    activeHistory: history ? history.filter((p) => isObject(p) && isIso(p.at) && isInt(p.active, 0, 100000))
      .map((p) => ({ at: p.at, active: p.active })) : null,
    events: events ? events.map(projectEvent).filter(Boolean) : null,
    endpoints: endpoints ? endpoints.map(projectEndpoint).filter(Boolean) : null,
    retryAfterSec: isInt(doc.retryAfterSec, 1, 3600) ? doc.retryAfterSec : RETRY_AFTER_S,
  };
};

const projectCheck = (c) => (isObject(c) && pick(c.result, CHECK_RESULTS) ? { result: c.result, at: isoOrNull(c.at) } : null);

const projectDetail = (doc, endpointId, range, nowMs) => {
  checkFrame(doc, nowMs);
  const endpoint = projectEndpoint(doc.endpoint);
  if (!endpoint || endpointIdOf(endpoint.ip, endpoint.port) !== endpointId) {
    throw new LabDataError('lab_malformed', 'detail does not belong to the requested endpoint');
  }
  const timeline = bounded(doc.timeline, LIMITS.timeline, 'timeline');
  const buckets = isObject(doc.historyBuckets) ? bounded(doc.historyBuckets[RANGE_BUCKETS[range]], LIMITS.buckets, 'buckets') : null;
  const events = bounded(doc.historyEvents, LIMITS.detailEvents, 'historyEvents');
  const since = RANGES[range] === null ? -Infinity : nowMs - RANGES[range];
  const checks = isObject(doc.checks) ? {
    handshake: projectCheck(doc.checks.handshake),
    tunnel: projectCheck(doc.checks.tunnel),
    https: projectCheck(doc.checks.https),
  } : null;
  const st = isObject(doc.stability) ? doc.stability : null;
  let lastError = null;
  if (isObject(doc.lastError)) {
    lastError = typeof doc.lastError.code === 'string' && TOKEN_RE.test(doc.lastError.code)
      ? { code: doc.lastError.code, at: isoOrNull(doc.lastError.at) } : { code: 'unknown', at: isoOrNull(doc.lastError.at) };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: doc.generatedAt,
    endpoint,
    checks,
    stability: st ? {
      h1: isFraction(st.h1) ? st.h1 : null,
      h24: isFraction(st.h24) ? st.h24 : null,
      observations: isInt(st.observations, 0, 10000000) ? st.observations : null,
    } : null,
    timeline: timeline ? timeline.filter((p) => isObject(p) && isIso(p.at)).map((p) => ({ at: p.at, state: pick(p.state, STATES) || 'UNKNOWN' })) : null,
    lastError,
    history: {
      range,
      buckets: buckets ? buckets.filter((b) => isObject(b) && isIso(b.at) && ['first', 'retry', 'fail'].every((k) => isInt(b[k], 0, 100000)))
        .map((b) => ({ at: b.at, first: b.first, retry: b.retry, fail: b.fail })) : [],
      events: events ? events.filter((e) => isObject(e) && isIso(e.at) && pick(e.result, HISTORY_RESULTS) && Date.parse(e.at) >= since)
        .map((e) => (e.result === 'fail' && typeof e.error === 'string' && TOKEN_RE.test(e.error)
          ? { at: e.at, result: e.result, error: e.error } : { at: e.at, result: e.result })) : [],
    },
  };
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
 * Partial overview from the operational files. Only what they prove: no non-ACTIVE list, no history,
 * no events, no per-endpoint session or reliability. ACTIVE implies https "ok": the Lab sets ACTIVE only
 * after a TLS-verified HTTPS request through the tunnel (endpoint_lab.apply_outcome / deep_verify).
 */
const compatOverview = (c) => {
  const st = c.status;
  const health = isObject(st.lab) && typeof st.lab.health === 'string' ? st.lab.health.toLowerCase() : null;
  const status = STATUSES.includes(health) ? health : c.snapshot.labStatus;
  const generatedAtMs = Math.min(c.snapshot.generatedAtMs, c.statusAtMs);
  const pool = isObject(st.pool) ? st.pool : {};
  const states = isObject(pool.states) ? pool.states : null;
  // Per-state counts include blacklisted endpoints in lab-status.json; show them only when there are none.
  const counts = states && pool.blacklisted === 0 ? projectCounts({
    active: states.ACTIVE || 0, verified: states.VERIFIED || 0, suspect: states.SUSPECT || 0,
    quarantine: states.QUARANTINE || 0, dead: states.DEAD || 0,
  }) : null;
  const fr = isObject(st.freshness) ? st.freshness : {};
  const ttls = new Set(c.snapshot.endpoints.map((e) => Math.round((e.expiresAtMs - e.verifiedAtMs) / 1000)));
  const s = isObject(st.stats_15m) && isObject(st.stats_15m.sessions) ? st.stats_15m.sessions : null;
  let sessions = null;
  if (s && [s.first_session_ok, s.second_session_rescued, s.both_sessions_failed].every((v) => isInt(v, 0, 1e7))) {
    const n = s.first_session_ok + s.second_session_rescued + s.both_sessions_failed;
    if (n > 0) {
      sessions = {
        firstSession: Number((s.first_session_ok / n).toFixed(4)),
        retryRescued: Number((s.second_session_rescued / n).toFixed(4)),
        failed: Number((s.both_sessions_failed / n).toFixed(4)),
        window: '15m',
      };
    }
  }
  const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
  return {
    schemaVersion: SCHEMA_VERSION,
    status,
    generatedAt: iso(generatedAtMs),
    coverage: 'active-only',
    counts,
    freshness: {
      lastSuccessAt: ageToIso(c.statusAtMs, fr.newest_active_verified_s),
      oldestActiveVerifiedAt: ageToIso(c.statusAtMs, fr.oldest_active_verified_s),
      activeTtlSec: ttls.size === 1 ? [...ttls][0] : null,
    },
    sessions,
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
  canonicalEndpointId,
  detailFileName,
  loadOverview,
  loadEndpoint,
  _cache: cache,
};
