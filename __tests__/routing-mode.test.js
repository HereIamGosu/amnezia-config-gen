// __tests__/routing-mode.test.js
'use strict';

const assert = require('node:assert/strict');
const { test, describe } = require('node:test');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const net = require('node:net');

const realNetCreate = net.createConnection.bind(net);

function makeReq(query = {}) {
  return {
    method: 'GET',
    url: '/api/warp?' + new URLSearchParams(query).toString(),
    query,
    body: null,
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
  };
}

function makeRes() {
  let status = 200;
  let body = null;
  const res = {
    setHeader() {},
    status(code) { status = code; return res; },
    json(data) { body = data; return res; },
    getStatus: () => status,
    getBody: () => body,
  };
  return res;
}

function clearModules() {
  for (const m of ['../api/warp', '../src/server/endpointCache', '../src/server/endpointHealth']) {
    try { delete require.cache[require.resolve(m)]; } catch (_e) { /* module not cached */ }
  }
}

describe('routeMode validation — early 400 returns (no WARP mock needed)', () => {
  test('routeMode=invalid → 400 invalid_route_mode', async () => {
    clearModules();
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq({ mode: 'awg2', routeMode: 'bogus' }), res);
    assert.equal(res.getStatus(), 400);
    const body = res.getBody();
    assert.equal(body.success, false);
    assert.equal(body.error, 'invalid_route_mode');
    assert.ok(Array.isArray(body.allowedRouteModes));
    assert.ok(body.allowedRouteModes.includes('full'));
    assert.ok(body.allowedRouteModes.includes('split'));
  });

  test('routeMode=split + no presets → 400 empty_split_tunnel', async () => {
    clearModules();
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq({ mode: 'awg2', routeMode: 'split' }), res);
    assert.equal(res.getStatus(), 400);
    const body = res.getBody();
    assert.equal(body.success, false);
    assert.equal(body.error, 'empty_split_tunnel');
    assert.ok(typeof body.message === 'string' && body.message.length > 0);
  });
});

const FAKE_WARP = JSON.stringify({
  result: {
    id: 'rt-id', token: 'rt-token',
    config: {
      peers: [{ public_key: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=', endpoint: { v4: '162.159.192.1:2408' } }],
      interface: { addresses: { v4: '172.16.0.2', v6: 'fd01::2' } },
    },
  },
});

function installWarpMock() {
  const { mock } = require('node:test');
  return mock.method(https, 'request', (_opts, cb) => {
    const fakeRes = new EventEmitter();
    fakeRes.statusCode = 200;
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      cb(fakeRes);
      fakeRes.emit('data', Buffer.from(FAKE_WARP));
      fakeRes.emit('end');
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

describe('routeMode validation — positive paths (WARP mock)', () => {
  test('no routeMode + no presets → 200 (legacy full tunnel)', async () => {
    clearModules();
    const m = installWarpMock();
    net.createConnection = (_o, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
    try {
      const handler = require('../api/warp');
      const res = makeRes();
      await handler(makeReq({ mode: 'awg2' }), res);
      assert.equal(res.getStatus(), 200);
      assert.equal(res.getBody().success, true);
    } finally { m.mock.restore(); net.createConnection = realNetCreate; }
  });

  test('routeMode=full + no presets → 200', async () => {
    clearModules();
    const m = installWarpMock();
    net.createConnection = (_o, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
    try {
      const handler = require('../api/warp');
      const res = makeRes();
      await handler(makeReq({ mode: 'awg2', routeMode: 'full' }), res);
      assert.equal(res.getStatus(), 200);
      const body = res.getBody();
      assert.equal(body.success, true);
      assert.equal(body.routeMode, 'full');
    } finally { m.mock.restore(); net.createConnection = realNetCreate; }
  });

  test('routeMode=full + presets sent → response routeMode is full (presets ignored in AllowedIPs)', async () => {
    clearModules();
    const m = installWarpMock();
    net.createConnection = (_o, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
    try {
      const handler = require('../api/warp');
      const res = makeRes();
      await handler(makeReq({ mode: 'awg2', routeMode: 'full', presets: 'youtube' }), res);
      assert.equal(res.getStatus(), 200);
      assert.equal(res.getBody().routeMode, 'full');
    } finally { m.mock.restore(); net.createConnection = realNetCreate; }
  });

  test('no routeMode + presets → 200 (legacy split behavior)', async () => {
    clearModules();
    const m = installWarpMock();
    net.createConnection = (_o, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
    try {
      const handler = require('../api/warp');
      const res = makeRes();
      await handler(makeReq({ mode: 'awg2', presets: 'telegram' }), res);
      assert.equal(res.getStatus(), 200);
      assert.equal(res.getBody().success, true);
    } finally { m.mock.restore(); net.createConnection = realNetCreate; }
  });
});
