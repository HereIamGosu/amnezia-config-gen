// src/server/endpointStatus.js
// Health semantics of the WARP endpoint pool reported by /api/status.
//
// States (per port and overall):
//   ok       — runtime health data exists and every measured endpoint passes;
//   degraded — runtime health data shows some measured endpoints failing;
//   down     — runtime health data shows every measured endpoint failing;
//   unknown  — no runtime health data. This is NOT evidence of a failure.
//
// An endpoint counts as measured only when the registry recorded a check for it
// (`last_checked_at` set and a finite `tcp_success_rate_24h`). The built-in seed list has
// no measurements, so today every port — and the pool as a whole — is `unknown`.
// Overall state ignores unknown ports as long as at least one port has data.

const STATES = Object.freeze(['ok', 'degraded', 'down', 'unknown']);

// A measured endpoint is healthy when at least half of its recent checks succeeded.
const HEALTHY_SUCCESS_RATE = 0.5;

const isMeasured = (endpoint) => Boolean(endpoint)
  && endpoint.last_checked_at != null
  && Number.isFinite(endpoint.tcp_success_rate_24h);

/** State of one port from its registry candidates. */
const portState = (candidates) => {
  const measured = (Array.isArray(candidates) ? candidates : []).filter(isMeasured);
  if (measured.length === 0) return 'unknown';
  const healthy = measured.filter((e) => e.tcp_success_rate_24h >= HEALTHY_SUCCESS_RATE).length;
  if (healthy === measured.length) return 'ok';
  if (healthy === 0) return 'down';
  return 'degraded';
};

/** Overall state from per-port states; unknown ports do not count as failures. */
const overallState = (portStates) => {
  const known = portStates.filter((s) => s !== 'unknown');
  if (known.length === 0) return 'unknown';
  if (known.every((s) => s === 'ok')) return 'ok';
  if (known.every((s) => s === 'down')) return 'down';
  return 'degraded';
};

const MESSAGES = Object.freeze({
  ok: 'Endpoint health checks pass',
  degraded: 'Some endpoints fail health checks',
  down: 'Endpoint health checks fail',
  unknown: 'No runtime endpoint health data; the built-in endpoint list is used',
});

module.exports = {
  STATES,
  HEALTHY_SUCCESS_RATE,
  isMeasured,
  portState,
  overallState,
  MESSAGES,
};
