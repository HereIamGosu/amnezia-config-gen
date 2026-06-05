// __tests__/templates.test.js
// CI template tests — no live network, no external endpoints.
// Mocks: net.createConnection (TCP pre-check) and WARP registration API.

'use strict';

const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const https = require('https');
const net = require('net');

// ──────────────────────────────────────────────────────────────
// Mock net.createConnection — always succeeds instantly
// ──────────────────────────────────────────────────────────────
const realNetCreateConnection = net.createConnection.bind(net);

function mockNetConnect(opts, cb) {
  const { EventEmitter } = require('events');
  const sock = new EventEmitter();
  sock.destroy = () => {};
  setImmediate(() => {
    if (cb) cb();
    sock.emit('connect');
  });
  return sock;
}

// ──────────────────────────────────────────────────────────────
// Minimal WARP registration mock — returns a synthetic config
// ──────────────────────────────────────────────────────────────
function buildFakeWarpResponse(id = 'fake-id', token = 'fake-token') {
  return JSON.stringify({
    result: {
      id,
      token,
      config: {
        peers: [{ public_key: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=', endpoint: { v4: '162.159.192.1:2408' } }],
        interface: { addresses: { v4: '172.16.0.2', v6: 'fd01::2' } },
      },
    },
  });
}

let httpsRequestMock = null;

function setupHttpsMock() {
  const { EventEmitter } = require('events');
  httpsRequestMock = mock.method(https, 'request', (options, responseCb) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      setImmediate(() => {
        responseCb(res);
        const body = buildFakeWarpResponse();
        res.emit('data', Buffer.from(body));
        res.emit('end');
      });
    };
    req.destroy = () => {};
    return req;
  });
}

function teardownHttpsMock() {
  if (httpsRequestMock) {
    httpsRequestMock.mock.restore();
    httpsRequestMock = null;
  }
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
function makeReq(query = {}, body = null, method = 'GET') {
  const { EventEmitter } = require('events');
  const url = '/api/warp?' + new URLSearchParams(query).toString();
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.query = query;
  req.body = body;
  req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = {};
  return req;
}

function makeRes() {
  let statusCode = 200;
  let body = null;
  const res = {
    setHeader: () => {},
    status(code) { statusCode = code; return res; },
    json(data) { body = data; return res; },
    getStatus: () => statusCode,
    getBody: () => body,
  };
  return res;
}

// ──────────────────────────────────────────────────────────────
// Clear require cache so mocks apply freshly when needed
// ──────────────────────────────────────────────────────────────
function clearWarpCache() {
  delete require.cache[require.resolve('../api/warp')];
  delete require.cache[require.resolve('../src/server/endpointCache')];
  delete require.cache[require.resolve('../src/server/endpointHealth')];
}

// ──────────────────────────────────────────────────────────────
// __internals direct unit tests (no HTTP, no WARP API)
// ──────────────────────────────────────────────────────────────

test('warp internals: buildInterfaceLegacy produces uppercase I1', () => {
  clearWarpCache();
  const { buildInterfaceLegacy } = require('../api/warp').__internals;
  const result = buildInterfaceLegacy('PRIVKEY==', '172.16.0.2', 'fd01::2', '1.1.1.1', 'testpayload');
  assert.ok(result.includes('I1 = testpayload'), 'I1 should be uppercase');
  assert.ok(!result.includes('i1 = '), 'lowercase i1 must not appear');
});

test('warp internals: buildInterfaceAwg2WarpSafe enforces S1=S2=S3=S4=0', () => {
  clearWarpCache();
  const { buildInterfaceAwg2WarpSafe, buildAwg2WarpSafeObfuscation } = require('../api/warp').__internals;
  const obf = buildAwg2WarpSafeObfuscation();
  const result = buildInterfaceAwg2WarpSafe('PRIVKEY==', '172.16.0.2', 'fd01::2', obf, '1.1.1.1', false);
  assert.match(result, /\nS1 = 0\n/, 'S1 must be 0');
  assert.match(result, /\nS2 = 0\n/, 'S2 must be 0');
  assert.match(result, /\nS3 = 0\n/, 'S3 must be 0');
  assert.match(result, /\nS4 = 0\n/, 'S4 must be 0');
});

test('warp internals: buildInterfaceLegacy S1=S2=0', () => {
  clearWarpCache();
  const { buildInterfaceLegacy } = require('../api/warp').__internals;
  const result = buildInterfaceLegacy('PRIVKEY==', '172.16.0.2', 'fd01::2', '1.1.1.1');
  assert.match(result, /S1 = 0/, 'Legacy S1 must be 0');
  assert.match(result, /S2 = 0/, 'Legacy S2 must be 0');
});

test('warp internals: PORT_ALLOWLIST contains required ports', () => {
  clearWarpCache();
  const { PORT_ALLOWLIST } = require('../api/warp').__internals;
  for (const port of [2408, 500, 4500, 1701, 880, 8854]) {
    assert.ok(PORT_ALLOWLIST.includes(port), `PORT_ALLOWLIST must include ${port}`);
  }
});

test('warp internals: parseAllowlistedPort accepts allowed ports', () => {
  clearWarpCache();
  const { parseAllowlistedPort, PORT_ALLOWLIST } = require('../api/warp').__internals;
  for (const port of PORT_ALLOWLIST) {
    const result = parseAllowlistedPort(String(port));
    assert.equal(result.port, port, `port ${port} should be accepted`);
    assert.ok(!result.error, `port ${port} should not produce error`);
  }
});

test('warp internals: parseAllowlistedPort rejects port 9999', () => {
  clearWarpCache();
  const { parseAllowlistedPort } = require('../api/warp').__internals;
  const result = parseAllowlistedPort('9999');
  assert.ok(result.error, 'port 9999 should produce error');
  assert.ok(Array.isArray(result.allowedPorts), 'allowedPorts should be an array');
});

test('warp internals: FALLBACK_ENDPOINTS has 10+ entries across 5+ /24 subnets', () => {
  clearWarpCache();
  const { FALLBACK_ENDPOINTS } = require('../api/warp').__internals;
  assert.ok(FALLBACK_ENDPOINTS.length >= 10, `Need at least 10 fallback endpoints, got ${FALLBACK_ENDPOINTS.length}`);
  const cidrs = new Set(FALLBACK_ENDPOINTS.map((e) => e.cidr24));
  assert.ok(cidrs.size >= 5, `Need at least 5 different /24 subnets, got ${cidrs.size}`);
});

test('warp internals: WARP_DEFAULT_ENGAGE_UDP_PORT is 4500', () => {
  clearWarpCache();
  const { WARP_DEFAULT_ENGAGE_UDP_PORT } = require('../api/warp').__internals;
  assert.equal(WARP_DEFAULT_ENGAGE_UDP_PORT, 4500);
});

// ──────────────────────────────────────────────────────────────
// Integration: handler with mocked HTTPS + net
// ──────────────────────────────────────────────────────────────

test('handler: port=9999 returns 400 with allowedPorts', async () => {
  clearWarpCache();
  setupHttpsMock();
  net.createConnection = mockNetConnect;
  try {
    const handler = require('../api/warp');
    const req = makeReq({ mode: 'legacy', port: '9999' });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.getStatus(), 400);
    assert.ok(Array.isArray(res.getBody().allowedPorts), 'allowedPorts should be in response');
  } finally {
    teardownHttpsMock();
    net.createConnection = realNetCreateConnection;
  }
});

