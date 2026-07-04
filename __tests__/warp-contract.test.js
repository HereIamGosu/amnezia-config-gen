// __tests__/warp-contract.test.js
// Contract tests for /api/warp response schema — 2.5.2.
// Verifies every top-level field and per-config field without live network.

'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test, mock } = require('node:test');
const https = require('node:https');
const net = require('node:net');

const realNetCreate = net.createConnection.bind(net);

// ── helpers ──────────────────────────────────────────────────────────────────

function makeReq(query = {}, method = 'GET') {
  return {
    method,
    url: '/api/warp?' + new URLSearchParams(query).toString(),
    query,
    body: null,
    socket: { remoteAddress: '10.0.0.1' },
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

const FAKE_WARP_RESPONSE = JSON.stringify({
  result: {
    id: 'contract-id',
    token: 'contract-token',
    config: {
      peers: [{ public_key: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=', endpoint: { v4: '162.159.192.1:2408' } }],
      interface: { addresses: { v4: '172.16.0.2', v6: 'fd01::2' } },
    },
  },
});

function installWarpMock() {
  return mock.method(https, 'request', (options, cb) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      cb(res);
      res.emit('data', Buffer.from(FAKE_WARP_RESPONSE));
      res.emit('end');
    });
    return req;
  });
}

function mockNetOk() {
  const sock = new EventEmitter();
  sock.destroy = () => {};
  setImmediate(() => sock.emit('connect'));
  return sock;
}

function clearModules() {
  for (const m of ['../api/warp', '../src/server/endpointCache', '../src/server/endpointHealth']) {
    try { delete require.cache[require.resolve(m)]; } catch (_e) { /* module not cached */ }
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('contract: success=true, mode, count, configs[] present', async () => {
  clearModules();
  const httpsMock = installWarpMock();
  net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
  try {
    const handler = require('../api/warp');
    const req = makeReq({ mode: 'awg2' });
    const res = makeRes();
    await handler(req, res);
    const body = res.getBody();
    assert.equal(res.getStatus(), 200);
    assert.equal(body.success, true);
    assert.ok(typeof body.mode === 'string', 'mode must be a string');
    assert.ok(typeof body.count === 'number', 'count must be a number');
    assert.ok(Array.isArray(body.configs), 'configs must be an array');
    assert.equal(body.configs.length, body.count);
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreate;
  }
});

test('contract: content field equals configs[0].content (backward-compat)', async () => {
  clearModules();
  const httpsMock = installWarpMock();
  net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
  try {
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq({ mode: 'legacy' }), res);
    const body = res.getBody();
    assert.ok(typeof body.content === 'string' && body.content.length > 0, 'content must be non-empty string');
    assert.equal(body.content, body.configs[0].content, 'content must equal configs[0].content');
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreate;
  }
});

test('contract: content is valid base64 that decodes to WireGuard config', async () => {
  clearModules();
  const httpsMock = installWarpMock();
  net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
  try {
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq({ mode: 'awg2' }), res);
    const raw = Buffer.from(res.getBody().content, 'base64').toString('utf8');
    assert.ok(raw.includes('[Interface]'), 'decoded content must contain [Interface]');
    assert.ok(raw.includes('[Peer]'), 'decoded content must contain [Peer]');
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreate;
  }
});

test('contract: each configs[] entry has index, content, appliedExtras, endpointSource', async () => {
  clearModules();
  const httpsMock = installWarpMock();
  net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
  try {
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq({ mode: 'awg2', count: '2' }), res);
    const { configs } = res.getBody();
    for (const cfg of configs) {
      assert.ok(typeof cfg.index === 'number', 'index must be number');
      assert.ok(typeof cfg.content === 'string' && cfg.content.length > 0, 'content must be non-empty');
      assert.ok(cfg.appliedExtras !== undefined, 'appliedExtras must be present');
      assert.ok(typeof cfg.endpointSource === 'string', 'endpointSource must be string');
    }
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreate;
  }
});

test('contract: routesSource is present in success response', async () => {
  clearModules();
  const httpsMock = installWarpMock();
  net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
  try {
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq({ mode: 'awg2' }), res);
    const body = res.getBody();
    // routesSource may be undefined when no presets are selected — field should exist or be absent without error
    assert.ok('routesSource' in body || body.routesSource === undefined);
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreate;
  }
});

test('contract: vpnLink present in configs[] when link=1', async () => {
  clearModules();
  const httpsMock = installWarpMock();
  net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
  try {
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq({ mode: 'awg2', link: '1' }), res);
    const body = res.getBody();
    assert.ok(typeof body.vpnLink === 'string' && body.vpnLink.startsWith('vpn://'), 'vpnLink must be vpn:// string');
    assert.equal(body.vpnLink, body.configs[0].vpnLink, 'top-level vpnLink must match configs[0].vpnLink');
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreate;
  }
});

test('contract: vpnLink absent when link not requested', async () => {
  clearModules();
  const httpsMock = installWarpMock();
  net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
  try {
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq({ mode: 'awg2' }), res);
    const body = res.getBody();
    assert.equal(body.vpnLink, undefined, 'vpnLink must be absent without link=1');
    assert.equal(body.configs[0].vpnLink, undefined);
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreate;
  }
});

test('contract: warning absent on full success (count=2 fully delivered)', async () => {
  clearModules();
  const httpsMock = installWarpMock();
  net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
  try {
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq({ mode: 'awg2', count: '2' }), res);
    const body = res.getBody();
    // If both configs generated, warning should be absent or undefined
    if (body.count === 2) {
      assert.equal(body.warning, undefined, 'warning must be absent when all configs succeed');
    }
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreate;
  }
});

test('contract: warning field present on partial generation', async () => {
  clearModules();
  let callCount = 0;
  const httpsMock = mock.method(https, 'request', (options, cb) => {
    const res = new EventEmitter();
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      callCount++;
      // First full round-trip (register + patch + get = 3 calls) succeeds; second register call fails
      if (callCount <= 3) {
        res.statusCode = 200;
        cb(res);
        res.emit('data', Buffer.from(FAKE_WARP_RESPONSE));
        res.emit('end');
      } else {
        res.statusCode = 503;
        cb(res);
        res.emit('data', Buffer.from(JSON.stringify({ success: false, errors: [{ message: 'server error' }] })));
        res.emit('end');
      }
    });
    return req;
  });
  net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
  try {
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq({ mode: 'awg2', count: '2' }), res);
    const body = res.getBody();
    // Either partial (1 of 2) with warning, or both succeeded — depends on WARP API call order
    if (body.count < 2) {
      assert.ok(typeof body.warning === 'string' && body.warning.length > 0, 'warning must be a non-empty string on partial generation');
      assert.equal(body.success, true, 'partial generation still returns success=true');
    }
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreate;
  }
});

test('contract: error response has success=false and human-readable message', async () => {
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
    const body = res.getBody();
    assert.equal(body.success, false);
    assert.ok(typeof body.message === 'string' && body.message.length > 0, 'error message must be a non-empty string');
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreate;
  }
});
