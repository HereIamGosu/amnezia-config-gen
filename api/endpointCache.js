// api/endpointCache.js
// Vercel KV-backed endpoint registry with hardcoded fallback.
// KV keys: `endpoint:{id}` (JSON object), `endpoints:index` (JSON array of ids).
// Never stores private keys, tokens, or user configs.

let kv = null;
let kvReady = false;

const initKv = async () => {
  if (kvReady) return kv;
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    kvReady = true;
    return null;
  }
  try {
    const mod = await import('@vercel/kv');
    kv = mod.kv ?? mod.default ?? null;
    kvReady = true;
  } catch {
    kvReady = true;
    kv = null;
  }
  return kv;
};

/**
 * Hardcoded seed endpoints from 5 Cloudflare WARP /24 subnets.
 * Returned verbatim when KV is unavailable or returns no active candidates.
 */
const HARDCODED_FALLBACK = [
  { id: '162.159.192.1:2408',  ip: '162.159.192.1',  port: 2408, cidr24: '162.159.192.0/24', status: 'candidate', score: 70, tcp_latency_p50_ms: null, tcp_success_rate_24h: null, consecutive_failures: 0, last_tcp_ok_at: null, last_checked_at: null },
  { id: '162.159.192.8:2408',  ip: '162.159.192.8',  port: 2408, cidr24: '162.159.192.0/24', status: 'candidate', score: 70, tcp_latency_p50_ms: null, tcp_success_rate_24h: null, consecutive_failures: 0, last_tcp_ok_at: null, last_checked_at: null },
  { id: '162.159.193.1:2408',  ip: '162.159.193.1',  port: 2408, cidr24: '162.159.193.0/24', status: 'candidate', score: 70, tcp_latency_p50_ms: null, tcp_success_rate_24h: null, consecutive_failures: 0, last_tcp_ok_at: null, last_checked_at: null },
  { id: '162.159.193.8:2408',  ip: '162.159.193.8',  port: 2408, cidr24: '162.159.193.0/24', status: 'candidate', score: 70, tcp_latency_p50_ms: null, tcp_success_rate_24h: null, consecutive_failures: 0, last_tcp_ok_at: null, last_checked_at: null },
  { id: '162.159.195.1:2408',  ip: '162.159.195.1',  port: 2408, cidr24: '162.159.195.0/24', status: 'candidate', score: 70, tcp_latency_p50_ms: null, tcp_success_rate_24h: null, consecutive_failures: 0, last_tcp_ok_at: null, last_checked_at: null },
  { id: '162.159.195.8:2408',  ip: '162.159.195.8',  port: 2408, cidr24: '162.159.195.0/24', status: 'candidate', score: 70, tcp_latency_p50_ms: null, tcp_success_rate_24h: null, consecutive_failures: 0, last_tcp_ok_at: null, last_checked_at: null },
  { id: '188.114.96.1:2408',   ip: '188.114.96.1',   port: 2408, cidr24: '188.114.96.0/24',  status: 'candidate', score: 70, tcp_latency_p50_ms: null, tcp_success_rate_24h: null, consecutive_failures: 0, last_tcp_ok_at: null, last_checked_at: null },
  { id: '188.114.96.8:2408',   ip: '188.114.96.8',   port: 2408, cidr24: '188.114.96.0/24',  status: 'candidate', score: 70, tcp_latency_p50_ms: null, tcp_success_rate_24h: null, consecutive_failures: 0, last_tcp_ok_at: null, last_checked_at: null },
  { id: '188.114.97.1:2408',   ip: '188.114.97.1',   port: 2408, cidr24: '188.114.97.0/24',  status: 'candidate', score: 70, tcp_latency_p50_ms: null, tcp_success_rate_24h: null, consecutive_failures: 0, last_tcp_ok_at: null, last_checked_at: null },
  { id: '188.114.97.66:2408',  ip: '188.114.97.66',  port: 2408, cidr24: '188.114.97.0/24',  status: 'candidate', score: 70, tcp_latency_p50_ms: null, tcp_success_rate_24h: null, consecutive_failures: 0, last_tcp_ok_at: null, last_checked_at: null },
  { id: '188.114.99.1:2408',   ip: '188.114.99.1',   port: 2408, cidr24: '188.114.99.0/24',  status: 'candidate', score: 70, tcp_latency_p50_ms: null, tcp_success_rate_24h: null, consecutive_failures: 0, last_tcp_ok_at: null, last_checked_at: null },
];

/** Return a copy of the hardcoded fallback list — never mutate. */
const getFallbackEndpoints = () => HARDCODED_FALLBACK.map((e) => ({ ...e }));

