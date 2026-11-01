// __tests__/helpers/warp-harness.js
// Runs the real /api/warp handler without network: Cloudflare registration answered by a fake, TCP pre-checks
// succeed, and Lab Auto reads a LabEndpointProvider built from an in-memory active-pool.json (schema 2).

'use strict';

const { EventEmitter } = require('node:events');
const { mock } = require('node:test');
const https = require('node:https');
const net = require('node:net');
const { LabEndpointProvider } = require('../../src/server/endpointProvider');

const FAKE_WARP_RESPONSE = JSON.stringify({
  result: {
    id: 'harness-id',
    token: 'harness-token',
    config: {
      peers: [{ public_key: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=', endpoint: { v4: '162.159.192.1:2408' } }],
      interface: { addresses: { v4: '172.16.0.2', v6: 'fd01::2' } },
    },
  },
});

/**
 * A registration answer with placeholder secrets (a one-letter token, a peer key of 32 bytes of 0x01).
 * `v6: null` leaves the IPv6 address out; `result` overrides the whole `result` object.
 */
const registrationAnswer = ({ v4 = '172.16.0.2', v6 = 'fd01::2', id = 'harness-id', token = 't', result } = {}) => ({
  status: 200,
  body: JSON.stringify({
    result: result ?? {
      id,
      token,
      config: {
        peers: [{ public_key: Buffer.alloc(32, 1).toString('base64'), endpoint: { v4: '162.159.192.1:2408' } }],
        interface: { addresses: v6 === null ? { v4 } : { v4, v6 } },
      },
    },
  }),
});

/** `cloudflare` of `generate`: one answer for every request, a list used in order (the last repeats) or a function. */
const answerFor = (cloudflare, n, request) => {
  if (typeof cloudflare === 'function') return cloudflare(n, request);
  if (Array.isArray(cloudflare)) return cloudflare[Math.min(n, cloudflare.length) - 1];
  return cloudflare;
};

const chunksOf = (body) => (Array.isArray(body) ? body : [typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)]);

const NOW = Date.parse('2026-10-05T21:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** One active-pool.json endpoint, verified `verifiedAgo` s before `now`, expiring `expiresIn` s after it. */
const labEndpoint = (ip, port, { verifiedAgo = 60, expiresIn = 360, now = NOW } = {}) => ({
  ip, port, family: 4, state: 'active', lab_verified_at: iso(now - verifiedAgo * 1000),
  expires_at: iso(now + expiresIn * 1000), source_class: 'consumer_official_seed',
  probe_completion_ms: 80, traffic_total_ms: 60,
});

const labSnapshot = (endpoints, overrides = {}, now = NOW) => ({
  schema_version: 2, generated_at: iso(now - 20000), expires_at: iso(now + 160000), lab_status: 'ok',
  active_count: endpoints.length, endpoints, ...overrides,
});

const LAB_POOL = [
  labEndpoint('162.159.192.11', 2408), labEndpoint('162.159.192.12', 500), labEndpoint('162.159.192.13', 1701),
  labEndpoint('162.159.192.14', 4500), labEndpoint('162.159.195.21', 2408), labEndpoint('188.114.96.31', 4500),
  labEndpoint('188.114.97.41', 500), labEndpoint('162.159.204.51', 1701),
];

/**
 * Lab provider over a fixed file body. `clock` is a mutable { now } so a test can move time during a request;
 * `calls` counts selections and file reads.
 */
const labProvider = (doc, { clock = { now: NOW }, missing = false, random = Math.random } = {}) => {
  const text = typeof doc === 'string' ? doc : JSON.stringify(doc);
  const calls = { select: 0, read: 0 };
  const provider = new LabEndpointProvider({
    path: '/run/endpoint-lab/active-pool.json',
    now: () => clock.now,
    stat: () => {
      if (missing) throw Object.assign(new Error('ENOENT: no such file or directory, stat /run/endpoint-lab/active-pool.json'), { code: 'ENOENT' });
      return { mtimeMs: 1, size: Buffer.byteLength(text) };
    },
    readFile: () => { calls.read += 1; return text; },
    random,
  });
  const select = provider.selectForGeneration.bind(provider);
  provider.selectForGeneration = (req) => { calls.select += 1; return select(req); };
  return { provider, calls, clock };
};

function makeReq(query = {}, method = 'GET', body = null) {
  return { method, url: `/api/warp?${new URLSearchParams(query)}`, query, body, socket: { remoteAddress: '10.0.0.1' }, headers: {} };
}

function makeRes() {
  let status = 200;
  let body = null;
  const headers = {};
  const res = {
    setHeader(k, v) { headers[k] = v; },
    status(code) { status = code; return res; },
    json(data) { body = data; return res; },
    getStatus: () => status,
    getBody: () => body,
    getHeader: (k) => headers[k],
  };
  return res;
}

/**
 * One handler call on a fresh module. Returns status, body, headers, decoded configs, the number of
 * Cloudflare API requests made (0 proves nothing was registered) and those requests (method, host, port, path,
 * agent, headers in order, written body).
 *
 * `cloudflare` answers the API requests (default: 200 with `FAKE_WARP_RESPONSE` to every one). An answer is
 * `{ status, body, headers }` (`body` a string, an object sent as JSON or a list of chunks; without `headers`
 * the fake response has none, like the other fakes), `{ error: 'ECODE' }` (the request fails as an unreachable
 * host does) or `'hang'` (never answers). `cloudflare` is one answer, a list used in order (the last repeats)
 * or `(n, request) => answer` for the n-th request, counted from 1.
 * @param {Record<string,string>} query
 * @param {{ lab?: { provider: object } | null, shadow?: object|null, method?: string, body?: object|null,
 *   onRegistration?: () => void, cloudflare?: object|string|Array|Function }} [opts]
 */
async function generate(query, {
  lab = null, shadow = null, method = 'GET', body = null, onRegistration = null,
  cloudflare = { status: 200, body: FAKE_WARP_RESPONSE },
} = {}) {
  delete require.cache[require.resolve('../../api/warp')];
  let apiCalls = 0;
  const requests = [];
  const httpsMock = mock.method(https, 'request', (options, cb) => {
    const request = {
      method: options.method, hostname: options.hostname, port: options.port, path: options.path, agent: options.agent,
      headers: { ...options.headers }, body: '',
    };
    requests.push(request);
    const req = new EventEmitter();
    req.write = (chunk) => { request.body += chunk; };
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      apiCalls += 1;
      if (onRegistration) onRegistration(apiCalls);
      const answer = answerFor(cloudflare, apiCalls, request);
      if (answer === 'hang') return;
      if (answer.error) {
        req.emit('error', Object.assign(new Error(`connect ${answer.error}`), { code: answer.error }));
        return;
      }
      const res = new EventEmitter();
      res.statusCode = answer.status ?? 200;
      if (answer.headers) res.headers = answer.headers;
      cb(res);
      for (const chunk of chunksOf(answer.body ?? '')) res.emit('data', Buffer.from(chunk));
      res.emit('end');
    });
    return req;
  });
  const realNet = net.createConnection;
  net.createConnection = (o, cb) => {
    const s = new EventEmitter();
    s.destroy = () => {};
    setImmediate(() => s.emit('connect'));
    if (cb) setImmediate(cb);
    return s;
  };
  try {
    const handler = require('../../api/warp');
    handler.__internals.setEndpointShadow(shadow);
    handler.__internals.setLabProvider(lab ? lab.provider : null);
    const res = makeRes();
    await handler(makeReq(query, method, body), res);
    const out = res.getBody();
    const configs = out && Array.isArray(out.configs)
      ? out.configs.map((c) => Buffer.from(c.content, 'base64').toString('utf8'))
      : [];
    return { status: res.getStatus(), body: out, headers: res, configs, apiCalls, requests };
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNet;
  }
}

/** `Endpoint = host:port` of a rendered config. */
const endpointOf = (conf) => /^Endpoint = (.+)$/m.exec(conf)[1];

/** Ordered [key, value] pairs of every `Key = value` line, per section. */
const parseConf = (conf) => {
  const sections = [];
  for (const line of conf.split('\n')) {
    const header = /^\[(\w+)\]$/.exec(line);
    if (header) { sections.push({ name: header[1], fields: [] }); continue; }
    const kv = /^([A-Za-z0-9]+) = (.*)$/.exec(line);
    if (kv && sections.length) sections[sections.length - 1].fields.push([kv[1], kv[2]]);
  }
  return sections;
};

module.exports = {
  FAKE_WARP_RESPONSE,
  registrationAnswer,
  NOW,
  iso,
  labEndpoint,
  labSnapshot,
  LAB_POOL,
  labProvider,
  generate,
  endpointOf,
  parseConf,
};
