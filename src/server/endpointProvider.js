// src/server/endpointProvider.js
// Endpoint providers (Endpoint Lab, Phases C and D).
//
// BuiltinEndpointProvider is the hostname / built-in list behaviour and stays the default (endpointMode=hostname).
// LabEndpointProvider reads the Endpoint Lab's read-only snapshot (active-pool.json, schema 2) and selects
// fresh, lab-verified endpoints. It never probes the network per request and never stores user data.
//
// Phase D, Lab Auto (endpointMode=lab in /api/warp): selectForGeneration() is the generator's choice, fail-closed
// with stable public error codes; there is no fallback to hostname. The pool is the same read-only mount that
// /api/lab reads (labPublic.resolvePublicDir).
//
// Shadow mode (Phase C diagnostics): ShadowRecorder computes what the Lab provider would choose for a
// hostname-mode request, after the response has been sent, and keeps aggregate counters only. It never changes a
// response, does not observe Lab Auto requests (those are real selections, not counterfactuals) and logs one
// aggregate line per interval. Enabled only by environment (forks, Vercel and local runs are unaffected):
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

// Lab Auto public error codes (what a user may see) and the provider reasons behind them. A file that is
// missing, oversized, not JSON or fails validation is one public case: the Lab data cannot be used now.
const LAB_AUTO_ERROR_CODES = Object.freeze(['lab_unavailable', 'lab_stale', 'lab_no_endpoints']);
const LAB_AUTO_ERRORS = Object.freeze({
  snapshot_missing: 'lab_unavailable',
  snapshot_too_large: 'lab_unavailable',
  snapshot_invalid_json: 'lab_unavailable',
  snapshot_rejected: 'lab_unavailable',
  snapshot_stale: 'lab_stale',
  pool_empty: 'lab_no_endpoints',
});

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

  /**
   * Lab Auto (Phase D): select() under the generator's fail-closed rules. Freshness is checked here, at the
   * moment of selection (snapshot and every endpoint must be unexpired). A Lab that reports itself `unavailable`
   * cannot vouch for its pool, so it is refused even while endpoints are inside their TTL. Port and diversity
   * semantics are select()'s: requested port first, shortfall from other Lab ports, distinct IPs, fewer
   * endpoints rather than duplicates. Never throws.
   * @param {{ count?: number, port?: number|null }} req
   * @returns {{ ok: false, code: string } | { ok: true, requested: number, distinct: number, portMatched: boolean,
   *   ageSec: number, labStatus: string, endpoints: Array<{ ip: string, port: number }> }}
   */
  selectForGeneration(req = {}) {
    let r;
    try {
      r = this.select(req);
    } catch {
      return { ok: false, code: 'lab_unavailable' };
    }
    if (!r.available) return { ok: false, code: LAB_AUTO_ERRORS[r.reason] || 'lab_unavailable' };
    if (r.labStatus === 'unavailable') return { ok: false, code: 'lab_unavailable' };
    if (!r.endpoints.length) return { ok: false, code: 'lab_no_endpoints' };
    return { ok: true, requested: r.requested, distinct: r.distinct, portMatched: r.portMatched, ageSec: r.ageSec,
      labStatus: r.labStatus, endpoints: r.endpoints.map(({ ip, port }) => ({ ip, port })) };
  }
}

// Snapshot age buckets (seconds) for the shadow summary.
const AGE_BUCKETS = [[60, 'lt60s'], [120, 'lt120s'], [180, 'lt180s']];
const ageBucket = (s) => (AGE_BUCKETS.find(([limit]) => s < limit) || [null, 'ge180s'])[1];

const emptyCounters = () => ({
  shadow_requests: 0,
  shadow_lab_available: 0,
  shadow_lab_unavailable: 0,
  shadow_unavailable_reasons: {},
  shadow_pool_stale: 0,
  shadow_selection_success: 0,
  shadow_selection_failure: 0,
  shadow_port_fallback: 0,
  shadow_errors: 0,
  // count = 2/3 requests only
  shadow_multi_requests: 0,
  shadow_distinct_ip_success: 0,
  shadow_distinct_port_success: 0,
  shadow_insufficient_diversity: 0,
  snapshot_age_bucket: { lt60s: 0, lt120s: 0, lt180s: 0, ge180s: 0 },
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
      c.shadow_requests += 1;
      const r = this.provider.select(req);
      if (r.ageSec != null) c.snapshot_age_bucket[ageBucket(r.ageSec)] += 1;
      if (!r.available) {
        c.shadow_lab_unavailable += 1;
        c.shadow_selection_failure += 1;
        if (r.reason === 'snapshot_stale') c.shadow_pool_stale += 1;
        c.shadow_unavailable_reasons[r.reason] = (c.shadow_unavailable_reasons[r.reason] || 0) + 1;
      } else {
        c.shadow_lab_available += 1;
        if (r.distinct >= 1) c.shadow_selection_success += 1;
        else c.shadow_selection_failure += 1;
        if (!r.portMatched) c.shadow_port_fallback += 1;
        if (r.requested > 1) {
          c.shadow_multi_requests += 1;
          if (new Set(r.endpoints.map((e) => e.ip)).size === r.requested) c.shadow_distinct_ip_success += 1;
          if (new Set(r.endpoints.map((e) => e.port)).size === r.requested) c.shadow_distinct_port_success += 1;
          if (r.distinct < r.requested) c.shadow_insufficient_diversity += 1;
        }
      }
    } catch {
      c.shadow_errors += 1;
    }
    try {
      this.maybeFlush();
    } catch {
      /* logging must never affect generation */
    }
  }

  summary() {
    return {
      window_start: new Date(this.windowStart).toISOString(),
      window_end: new Date(this.now()).toISOString(),
      ...this.counters,
    };
  }

  maybeFlush(force = false) {
    if (!force && this.now() - this.windowStart < this.flushEveryMs) return;
    if (this.counters.shadow_requests > 0) this.log(`[endpoint-shadow] ${JSON.stringify(this.summary())}`);
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
  LAB_AUTO_ERROR_CODES,
  validateLabSnapshot,
  BuiltinEndpointProvider,
  LabEndpointProvider,
  ShadowRecorder,
  createShadowFromEnv,
  pickDiverse,
};
