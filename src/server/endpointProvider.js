// src/server/endpointProvider.js
// Endpoint providers (Endpoint Lab, Phase C).
//
// BuiltinEndpointProvider is today's behaviour (hostname / built-in list) and stays the default.
// LabEndpointProvider reads the Endpoint Lab's read-only snapshot (active-pool.json, schema 2) and selects
// fresh, lab-verified endpoints. In Phase C it runs only in shadow mode: ShadowRecorder computes what the Lab
// provider would choose for a real generation request, after the response has been sent, and keeps aggregate
// counters only. It never changes a response, never probes the network per request and never stores user data
// (no IPs of users, no configs, no keys). Counters are logged as one aggregate line per interval.
//
// Enabled only by environment (forks, Vercel and local runs are unaffected):
//   ENDPOINT_SHADOW=lab  ENDPOINT_LAB_POOL_PATH=/run/endpoint-lab/active-pool.json

'use strict';

const fs = require('fs');
const net = require('net');

const SNAPSHOT_SCHEMA_VERSION = 2;
const TOP_KEYS = ['schema_version', 'generated_at', 'expires_at', 'lab_status', 'active_count', 'endpoints'];
const LAB_STATUSES = ['ok', 'degraded', 'unavailable'];
const ENDPOINT_KEYS = ['ip', 'port', 'family', 'state', 'lab_verified_at', 'expires_at', 'source_class',
  'probe_completion_ms', 'traffic_total_ms'];
const OFFICIAL_PORTS = [2408, 500, 1701, 4500];
// WARP research prefixes of the Lab (deploy/endpoint-lab ALLOWED_PREFIXES without the TEST-NET negative control).
const ALLOWED_PREFIXES = [['162.159.192.0', 24], ['162.159.193.0', 24], ['162.159.195.0', 24],
  ['162.159.204.0', 24], ['188.114.96.0', 22]];
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const MAX_FUTURE_SKEW_MS = 60 * 1000;
const ENDPOINT_TTL_MS = 7 * 60 * 1000;   // Lab ACTIVE TTL, used to scale freshness
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SHADOW_FLUSH_MS = 10 * 60 * 1000;

const sameKeys = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj)
  && Object.keys(obj).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));

const parseIso = (value) => {
  if (typeof value !== 'string' || !ISO_RE.test(value)) throw new Error('malformed timestamp');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error('malformed timestamp');
  return ms;
};

const ipv4ToInt = (ip) => ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);

