// api/status.js
// Public status endpoint — no auth, no IP leakage.
// State semantics (ok | degraded | down | unknown): src/server/endpointStatus.js.
// lab.available: whether this deployment publishes Endpoint Lab files (src/server/labPublic.js isPublished);
// the generator page requests /api/lab only when it is true.

const { getTopEndpoints } = require('../src/server/endpointCache');
const { portState, overallState, isMeasured, MESSAGES } = require('../src/server/endpointStatus');
const { isPublished, resolvePublicDir } = require('../src/server/labPublic');
const { PORT_ALLOWLIST } = require('./warp').__internals;

const SELECTABLE = ['active', 'candidate', 'manual_whitelist'];

/** Handler factory: the Lab directory is fixed when the server starts (tests pass their own). */
const createStatusHandler = ({ labDir = resolvePublicDir(process.env.ENDPOINT_LAB_PUBLIC_DIR) } = {}) => async (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  const lab = { available: isPublished(labDir) };

  try {
    // Per-port candidates from the endpoint registry (counts only, never IPs).
    const perPort = await Promise.all(
      PORT_ALLOWLIST.map(async (port) => {
        const candidates = (await getTopEndpoints({ port, limit: 20 }))
          .filter((e) => SELECTABLE.includes(e.status));
        return { port: String(port), candidates };
      }),
    );

    const ports = {};
    const candidates = {};
    for (const entry of perPort) {
      ports[entry.port] = portState(entry.candidates);
      candidates[entry.port] = entry.candidates.length;
    }
    const status = overallState(Object.values(ports));
    const measured = perPort.some((entry) => entry.candidates.some(isMeasured));

    res.status(200).json({
      status,
      updated_at: new Date().toISOString(),
      active_endpoints: Object.values(candidates).reduce((sum, n) => sum + n, 0),
      ports,
      candidates,
      health_source: measured ? 'runtime' : 'none',
      message: MESSAGES[status],
      cache_source: 'fallback', // static registry; field kept for response compatibility
      lab,
    });
  } catch {
    // Failing to compute the status is not evidence that endpoints are failing.
    res.status(200).json({
      status: 'unknown',
      updated_at: new Date().toISOString(),
      active_endpoints: null,
      ports: Object.fromEntries(PORT_ALLOWLIST.map((p) => [String(p), 'unknown'])),
      health_source: 'none',
      message: 'Status could not be computed',
      cache_source: 'fallback',
      lab,
    });
  }
};

const handler = createStatusHandler();
handler.createStatusHandler = createStatusHandler;
module.exports = handler;
