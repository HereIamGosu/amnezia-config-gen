// api/healthcheck.js
const net = require('net');

const PROBE_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 30_000;

const TARGETS = {
  api:    { host: 'api.cloudflareclient.com',    port: 443 },
  engage: { host: 'engage.cloudflareclient.com', port: 443 },
};

let cache = null; // { services, checkedAt, expiresAt }
let pendingProbe = null;

const probeOne = (host, port) =>
  new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, latencyMs: ok ? Date.now() - start : null });
    };

    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    try {
      socket.connect(port, host, () => finish(true));
    } catch {
      finish(false);
    }
    socket.on('error', () => finish(false));
  });

const probeAll = async () => {
  const [api, engage] = await Promise.all([
    probeOne(TARGETS.api.host, TARGETS.api.port),
    probeOne(TARGETS.engage.host, TARGETS.engage.port),
  ]);
  return { api, engage };
};

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, message: 'Method not allowed' });
    return;
  }

  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    res.status(200).json({ services: cache.services, checkedAt: cache.checkedAt });
    return;
  }

  if (!pendingProbe) {
    pendingProbe = probeAll()
      .then((services) => {
        const checkedAt = new Date().toISOString();
        cache = { services, checkedAt, expiresAt: Date.now() + CACHE_TTL_MS };
        pendingProbe = null;
        return cache;
      })
      .catch((err) => {
        pendingProbe = null;
        throw err;
      });
  }

  try {
    const result = await pendingProbe;
    res.status(200).json({ services: result.services, checkedAt: result.checkedAt });
  } catch {
    res.status(500).json({ error: 'Probe failed' });
  }
};
