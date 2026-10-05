// api/lab.js
// Public, read-only Endpoint Lab data for /lab: GET /api/lab (overview) and
// GET /api/lab?endpoint=<ip:port>&range=all|24h|7d|30d (one endpoint). Never controls the Lab.
//
// Reads only the Lab's secret-free public directory, mounted read-only by the deploy controller at
// /run/endpoint-lab. ENDPOINT_LAB_PUBLIC_DIR (absolute path, process environment at start-up) overrides it
// for local runs and tests; no request ever chooses a path. Without the files (Vercel, forks, Lab not
// mounted) the answer is 503 lab_not_available and the generator is unaffected: its page learns that from
// /api/status (lab.available) and does not ask.

'use strict';

const {
  LabDataError, RANGES, RETRY_AFTER_S, canonicalEndpointId, resolvePublicDir, loadOverview, loadEndpoint,
} = require('../src/server/labPublic');

const send = (req, res, status, body, extraHeaders = {}) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  const text = JSON.stringify(body);
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(req.method === 'HEAD' ? undefined : text);
};

const fail = (req, res, status, code) => send(req, res, status, { success: false, code },
  status === 503 ? { 'Retry-After': String(RETRY_AFTER_S) } : {});

const queryValue = (query, key) => {
  const v = query ? query[key] : undefined;
  return Array.isArray(v) ? null : v;
};

/** Handler factory: the directory is fixed when the server starts (tests pass their own). */
const createLabHandler = ({ dir = resolvePublicDir(process.env.ENDPOINT_LAB_PUBLIC_DIR), now = Date.now } = {}) => (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    fail(req, res, 405, 'method_not_allowed');
    return;
  }
  const query = req.query || {};
  const rawEndpoint = queryValue(query, 'endpoint');
  const rawRange = queryValue(query, 'range');
  try {
    if (rawEndpoint === undefined) {
      send(req, res, 200, loadOverview(dir, now()));
      return;
    }
    const id = canonicalEndpointId(rawEndpoint);
    if (!id) {
      fail(req, res, 400, 'endpoint_invalid');
      return;
    }
    const range = rawRange === undefined ? 'all' : rawRange;
    if (typeof range !== 'string' || !Object.prototype.hasOwnProperty.call(RANGES, range)) {
      fail(req, res, 400, 'range_invalid');
      return;
    }
    const detail = loadEndpoint(dir, id, range, now());
    if (!detail) {
      fail(req, res, 404, 'endpoint_not_found');
      return;
    }
    send(req, res, 200, detail);
  } catch (err) {
    if (err instanceof LabDataError) {
      fail(req, res, 503, err.code);
      return;
    }
    fail(req, res, 503, 'lab_not_available');
  }
};

const handler = createLabHandler();
handler.createLabHandler = createLabHandler;
module.exports = handler;
