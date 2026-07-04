// __tests__/compatibility-api.test.js
// Contract tests for the additive `compatibility` field on /api/warp — 2.7.0.
// Verifies presence, backward compatibility, and absence of secret leakage,
// without any live network.

'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test, mock } = require('node:test');
const https = require('node:https');
const net = require('node:net');

const realNetCreate = net.createConnection.bind(net);

function makeReq(query = {}) {
  return {
    method: 'GET',
    url: '/api/warp?' + new URLSearchParams(query).toString(),
    query,
    body: null,
    socket: { remoteAddress: '10.0.0.7' },
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

const FAKE_WARP_RESPONSE = JSON.stringify({
  result: {
    id: 'contract-id',
    token: 'contract-secret-token',
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
    try { delete require.cache[require.resolve(m)]; } catch (_e) { /* not cached */ }
  }
}

async function generate(query) {
  clearModules();
  const httpsMock = installWarpMock();
  net.createConnection = (opts, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
  try {
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq(query), res);
    return res;
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreate;
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('compatibility: /api/warp returns a compatibility summary with 4 arrays', async () => {
  const res = await generate({ mode: 'awg2' });
  const body = res.getBody();
  assert.equal(res.getStatus(), 200);
  assert.ok(body.compatibility, 'compatibility must be present');
  assert.ok(Array.isArray(body.compatibility.recommended));
  assert.ok(Array.isArray(body.compatibility.experimental));
  assert.ok(Array.isArray(body.compatibility.notRecommended));
  assert.ok(Array.isArray(body.compatibility.warnings));
});

test('compatibility: existing response fields are preserved (backward compat)', async () => {
  const res = await generate({ mode: 'legacy' });
  const body = res.getBody();
  assert.equal(body.success, true);
  assert.ok(typeof body.content === 'string' && body.content.length > 0);
  assert.ok(Array.isArray(body.configs));
  assert.equal(body.content, body.configs[0].content);
  assert.equal(typeof body.mode, 'string');
  assert.equal(typeof body.count, 'number');
});

test('compatibility: AWG 2.0 warning present in awg2 mode', async () => {
  const res = await generate({ mode: 'awg2' });
  const warnings = res.getBody().compatibility.warnings.join(' ');
  assert.match(warnings, /Cloudflare WARP peer remains a standard WireGuard peer/i);
});

test('compatibility: AWG 2.0 warning absent in legacy mode', async () => {
  const res = await generate({ mode: 'legacy' });
  const warnings = res.getBody().compatibility.warnings.join(' ');
  assert.doesNotMatch(warnings, /Cloudflare WARP peer remains a standard WireGuard peer/i);
});

test('compatibility: vpnlink export offered only when link=1', async () => {
  const withLink = await generate({ mode: 'awg2', link: '1' });
  const av1 = withLink.getBody().compatibility.recommended.find((c) => c.clientId === 'amnezia_vpn');
  assert.ok(av1.exports.includes('vpnlink'));

  const noLink = await generate({ mode: 'awg2' });
  const av2 = noLink.getBody().compatibility.recommended.find((c) => c.clientId === 'amnezia_vpn');
  assert.ok(!av2.exports.includes('vpnlink'));
});

test('compatibility: summary contains no secrets', async () => {
  const res = await generate({ mode: 'awg2', link: '1' });
  const body = res.getBody();
  const serialized = JSON.stringify(body.compatibility);

  // Registration token from the mocked WARP response
  assert.doesNotMatch(serialized, /contract-secret-token/);
  // Private key material / config field names
  assert.doesNotMatch(serialized, /PrivateKey/i);
  assert.doesNotMatch(serialized, /PresharedKey/i);
  // The vpn:// PAYLOAD (scheme followed by base64url data) must never appear.
  // A bare "vpn://" mention inside a help note is not a leak.
  assert.doesNotMatch(serialized, /vpn:\/\/[A-Za-z0-9_-]{16,}/);
  // No AllowedIPs / [Interface] leakage
  assert.doesNotMatch(serialized, /\[Interface\]/);
  assert.doesNotMatch(serialized, /AllowedIPs/);
});

test('compatibility: warnings never embed .conf text or vpn:// payload', async () => {
  const res = await generate({ mode: 'awg2', link: '1' });
  const warnings = res.getBody().compatibility.warnings.join('\n');
  assert.doesNotMatch(warnings, /vpn:\/\//);
  assert.doesNotMatch(warnings, /\[Interface\]/);
  assert.doesNotMatch(warnings, /PrivateKey/i);
});