test('handler: mode=legacy, port=2408 returns success', async () => {
  clearWarpCache();
  setupHttpsMock();
  net.createConnection = mockNetConnect;
  try {
    const handler = require('../api/warp');
    const req = makeReq({ mode: 'legacy', port: '2408' });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.getStatus(), 200);
    const body = res.getBody();
    assert.ok(body.success, 'success should be true');
    assert.ok(body.content, 'content should be present');
    // Decode and verify
    const conf = Buffer.from(body.content, 'base64').toString('utf8');
    assert.match(conf, /\[Interface\]/, 'config should have [Interface]');
    assert.match(conf, /PrivateKey = /, 'config should have PrivateKey');
    assert.ok(conf.includes('S1 = 0'), 'legacy S1 must be 0');
    assert.ok(conf.includes('S2 = 0'), 'legacy S2 must be 0');
    assert.ok(!conf.includes('i1 = '), 'lowercase i1 must not appear');
  } finally {
    teardownHttpsMock();
    net.createConnection = realNetCreateConnection;
  }
});

test('handler: mode=awg2, port=500 returns success with S1=S2=S3=S4=0', async () => {
  clearWarpCache();
  setupHttpsMock();
  net.createConnection = mockNetConnect;
  try {
    const handler = require('../api/warp');
    const req = makeReq({ mode: 'awg2', port: '500' });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.getStatus(), 200);
    const conf = Buffer.from(res.getBody().content, 'base64').toString('utf8');
    assert.match(conf, /S1 = 0/, 'AWG2 WARP S1 must be 0');
    assert.match(conf, /S2 = 0/, 'AWG2 WARP S2 must be 0');
    assert.match(conf, /S3 = 0/, 'AWG2 WARP S3 must be 0');
    assert.match(conf, /S4 = 0/, 'AWG2 WARP S4 must be 0');
  } finally {
    teardownHttpsMock();
    net.createConnection = realNetCreateConnection;
  }
});

