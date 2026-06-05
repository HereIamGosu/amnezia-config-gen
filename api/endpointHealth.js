// api/endpointHealth.js
// TCP latency pre-check for WARP endpoints.
// Uses net.createConnection (TCP SYN) — reliable in Vercel serverless (unlike UDP).
// UDP probing (dgram) is intentionally omitted — unreliable in Vercel serverless.

const net = require('net');

const DEFAULT_TIMEOUT_MS = 700;

/**
 * Open a TCP connection to ip:port, measure latency to SYN-ACK, then destroy.
 * @param {string} ip
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<{ success: boolean, latency_ms: number|null }>}
 */
const checkTcpLatency = (ip, port, timeoutMs = DEFAULT_TIMEOUT_MS) =>
  new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const finish = (success, latency_ms) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ success, latency_ms });
    };

    const timer = setTimeout(() => finish(false, null), timeoutMs);

    const sock = net.createConnection({ host: ip, port }, () => {
      finish(true, Date.now() - start);
    });
    sock.on('error', () => finish(false, null));
    sock.on('timeout', () => finish(false, null));
    // No data expected — destroy immediately after connect
    sock.on('connect', () => { try { sock.destroy(); } catch { /* ignore */ } });
  });

/**
 * From an array of endpoint candidates, return the one with the lowest
 * successful TCP latency, or null if all failed.
 * @param {Array<{ success: boolean, latency_ms: number|null, endpoint: object }>} results
 * @returns {object|null}
 */
const pickBestEndpoint = (results) => {
  const successful = results.filter((r) => r.success && r.latency_ms != null);
  if (!successful.length) return null;
  return successful.reduce((best, r) => (r.latency_ms < best.latency_ms ? r : best)).endpoint;
};

module.exports = { checkTcpLatency, pickBestEndpoint };
