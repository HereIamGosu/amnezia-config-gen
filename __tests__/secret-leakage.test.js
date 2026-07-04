// __tests__/secret-leakage.test.js
// Verifies that error responses and telemetry/summary do not leak secrets — 2.5.2.
// Secrets: WARP registration token, client private key, raw CPS payload.

'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, test, mock } = require('node:test');
const https = require('node:https');
const net = require('node:net');

const { buildResultSummary } = require('../public/static/result-explanation');

const realNetCreate = net.createConnection.bind(net);

function makeReq(query = {}) {
  return {
    method: 'GET',
    url: '/api/warp?' + new URLSearchParams(query).toString(),
    query,
    body: null,
    socket: { remoteAddress: '10.0.0.4' },
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

// Known-secret sentinel used in the fake WARP registration response.
// If this string appears in any error JSON, a secret leaked.
const SENTINEL_TOKEN = 'super-secret-warp-token-do-not-leak';
const SENTINEL_ID = 'super-secret-device-id-do-not-leak';

function buildWarpResponse(statusCode = 200, overrideToken = SENTINEL_TOKEN) {
  return {
    statusCode,
    body: JSON.stringify({
      result: {
        id: SENTINEL_ID,
        token: overrideToken,
        config: {
          peers: [{ public_key: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=', endpoint: { v4: '162.159.192.1:2408' } }],
          interface: { addresses: { v4: '172.16.0.2', v6: 'fd01::2' } },
        },
      },
    }),
  };
}

// ── Error response leakage ────────────────────────────────────────────────────

describe('secret leakage — error responses', () => {
  test('WARP token does not appear in error JSON when Cloudflare API fails after registration', async () => {
    clearModules();
    let callCount = 0;
    const httpsMock = mock.method(https, 'request', (options, cb) => {
      const fakeRes = new EventEmitter();
      const req = new EventEmitter();
      req.write = () => {};
      req.destroy = () => {};
      req.end = () => setImmediate(() => {
        callCount++;
        if (callCount === 1) {
          // First call (register): succeed with secret token
          fakeRes.statusCode = 200;
          cb(fakeRes);
          fakeRes.emit('data', Buffer.from(buildWarpResponse(200).body));
          fakeRes.emit('end');
        } else {
          // Subsequent calls (PATCH / GET): fail with error
          fakeRes.statusCode = 500;
          cb(fakeRes);
          fakeRes.emit('data', Buffer.from(JSON.stringify({ success: false, errors: [{ message: 'internal error' }] })));
          fakeRes.emit('end');
        }
      });
      return req;
    });
    net.createConnection = (opts, cb_) => { const s = mockNetOk(); if (cb_) setImmediate(cb_); return s; };
    try {
      const handler = require('../api/warp');
      const res = makeRes();
      await handler(makeReq({ mode: 'awg2' }), res);
      const serialized = JSON.stringify(res.getBody());
      assert.doesNotMatch(serialized, new RegExp(SENTINEL_TOKEN), 'WARP token must not appear in error response');
      assert.doesNotMatch(serialized, new RegExp(SENTINEL_ID), 'device ID must not appear in error response');
    } finally {
      httpsMock.mock.restore();
      net.createConnection = realNetCreate;
    }
  });

  test('private key does not appear in any error response', async () => {
    clearModules();
    // Emit error event from req — simulates ECONNREFUSED without TDZ in warp.js
    const httpsMock = mock.method(https, 'request', () => {
      const req = new EventEmitter();
      req.write = () => {};
      req.destroy = () => {};
      req.end = () => setImmediate(() => req.emit('error', new Error('ECONNREFUSED simulated')));
      return req;
    });
    net.createConnection = (opts, cb_) => { const s = mockNetOk(); if (cb_) setImmediate(cb_); return s; };
    try {
      const handler = require('../api/warp');
      const res = makeRes();
      await handler(makeReq({ mode: 'awg2' }), res);
      const serialized = JSON.stringify(res.getBody());
      assert.doesNotMatch(serialized, /PrivateKey/, 'PrivateKey label must not appear in error response');
      assert.doesNotMatch(serialized, /PresharedKey/, 'PresharedKey label must not appear in error response');
    } finally {
      httpsMock.mock.restore();
      net.createConnection = realNetCreate;
    }
  });

  test('rate-limit error does not leak IP or internal state', async () => {
    clearModules();
    const FAKE_WARP = buildWarpResponse(200).body;
    const httpsMock = mock.method(https, 'request', (options, cb) => {
      const fakeRes = new EventEmitter();
      fakeRes.statusCode = 200;
      const req = new EventEmitter();
      req.write = () => {};
      req.destroy = () => {};
      req.end = () => setImmediate(() => { cb(fakeRes); fakeRes.emit('data', Buffer.from(FAKE_WARP)); fakeRes.emit('end'); });
      return req;
    });
    net.createConnection = (opts, cb_) => { const s = mockNetOk(); if (cb_) setImmediate(cb_); return s; };
    try {
      const handler = require('../api/warp');
      for (let i = 0; i < 10; i++) {
        await handler(makeReq({ mode: 'awg2' }), makeRes());
      }
      const res = makeRes();
      await handler(makeReq({ mode: 'awg2' }), res);
      assert.equal(res.getStatus(), 429);
      const serialized = JSON.stringify(res.getBody());
      assert.doesNotMatch(serialized, /10\.0\.0\.4/, 'Client IP must not appear in rate-limit error');
      assert.doesNotMatch(serialized, /PrivateKey|PresharedKey/, 'Key material must not appear in rate-limit error');
    } finally {
      httpsMock.mock.restore();
      net.createConnection = realNetCreate;
    }
  });
});

// ── Summary / telemetry leakage ───────────────────────────────────────────────

describe('secret leakage — buildResultSummary telemetry', () => {
  const FAKE_CONF_TEXT = `[Interface]
PrivateKey = FAKE_PRIVATE_KEY_MUST_NOT_LEAK
Address = 172.16.0.2/32
DNS = 1.1.1.1

[Peer]
PublicKey = FAKE_PUBLIC_KEY
Endpoint = engage.cloudflareclient.com:2408
AllowedIPs = 0.0.0.0/0`;

  const FAKE_CONF_B64 = Buffer.from(FAKE_CONF_TEXT).toString('base64');

  const OPTS = {
    configCount: 1,
    warpEndpoint: 'engage.cloudflareclient.com',
    port: 2408,
    routePresets: [],
    mobileMode: false,
    routerMode: false,
    includeIpv6: false,
    vpnLinkRequested: false,
  };

  test('buildResultSummary does not include config content or PrivateKey', () => {
    const summary = buildResultSummary({
      success: true,
      mode: 'awg2',
      content: FAKE_CONF_B64,
      configs: [{ content: FAKE_CONF_B64, index: 1, endpointSource: 'tcp_check' }],
      count: 1,
    }, OPTS);
    const serialized = JSON.stringify(summary);
    assert.doesNotMatch(serialized, /FAKE_PRIVATE_KEY_MUST_NOT_LEAK/, 'private key must not appear in summary');
    assert.doesNotMatch(serialized, /PrivateKey/, 'PrivateKey label must not appear in summary');
    assert.doesNotMatch(serialized, /\[Interface\]|\[Peer\]/, 'config sections must not appear in summary');
    assert.doesNotMatch(serialized, new RegExp(FAKE_CONF_B64.slice(0, 20)), 'raw base64 content must not appear in summary');
  });

  test('buildResultSummary does not include secrets on partial response', () => {
    const summary = buildResultSummary({
      success: true,
      mode: 'legacy',
      content: FAKE_CONF_B64,
      // configs array missing — partial/degraded response
    }, { ...OPTS, configCount: 2 });
    const serialized = JSON.stringify(summary);
    assert.doesNotMatch(serialized, /FAKE_PRIVATE_KEY_MUST_NOT_LEAK/);
    assert.doesNotMatch(serialized, /PrivateKey/);
  });

  test('buildResultSummary does not include secrets when error warning present', () => {
    const summary = buildResultSummary({
      success: true,
      mode: 'awg2',
      content: FAKE_CONF_B64,
      warning: { message: 'Only 1 of 2 configs generated.', level: 'warning' },
    }, OPTS);
    const serialized = JSON.stringify(summary);
    assert.doesNotMatch(serialized, /FAKE_PRIVATE_KEY_MUST_NOT_LEAK/);
    assert.doesNotMatch(serialized, /PrivateKey/);
  });
});
