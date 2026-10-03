// src/server/endpointCache.js
// Endpoint registry: the single place api/warp.js and api/status.js get WARP endpoint
// candidates from. Today it serves a static seed list; a persistent store can be plugged
// in behind getTopEndpoints() without touching its callers.
// Never stores private keys, tokens, or user configs.

/**
 * Hardcoded seed endpoints from 5 Cloudflare WARP /24 subnets.
 * Candidates are TCP-checked per request in api/warp.js.
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
 * Return up to `limit` candidate endpoints for the given `port`,
 * excluding any whose cidr24 is in `excludeCidrs`.
 * Async so a persistent store can replace the static list without changing callers.
 * @param {{ port?: number, limit?: number, excludeCidrs?: string[] }} opts
 * @returns {Promise<Array>}
 */
const getTopEndpoints = async ({ port = 2408, limit = 5, excludeCidrs = [] } = {}) =>
  HARDCODED_FALLBACK
    .filter((e) => e.port === port && !excludeCidrs.includes(e.cidr24))
    .slice(0, limit)
    .map((e) => ({ ...e }));

module.exports = {
  getFallbackEndpoints,
  getTopEndpoints,
  HARDCODED_FALLBACK,
};