const inAllowedPrefix = (ip) => ALLOWED_PREFIXES.some(([base, bits]) => {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((ipv4ToInt(ip) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
});

/**
 * Strict, fail-closed validation of the Lab snapshot (mirror of endpoint_lab.validate_snapshot).
 * Throws on anything unexpected; returns only fresh active endpoints (empty when the file is stale).
 * @param {unknown} doc parsed JSON
 * @param {number} nowMs
 * @returns {{ labStatus: string, generatedAtMs: number, expiresAtMs: number, endpoints: object[] }}
 */
function validateLabSnapshot(doc, nowMs) {
  if (!sameKeys(doc, TOP_KEYS) || doc.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error('unsupported snapshot schema or fields');
  }
  if (!LAB_STATUSES.includes(doc.lab_status)) throw new Error('unknown lab_status');
  const generatedAtMs = parseIso(doc.generated_at);
  const expiresAtMs = parseIso(doc.expires_at);
  if (generatedAtMs > nowMs + MAX_FUTURE_SKEW_MS) throw new Error('snapshot generated in the future');
  if (!Array.isArray(doc.endpoints) || doc.active_count !== doc.endpoints.length) {
    throw new Error('active_count does not match endpoints');
  }
  const result = { labStatus: doc.lab_status, generatedAtMs, expiresAtMs, endpoints: [] };
  if (expiresAtMs <= nowMs) return result;
  for (const ep of doc.endpoints) {
    if (!sameKeys(ep, ENDPOINT_KEYS)) throw new Error('unexpected endpoint fields');
    if (typeof ep.ip !== 'string' || !net.isIPv4(ep.ip) || !inAllowedPrefix(ep.ip)) throw new Error('endpoint outside the WARP prefixes');
    if (!OFFICIAL_PORTS.includes(ep.port) || ep.family !== 4) throw new Error('endpoint port or family not allowed');
    const epExpires = parseIso(ep.expires_at);
    const verifiedAt = parseIso(ep.lab_verified_at);
    if (ep.state === 'active' && epExpires > nowMs) {
      result.endpoints.push({ ip: ep.ip, port: ep.port, verifiedAtMs: verifiedAt, expiresAtMs: epExpires,
        sourceClass: String(ep.source_class), trafficTotalMs: Number.isFinite(ep.traffic_total_ms) ? ep.traffic_total_ms : null });
    }
  }
  return result;
}

/** Today's behaviour: the generator keeps its hostname / built-in endpoint logic. */
class BuiltinEndpointProvider {
  get name() { return 'builtin'; }
}

/**
 * Weighted pick without replacement. Health is already guaranteed by the hard filter (fresh ACTIVE only);
 * the weight only spreads load: freshness first, VPS->WARP latency as a small tie-breaker (it is not user
 * latency). Distinct IPs always; distinct ports while possible. Fewer than `count` rather than duplicates.
 */
function pickDiverse(pool, count, nowMs, random) {
  const weight = (e) => 0.6
    + 0.25 * Math.max(0, 1 - (nowMs - e.verifiedAtMs) / ENDPOINT_TTL_MS)
    + 0.15 * (1 / (1 + (e.trafficTotalMs ?? 500) / 500));
  const chosen = [];
  const usedIps = new Set();
  const usedPorts = new Set();
  while (chosen.length < count) {
    const freshIp = pool.filter((e) => !usedIps.has(e.ip));
    if (!freshIp.length) break;
    const freshPort = freshIp.filter((e) => !usedPorts.has(e.port));
    const candidates = freshPort.length ? freshPort : freshIp;
    const total = candidates.reduce((sum, e) => sum + weight(e), 0);
    let roll = random() * total;
    let pick = candidates[candidates.length - 1];
    for (const e of candidates) {
      roll -= weight(e);
      if (roll <= 0) { pick = e; break; }
    }
    chosen.push(pick);
    usedIps.add(pick.ip);
    usedPorts.add(pick.port);
  }
  return chosen;
}

class LabEndpointProvider {
  /**
   * @param {{ path: string, now?: () => number, readFile?: Function, stat?: Function, random?: () => number }} opts
   */
  constructor({ path, now = Date.now, readFile = fs.readFileSync, stat = fs.statSync, random = Math.random }) {
    this.path = path;
    this.now = now;
    this.readFile = readFile;
    this.stat = stat;
    this.random = random;
    this.cache = null; // { key, doc | error }
  }

  get name() { return 'lab'; }

  /** Parsed snapshot, re-read only when mtime/size change. Never throws. */
  snapshot() {
    const nowMs = this.now();
    let key;
    try {
      const st = this.stat(this.path);
      if (st.size > MAX_SNAPSHOT_BYTES) return { available: false, reason: 'snapshot_too_large' };
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      return { available: false, reason: 'snapshot_missing' };
    }
    if (!this.cache || this.cache.key !== key) {
      try {
        this.cache = { key, doc: JSON.parse(this.readFile(this.path, 'utf8')) };
      } catch {
        this.cache = { key, error: 'snapshot_invalid_json' };
      }
    }
    if (this.cache.error) return { available: false, reason: this.cache.error };
    let parsed;
    try {
      parsed = validateLabSnapshot(this.cache.doc, nowMs);
    } catch {
      return { available: false, reason: 'snapshot_rejected' };
    }
    const ageSec = Math.max(0, Math.round((nowMs - parsed.generatedAtMs) / 1000));
    if (parsed.expiresAtMs <= nowMs) return { available: false, reason: 'snapshot_stale', ageSec, labStatus: parsed.labStatus };
    if (!parsed.endpoints.length) return { available: false, reason: 'pool_empty', ageSec, labStatus: parsed.labStatus };
    return { available: true, ageSec, labStatus: parsed.labStatus, endpoints: parsed.endpoints };
  }

  /**
   * What the Lab provider would hand out: `count` distinct endpoints, preferring the requested port.
   * @param {{ count?: number, port?: number|null }} req
   */
  select({ count = 1, port = null } = {}) {
    const snap = this.snapshot();
    if (!snap.available) return { available: false, reason: snap.reason, ageSec: snap.ageSec ?? null, endpoints: [] };
    const n = Math.min(3, Math.max(1, Number.parseInt(String(count), 10) || 1));
    const samePort = port == null ? snap.endpoints : snap.endpoints.filter((e) => e.port === port);
    // The requested port first; any shortfall is filled from other ports (distinct IPs still), and recorded.
    const chosen = pickDiverse(samePort, n, this.now(), this.random);
    if (chosen.length < n) {
      const used = new Set(chosen.map((e) => e.ip));
      const others = snap.endpoints.filter((e) => !samePort.includes(e) && !used.has(e.ip));
      chosen.push(...pickDiverse(others, n - chosen.length, this.now(), this.random));
    }
    const endpoints = chosen.map((e) => ({ ip: e.ip, port: e.port, verifiedAtMs: e.verifiedAtMs, sourceClass: e.sourceClass }));
    const portMatched = port == null || endpoints.every((e) => e.port === port);
    return { available: true, ageSec: snap.ageSec, labStatus: snap.labStatus, portMatched, requested: n,
      distinct: endpoints.length, endpoints };
  }
}

const emptyCounters = () => ({
  requests: 0, lab_available: 0, lab_unavailable: {}, selected: 0, port_fallback: 0, errors: 0,
  distinct_for_count: { 2: { requests: 0, distinct_sum: 0, short: 0 }, 3: { requests: 0, distinct_sum: 0, short: 0 } },
  pool_age_s: { n: 0, sum: 0, max: 0 },
});

/**
 * Shadow mode: aggregate-only observation of the Lab provider for real requests. It runs after the response
 * was sent and swallows every error. Logged line contains counts only — never endpoints, IPs or request data.
 */
class ShadowRecorder {
  constructor({ provider, log = (line) => console.log(line), now = Date.now, flushEveryMs = SHADOW_FLUSH_MS }) {
    this.provider = provider;
    this.log = log;
    this.now = now;
    this.flushEveryMs = flushEveryMs;
    this.windowStart = now();
    this.counters = emptyCounters();
  }

  /** @param {{ count?: number, port?: number|null }} req */
  observe(req = {}) {
    const c = this.counters;
    try {
      c.requests += 1;
      const r = this.provider.select(req);
      if (!r.available) {
        c.lab_unavailable[r.reason] = (c.lab_unavailable[r.reason] || 0) + 1;
      } else {
        c.lab_available += 1;
        c.selected += r.distinct;
        if (!r.portMatched) c.port_fallback += 1;
        c.pool_age_s.n += 1;
        c.pool_age_s.sum += r.ageSec;
        c.pool_age_s.max = Math.max(c.pool_age_s.max, r.ageSec);
        const bucket = c.distinct_for_count[r.requested];
        if (bucket) {
          bucket.requests += 1;
          bucket.distinct_sum += r.distinct;
          if (r.distinct < r.requested) bucket.short += 1;
        }
      }
    } catch {
      c.errors += 1;
    }
    try {
      this.maybeFlush();
    } catch {
      /* logging must never affect generation */
    }
  }

  summary() {
    const c = this.counters;
    return {
      window_start: new Date(this.windowStart).toISOString(),
      window_end: new Date(this.now()).toISOString(),
      requests: c.requests,
      shadow_lab_available: c.lab_available,
      shadow_lab_unavailable: c.lab_unavailable,
      shadow_selected: c.selected,
      shadow_port_fallback: c.port_fallback,
      shadow_errors: c.errors,
      shadow_pool_age_s: { avg: c.pool_age_s.n ? Math.round(c.pool_age_s.sum / c.pool_age_s.n) : null, max: c.pool_age_s.max },
      shadow_distinct_count_for_count_2_3: c.distinct_for_count,
    };
  }

  maybeFlush(force = false) {
    if (!force && this.now() - this.windowStart < this.flushEveryMs) return;
    if (this.counters.requests > 0) this.log(`[endpoint-shadow] ${JSON.stringify(this.summary())}`);
    this.windowStart = this.now();
    this.counters = emptyCounters();
  }
}

/** Shadow recorder from the environment, or null (default: no shadow, nothing read). */
function createShadowFromEnv(env = process.env) {
  if (env.ENDPOINT_SHADOW !== 'lab' || !env.ENDPOINT_LAB_POOL_PATH) return null;
  return new ShadowRecorder({ provider: new LabEndpointProvider({ path: env.ENDPOINT_LAB_POOL_PATH }) });
}

module.exports = {
  SNAPSHOT_SCHEMA_VERSION,
  OFFICIAL_PORTS,
  MAX_SNAPSHOT_BYTES,
  validateLabSnapshot,
  BuiltinEndpointProvider,
  LabEndpointProvider,
  ShadowRecorder,
  createShadowFromEnv,
  pickDiverse,
};
