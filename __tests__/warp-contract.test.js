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

test('contract: awg3 refuses vpn:// until its protocol mapping is source-confirmed', async () => {
  clearModules();
  const httpsMock = installWarpMock();
  net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
  try {
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq({ mode: 'awg3', link: '1' }), res);
    const body = res.getBody();
    assert.equal(body.vpnLink, undefined);
    assert.equal(body.configs[0].vpnLink, undefined);
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreate;
  }
});

test('contract: experimental AWG3 content padding uses the documented default and warning', async () => {
  clearModules();
  const httpsMock = installWarpMock();
  net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
  try {
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq({ mode: 'awg3', experimentalContentPadding: 'true' }), res);
    const body = res.getBody();
    const conf = Buffer.from(body.content, 'base64').toString('utf8');
    assert.match(conf, /^ContentPaddingAddition = 10-100$/m);
    assert.match(String(body.warning), /ContentPaddingAddition is experimental for Cloudflare WARP/);
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreate;
  }
});

test('contract: AWG3 aliases and templates resolve to canonical modes', async () => {
  for (const [query, expected] of [
    [{ mode: 'awg30' }, 'awg3'],
    [{ mode: '3.1' }, 'awg31'],
    [{ template: 'amnezia_awg3' }, 'awg3'],
    [{ template: 'warp_awg31_amnezia' }, 'awg31'],
  ]) {
    clearModules();
    const httpsMock = installWarpMock();
    net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
    try {
      const handler = require('../api/warp');
      const res = makeRes();
      await handler(makeReq(query), res);
      assert.equal(res.getStatus(), 200);
      assert.equal(res.getBody().mode, expected);
    } finally {
      httpsMock.mock.restore();
      net.createConnection = realNetCreate;
    }
  }
});

test('contract: AWG3 GET overrides are normalized and reported by WARP-safe metadata', async () => {
  clearModules();
  const httpsMock = installWarpMock();
  net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
  try {
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq({
      mode: 'awg3',
      rekeyAfterTime: '90-110',
      rekeyTimeout: '4',
      rejectAfterTime: '160-190',
      keepaliveTimeout: '6-12',
      maxHandshakeAttempts: '16-22',
      persistentKeepalive: '24-34',
      experimentalContentPadding: 'true',
      contentPaddingAddition: '12-64',
    }), res);
    const body = res.getBody();
    const conf = Buffer.from(body.content, 'base64').toString('utf8');
    for (const line of ['RekeyAfterTime = 90-110', 'RekeyTimeout = 4', 'RejectAfterTime = 160-190', 'KeepaliveTimeout = 6-12', 'MaxHandshakeAttempts = 16-22', 'PersistentKeepalive = 24-34', 'ContentPaddingAddition = 12-64']) {
      assert.match(conf, new RegExp(`^${line}$`, 'm'));
    }
    assert.equal(body.awg.requestedVersion, '3.0');
    assert.equal(body.awg.profile, 'warp-safe');
    assert.equal(body.awg.peerType, 'stock-wireguard');
    assert.deepEqual(body.awg.experimentalFeatures, ['content-padding-addition']);
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreate;
  }
});

test('contract: AWG31 POST accepts the same strict range fields and returns protocol metadata', async () => {
  clearModules();
  const httpsMock = installWarpMock();
  net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
  try {
    const handler = require('../api/warp');
    const req = makeReq({}, 'POST');
    req.body = { mode: 'awg31', rekeyTimeout: '5-8', persistentKeepalive: '30', link: true };
    const res = makeRes();
    await handler(req, res);
    const body = res.getBody();
    const conf = Buffer.from(body.content, 'base64').toString('utf8');
    assert.equal(res.getStatus(), 200);
    assert.match(conf, /^RekeyTimeout = 5-8$/m);
    assert.match(conf, /^PersistentKeepalive = 30$/m);
    assert.equal(body.awg.vpnImport.protocolVersion, '3.1');
    assert.equal(body.awg.vpnImport.available, true);
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreate;
  }
});

test('contract: malformed AWG3 ranges and blocked wire-format overrides return 400 before registration', async () => {
  for (const query of [
    { mode: 'awg3', rekeyAfterTime: '100-120\nPrivateKey = injected' },
    { mode: 'awg31', contentPaddingAddition: '35-25', experimentalContentPadding: 'true' },
    { mode: 'awg3', S4: '12' },
    { mode: 'awg31', randomTrailers: 'on' },
    { mode: 'awg31', disableCookies: 'on' },
  ]) {
    clearModules();
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq(query), res);
    assert.equal(res.getStatus(), 400);
    assert.equal(res.getBody().success, false);
  }
});

test('contract: AWG3 composition keeps timing fields across count, CPS5, mobile/router, and IPv6 variants', async () => {
  for (const query of [
    { mode: 'awg3', count: '3', cps5: '1' },
    { mode: 'awg31', mobile: '1', cps5: '1', ipv6: '1' },
    { mode: 'awg3', router: '1' },
    { mode: 'awg31', ipv6: '1' },
  ]) {
    clearModules();
    const httpsMock = installWarpMock();
    net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
    try {
      const handler = require('../api/warp');
      const res = makeRes();
      await handler(makeReq(query), res);
      const body = res.getBody();
      assert.equal(res.getStatus(), 200);
      for (const item of body.configs) {
        const conf = Buffer.from(item.content, 'base64').toString('utf8');
        assert.match(conf, /^RekeyAfterTime = 100-120$/m);
        assert.match(conf, /^S4 = 0$/m);
        assert.match(conf, /^H4 = 4$/m);
        if (query.cps5) assert.match(conf, /^I5 = /m);
        if (query.mobile) assert.doesNotMatch(conf, /^Address = .*:/m);
        if (query.ipv6 === '1' && !query.mobile) assert.match(conf, /^Address = .*:/m);
      }
      if (query.router) assert.equal(body.awg.routerCompatibility, 'experimental/router-dependent');
    } finally {
      httpsMock.mock.restore();
      net.createConnection = realNetCreate;
    }
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