/**
 * Return up to `limit` active/candidate endpoints from KV for the given `port`,
 * excluding any whose cidr24 is in `excludeCidrs`.
 * Falls back to hardcoded list (filtered by port) when KV is unavailable or empty.
 * @param {{ port?: number, limit?: number, excludeCidrs?: string[] }} opts
 * @returns {Promise<Array>}
 */
const getTopEndpoints = async ({ port = 2408, limit = 5, excludeCidrs = [] } = {}) => {
  const store = await initKv();
  if (store) {
    try {
      const index = await store.get('endpoints:index');
      if (Array.isArray(index) && index.length > 0) {
        const records = await Promise.all(index.map((id) => store.get(`endpoint:${id}`)));
        const valid = records
          .filter((r) => r && typeof r === 'object')
          .filter((r) => r.port === port)
          .filter((r) => ['active', 'candidate', 'manual_whitelist'].includes(r.status))
          .filter((r) => !excludeCidrs.includes(r.cidr24))
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
          .slice(0, limit);
        if (valid.length > 0) return valid;
      }
    } catch {
      // fall through to hardcoded list
    }
  }
  // Hardcoded fallback: filter by port, exclude requested cidrs
  return HARDCODED_FALLBACK
    .filter((e) => e.port === port && !excludeCidrs.includes(e.cidr24))
    .slice(0, limit)
    .map((e) => ({ ...e }));
};

/**
 * Fetch a single endpoint record from KV by id.
 * @param {string} id e.g. "162.159.192.1:2408"
 * @returns {Promise<object|null>}
 */
const getEndpointById = async (id) => {
  const store = await initKv();
  if (!store) return null;
  try {
    const record = await store.get(`endpoint:${id}`);
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
};

/**
 * Persist an updated health snapshot for an endpoint in KV.
 * Creates the record if absent; never stores private keys or user data.
 * @param {string} id
 * @param {{ latency_ms: number|null, success: boolean }} health
 */
const updateEndpointHealth = async (id, { latency_ms, success }) => {
  const store = await initKv();
  if (!store) return;
  try {
    const existing = await store.get(`endpoint:${id}`);
    const base = (existing && typeof existing === 'object') ? existing : { id, status: 'candidate', score: 70, consecutive_failures: 0 };
    const now = new Date().toISOString();
    const failures = success ? 0 : (base.consecutive_failures ?? 0) + 1;
    const successRate = (() => {
      const prev = base.tcp_success_rate_24h ?? null;
      if (prev === null) return success ? 1 : 0;
      return prev * 0.9 + (success ? 0.1 : 0);
    })();
    const latencyP50 = (() => {
      if (!success || latency_ms == null) return base.tcp_latency_p50_ms ?? null;
      const prev = base.tcp_latency_p50_ms ?? latency_ms;
      return Math.round(prev * 0.8 + latency_ms * 0.2);
    })();
    // Simple score: success_rate * 80 + (1 - latency/1000) * 20, clamped 0..100
    const latencyScore = latencyP50 != null ? Math.max(0, (1 - latencyP50 / 1000)) * 20 : 10;
    const newScore = Math.round(successRate * 80 + latencyScore);
    const newStatus = failures >= 5 ? 'quarantine' : (base.status === 'quarantine' && success ? 'candidate' : base.status);
    const updated = {
      ...base,
      consecutive_failures: failures,
      tcp_success_rate_24h: successRate,
      tcp_latency_p50_ms: latencyP50,
      score: newScore,
      status: newStatus,
      last_checked_at: now,
      ...(success ? { last_tcp_ok_at: now } : {}),
    };
    await store.set(`endpoint:${id}`, updated);
    // Ensure id is in the index
    const index = await store.get('endpoints:index') ?? [];
    if (!index.includes(id)) {
      await store.set('endpoints:index', [...index, id]);
    }
  } catch {
    // KV write failure is non-fatal
  }
};

/**
 * Explicitly set endpoint status and reason in KV.
 * @param {string} id
 * @param {string} status one of: active|candidate|quarantine|dead|manual_blacklist|manual_whitelist
 * @param {string} [reason]
 */
const markEndpointStatus = async (id, status, reason) => {
  const store = await initKv();
  if (!store) return;
  try {
    const existing = await store.get(`endpoint:${id}`);
    const base = (existing && typeof existing === 'object') ? existing : { id };
    await store.set(`endpoint:${id}`, {
      ...base,
      status,
      ...(reason ? { status_reason: reason } : {}),
      status_updated_at: new Date().toISOString(),
    });
  } catch {
    // non-fatal
  }
};

module.exports = {
  getFallbackEndpoints,
  getTopEndpoints,
  getEndpointById,
  updateEndpointHealth,
  markEndpointStatus,
  HARDCODED_FALLBACK,
};
