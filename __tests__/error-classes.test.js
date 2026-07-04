// __tests__/error-classes.test.js
// Error-class contract tests for /api/warp — 2.5.2.
// Covers: validation, Cloudflare API, rate-limit, method, bad-JSON, unknown.

'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test, mock } = require('node:test');
const https = require('node:https');
const net = require('node:net');

const realNetCreate = net.createConnection.bind(net);

function makeReq(query = {}, method = 'GET', body = null) {
  return {
    method,
    url: '/api/warp?' + new URLSearchParams(query).toString(),
    query,
    body,
    socket: { remoteAddress: '10.0.0.2' },
    headers: {},
  };
}

function makeRes() {
  let status = 200;
  let body = null;
  const hdrs = {};
  const res = {
    setHeader(k, v) { hdrs[k] = v; },
    status(code) { status = code; return res; },
    json(data) { body = data; return res; },
    getStatus: () => status,
    getBody: () => body,
    getHeader: (k) => hdrs[k],
  };
  return res;
}

function mockNetOk() {
  const sock = new EventEmitter();
  sock.destroy = () => {};
  setImmediate(() => sock.emit('connect'));
  return sock;
}

function clearModules() {
  for (const m of ['../api/warp', '../src/server/endpointCache', '../src/server/endpointHealth', '../src/server/_rateLimit']) {
    try { delete require.cache[require.resolve(m)]; } catch (_e) { /* module not cached */ }
  }
}

// ── Validation errors ─────────────────────────────────────────────────────────

test('error/validation: disallowed port → 400, success=false, allowedPorts array', async () => {
  clearModules();
  const httpsMock = mock.method(https, 'request', () => { throw new Error('should not reach network'); });
  net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
  try {
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq({ mode: 'awg2', port: '9999' }), res);
    assert.equal(res.getStatus(), 400);
    const body = res.getBody();
    assert.equal(body.success, false);
    assert.ok(Array.isArray(body.allowedPorts), 'allowedPorts must be an array');
    assert.ok(body.allowedPorts.length > 0, 'allowedPorts must be non-empty');
    assert.ok(typeof body.error === 'string', 'error description must be a string');
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreate;
  }
});

test('error/validation: method not allowed → 405, success=false', async () => {
  clearModules();
  try {
    const handler = require('../api/warp');
    const res = makeRes();
    const req = makeReq({}, 'DELETE');
    await handler(req, res);
    assert.equal(res.getStatus(), 405);
    const body = res.getBody();
    assert.equal(body.success, false);
    assert.ok(typeof body.message === 'string');
  } finally { /* no teardown needed */ }
});

test('error/validation: bad JSON body on POST → 400, success=false', async () => {
  clearModules();
  const { EventEmitter: EE } = require('node:events');
  const handler = require('../api/warp');
  const res = makeRes();

  // Build a POST req that emits bad JSON data
  const req = new EE();
  req.method = 'POST';
  req.url = '/api/warp';
  req.query = {};
  req.body = null; // body=null forces the readRequestJson path
  req.socket = { remoteAddress: '10.0.0.3' };
  req.headers = {};

  const handlerPromise = handler(req, res);
  setImmediate(() => {
    req.emit('data', Buffer.from('NOT_VALID_JSON{{{'));
    req.emit('end');
  });
  await handlerPromise;

  assert.equal(res.getStatus(), 400);
  assert.equal(res.getBody().success, false);
  assert.ok(typeof res.getBody().message === 'string');
});

// ── Cloudflare API errors ─────────────────────────────────────────────────────

test('error/cloudflare-api: 403 from WARP registration → non-200 with success=false', async () => {
  clearModules();
  const httpsMock = mock.method(https, 'request', (options, cb) => {
    const res = new EventEmitter();
    res.statusCode = 403;
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      cb(res);
      res.emit('data', Buffer.from(JSON.stringify({ success: false, errors: [{ message: 'forbidden' }] })));
      res.emit('end');
    });
    return req;
  });
  net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
  try {
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq({ mode: 'awg2' }), res);
    assert.notEqual(res.getStatus(), 200);
    const body = res.getBody();
    assert.equal(body.success, false);
    assert.ok(typeof body.message === 'string' && body.message.length > 0);
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreate;
  }
});

test('error/cloudflare-api: 503 from WARP API → 5xx with success=false', async () => {
  clearModules();
  const httpsMock = mock.method(https, 'request', (options, cb) => {
    const res = new EventEmitter();
    res.statusCode = 503;
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      cb(res);
      res.emit('data', Buffer.from('Service Unavailable'));
      res.emit('end');
    });
    return req;
  });
  net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
  try {
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq({ mode: 'legacy' }), res);
    assert.ok(res.getStatus() >= 500, `expected 5xx, got ${res.getStatus()}`);
    assert.equal(res.getBody().success, false);
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreate;
  }
});

// ── Rate-limit error ──────────────────────────────────────────────────────────

test('error/rate-limit: 10 requests exhaust limit → 429 with Retry-After', async () => {
  clearModules();
  const FAKE_WARP = JSON.stringify({
    result: {
      id: 'rl-id', token: 'rl-token',
      config: {
        peers: [{ public_key: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=', endpoint: { v4: '162.159.192.1:2408' } }],
        interface: { addresses: { v4: '172.16.0.2', v6: 'fd01::2' } },
      },
    },
  });
  const httpsMock = mock.method(https, 'request', (options, cb) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => setImmediate(() => { cb(res); res.emit('data', Buffer.from(FAKE_WARP)); res.emit('end'); });
    return req;
  });
  net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
  try {
    const handler = require('../api/warp');

    // Exhaust 10 allowed requests from the same IP
    for (let i = 0; i < 10; i++) {
      const res = makeRes();
      await handler(makeReq({ mode: 'awg2' }), res);
    }

    // 11th request must be rate-limited
    const res = makeRes();
    await handler(makeReq({ mode: 'awg2' }), res);
    assert.equal(res.getStatus(), 429);
    const body = res.getBody();
    assert.equal(body.success, false);
    assert.ok(typeof body.message === 'string' && body.message.length > 0);
    assert.ok(res.getHeader('Retry-After') !== undefined, 'Retry-After header must be set');
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreate;
  }
});

// ── Unknown / unexpected error ────────────────────────────────────────────────

test('error/unknown: unexpected throw → 500, success=false, human-readable message', async () => {
  clearModules();
  // Emit 'error' event from the request object — simulates ECONNREFUSED without TDZ in warp.js
  const httpsMock = mock.method(https, 'request', () => {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => setImmediate(() => req.emit('error', new Error('ECONNREFUSED simulated')));
    return req;
  });
  net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
  try {
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq({ mode: 'awg2' }), res);
    assert.equal(res.getStatus(), 500);
    const body = res.getBody();
    assert.equal(body.success, false);
    assert.ok(typeof body.message === 'string' && body.message.length > 0);
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreate;
  }
});
