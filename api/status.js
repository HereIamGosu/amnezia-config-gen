// api/status.js
// Public status endpoint — no auth, no IP leakage.

const { getTopEndpoints, getFallbackEndpoints } = require('../src/server/endpointCache');
const { PORT_ALLOWLIST } = require('./warp').__internals;

const handler = async (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');

  try {
    let cacheSource = 'fallback';
    let activeEndpoints = 0;
    const portStatus = {};

    // Try to get counts per port from KV (without leaking IPs)
    const checks = await Promise.all(
      PORT_ALLOWLIST.map(async (port) => {
        const candidates = await getTopEndpoints({ port, limit: 20 });
        const active = candidates.filter((e) => ['active', 'candidate', 'manual_whitelist'].includes(e.status));
        return { port, count: active.length, fromFallback: active.every((e) => e.tcp_latency_p50_ms == null) };
      }),
    );

    let anyFromKv = false;
    for (const { port, count, fromFallback } of checks) {
      if (!fromFallback) anyFromKv = true;
      activeEndpoints += count;
      portStatus[String(port)] = count === 0 ? 'down' : (count < 3 ? 'degraded' : 'ok');
    }
    if (anyFromKv) cacheSource = 'kv';

    const hasDown = Object.values(portStatus).some((s) => s === 'down');
    const hasDegraded = Object.values(portStatus).some((s) => s === 'degraded');
    const statusStr = hasDown && hasDegraded ? 'degraded'
      : hasDown ? 'degraded'
      : hasDegraded ? 'degraded'
      : 'ok';

    res.status(200).json({
      status: statusStr,
      updated_at: new Date().toISOString(),
      active_endpoints: activeEndpoints,
      ports: portStatus,
      message: statusStr === 'ok' ? 'All ports operational' : 'Some ports have reduced availability',
      cache_source: cacheSource,
    });
  } catch {
    res.status(200).json({
      status: 'degraded',
      updated_at: new Date().toISOString(),
      active_endpoints: getFallbackEndpoints().length,
      ports: Object.fromEntries(PORT_ALLOWLIST.map((p) => [String(p), 'degraded'])),
      message: 'Status check failed; using hardcoded fallback',
      cache_source: 'fallback',
    });
  }
};

module.exports = handler;