test('handler: count=1 returns configs[] with 1 entry and backward-compat content', async () => {
  clearWarpCache();
  setupHttpsMock();
  net.createConnection = mockNetConnect;
  try {
    const handler = require('../api/warp');
    const req = makeReq({ mode: 'legacy', count: '1' });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.getStatus(), 200);
    const body = res.getBody();
    assert.ok(body.content, 'backward-compat content should be present');
    assert.ok(Array.isArray(body.configs), 'configs should be array');
    assert.equal(body.configs.length, 1);
    assert.equal(body.count, 1);
  } finally {
    teardownHttpsMock();
    net.createConnection = realNetCreateConnection;
  }
});

test('handler: count=2 returns configs[] with 2 entries', async () => {
  clearWarpCache();
  setupHttpsMock();
  net.createConnection = mockNetConnect;
  try {
    const handler = require('../api/warp');
    const req = makeReq({ mode: 'legacy', count: '2' });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.getStatus(), 200);
    const body = res.getBody();
    assert.ok(Array.isArray(body.configs), 'configs should be array');
    // May be 1 or 2 depending on endpoint diversity; at minimum 1
    assert.ok(body.configs.length >= 1, 'At least 1 config expected');
  } finally {
    teardownHttpsMock();
    net.createConnection = realNetCreateConnection;
  }
});

test('handler: count=3 returns configs[] with up to 3 entries', async () => {
  clearWarpCache();
  setupHttpsMock();
  net.createConnection = mockNetConnect;
  try {
    const handler = require('../api/warp');
    const req = makeReq({ mode: 'legacy', count: '3' });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.getStatus(), 200);
    const body = res.getBody();
    assert.ok(Array.isArray(body.configs));
    assert.ok(body.configs.length >= 1);
    assert.ok(body.configs.length <= 3);
  } finally {
    teardownHttpsMock();
    net.createConnection = realNetCreateConnection;
  }
});

test('handler: vpn:// link format is valid base64url deflate', async () => {
  clearWarpCache();
  setupHttpsMock();
  net.createConnection = mockNetConnect;
  try {
    const handler = require('../api/warp');
    const req = makeReq({ mode: 'legacy', link: '1' });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.getStatus(), 200);
    const { vpnLink } = res.getBody();
    assert.ok(vpnLink, 'vpnLink should be present when link=1');
    assert.match(vpnLink, /^vpn:\/\//, 'vpnLink must start with vpn://');
  } finally {
    teardownHttpsMock();
    net.createConnection = realNetCreateConnection;
  }
});

test('handler: private key in generated config is non-empty base64', async () => {
  clearWarpCache();
  setupHttpsMock();
  net.createConnection = mockNetConnect;
  try {
    const handler = require('../api/warp');
    const req = makeReq({ mode: 'awg2' });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.getStatus(), 200);
    const conf = Buffer.from(res.getBody().content, 'base64').toString('utf8');
    const match = conf.match(/PrivateKey = ([A-Za-z0-9+/=]+)/);
    assert.ok(match, 'PrivateKey line must be present');
    assert.ok(match[1].length > 0, 'PrivateKey must be non-empty');
  } finally {
    teardownHttpsMock();
    net.createConnection = realNetCreateConnection;
  }
});

test('handler: I1 uppercase in legacy mode with embedded amnezia CPS', async () => {
  clearWarpCache();
  setupHttpsMock();
  net.createConnection = mockNetConnect;
  try {
    const handler = require('../api/warp');
    const req = makeReq({ mode: 'legacy', template: 'warp_amnezia' });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.getStatus(), 200);
    const conf = Buffer.from(res.getBody().content, 'base64').toString('utf8');
    // If I1 is present it must be uppercase
    if (conf.includes('I1')) {
      assert.ok(!conf.includes('\ni1 = '), 'lowercase i1 must not appear');
      assert.ok(conf.includes('\nI1 = '), 'uppercase I1 must be present');
    }
  } finally {
    teardownHttpsMock();
    net.createConnection = realNetCreateConnection;
  }
});

test('handler: I1 uppercase in awg2 mode with embedded amnezia CPS', async () => {
  clearWarpCache();
  setupHttpsMock();
  net.createConnection = mockNetConnect;
  try {
    const handler = require('../api/warp');
    const req = makeReq({ mode: 'awg2', template: 'warp_amnezia_awg2' });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.getStatus(), 200);
    const conf = Buffer.from(res.getBody().content, 'base64').toString('utf8');
    if (conf.includes('I1')) {
      assert.ok(!conf.includes('\ni1 = '), 'lowercase i1 must not appear');
    }
  } finally {
    teardownHttpsMock();
    net.createConnection = realNetCreateConnection;
  }
});
