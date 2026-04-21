// api/healthcheck.js
const net = require('net');

const PROBE_HOST = 'api.cloudflareclient.com';
const PROBE_PORT = 443;
const PROBE_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 30_000;

let cache = null; // { ok, latencyMs, checkedAt, expiresAt }
let pendingProbe = null;

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

  if (!pendingProbe) {
    pendingProbe = probe().then(({ ok, latencyMs }) => {
      const checkedAt = new Date().toISOString();
      cache = { ok, latencyMs, checkedAt, expiresAt: Date.now() + CACHE_TTL_MS };
      pendingProbe = null;
      return cache;
    });
  }

  const result = await pendingProbe;
  res.status(200).json({ ok: result.ok, latencyMs: result.latencyMs, checkedAt: result.checkedAt });
};
