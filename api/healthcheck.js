// api/healthcheck.js
const net = require('net');

const PROBE_HOST = 'api.cloudflareclient.com';
const PROBE_PORT = 443;
const PROBE_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 30_000;

let cache = null; // { ok, latencyMs, checkedAt, expiresAt }

const probe = () =>
  new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok, latencyMs: ok ? Date.now() - start : null });
    };

    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    socket.connect(PROBE_PORT, PROBE_HOST, () => finish(true));
    socket.on('error', () => finish(false));
  });

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, message: 'Method not allowed' });
    return;
  }

  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    res.status(200).json({ ok: cache.ok, latencyMs: cache.latencyMs, checkedAt: cache.checkedAt });
    return;
  }

  const { ok, latencyMs } = await probe();
  const checkedAt = new Date().toISOString();
  cache = { ok, latencyMs, checkedAt, expiresAt: now + CACHE_TTL_MS };
  res.status(200).json({ ok, latencyMs, checkedAt });
};
