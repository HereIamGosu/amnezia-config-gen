'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test, mock } = require('node:test');
const https = require('node:https');
const net = require('node:net');

const realNetCreateConnection = net.createConnection.bind(net);

const makeReq = (path, query = {}) => ({
  method: 'GET',
  url: path,
  query,
  body: null,
  socket: { remoteAddress: '127.0.0.1' },
  headers: {},
});

const makeRes = () => {
  let statusCode = 200;
  let body = null;
  const headers = {};
  const res = {
    setHeader(name, value) { headers[name] = value; },
    status(code) { statusCode = code; return res; },
    json(data) { body = data; return res; },
    getStatus: () => statusCode,
    getBody: () => body,
  };
  return res;
};

const clearEndpointModules = () => {
  for (const path of [
    '../api/warp',
    '../api/status',
    '../src/server/endpointCache',
    '../src/server/endpointHealth',
  ]) {
    delete require.cache[require.resolve(path)];
  }
};

const installWarpApiMock = () => mock.method(https, 'request', (options, responseCb) => {
  const res = new EventEmitter();
  res.statusCode = 200;
  const req = new EventEmitter();
  req.write = () => {};
  req.destroy = () => {};
  req.end = () => {
    setImmediate(() => {
      responseCb(res);
      res.emit('data', Buffer.from(JSON.stringify({
        result: {
          id: 'fallback-smoke-id',
          token: 'fallback-smoke-token',
          config: {
            peers: [{
              public_key: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=',
              endpoint: { v4: '162.159.192.1:2408' },
            }],
            interface: { addresses: { v4: '172.16.0.2', v6: 'fd01::2' } },
          },
        },
      })));
      res.emit('end');
    });
  };
  return req;
});

const installCidrFallbackMock = () => mock.method(https, 'request', (options, responseCb) => {
  const res = new EventEmitter();
  const req = new EventEmitter();
  req.destroy = () => {};
  req.end = () => {
    setImmediate(() => {
      const isAntifilter = options.hostname === 'antifilter.download';
      res.statusCode = isAntifilter ? 200 : 500;
      responseCb(res);
      if (isAntifilter) {
        res.emit('data', Buffer.from('203.0.113.0/24\n2001:db8::/32\n'));
      }
      res.emit('end');
    });
  };
  req.on = EventEmitter.prototype.on;
  return req;
});

test('fallback smoke: generation succeeds with the static endpoint registry', async () => {
  clearEndpointModules();
  const httpsMock = installWarpApiMock();
  net.createConnection = (opts, cb) => {
    const sock = new EventEmitter();
    sock.destroy = () => {};
    setImmediate(() => {
      if (cb) cb();
      sock.emit('connect');
    });
    return sock;
  };

  try {
    const handler = require('../api/warp');
    const req = makeReq('/api/warp?mode=awg2&template=awg2_random&warpPort=2408', {
      mode: 'awg2',
      template: 'awg2_random',
      warpPort: '2408',
    });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.getStatus(), 200);
    assert.equal(res.getBody().success, true);
    assert.ok(res.getBody().content);
    assert.equal(res.getBody().routesTelemetrySource, 'static');
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreateConnection;
  }
});

test('fallback smoke: failed endpoint candidates do not block a successful candidate', async () => {
  clearEndpointModules();
  const httpsMock = installWarpApiMock();
  let attempt = 0;
  net.createConnection = (opts, cb) => {
    const sock = new EventEmitter();
    sock.destroy = () => {};
    const current = attempt++;
    setImmediate(() => {
      if (current < 2) {
        sock.emit('error', new Error(`candidate ${opts.host} unavailable`));
        return;
      }
      if (cb) cb();
      sock.emit('connect');
    });
    return sock;
  };

  try {
    const handler = require('../api/warp');
    const req = makeReq('/api/warp?mode=awg2&template=awg2_random&warpPort=2408', {
      mode: 'awg2',
      template: 'awg2_random',
      warpPort: '2408',
    });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.getStatus(), 200);
    assert.equal(res.getBody().success, true);
    assert.equal(res.getBody().configs[0].endpointSource, 'tcp_check');
    assert.ok(attempt >= 3);
  } finally {
    httpsMock.mock.restore();
    net.createConnection = realNetCreateConnection;
  }
});

// Changed in 3.2.0 (K2, spec 3.2.0 §4.5): the antifilter substitute is gone. A failed primary source gives an empty
// answer, never antifilter's foreign networks; a transitional preset then takes its reserve from the snapshot.
test('fallback smoke: an unavailable primary source gives no routes, and antifilter is never asked', async () => {
  delete require.cache[require.resolve('../src/server/ipListFetch')];
  const httpsMock = installCidrFallbackMock();
  try {
    const { fetchCidrsForDomains } = require('../src/server/ipListFetch');
    const result = await fetchCidrsForDomains(['release-2-4-1.invalid']);
    assert.equal(result.source, 'opencck');
    assert.deepEqual(Array.from(result.cidrs), []);
    assert.equal(httpsMock.mock.calls.filter((c) => c.arguments[0].hostname === 'antifilter.download').length, 0);
  } finally {
    httpsMock.mock.restore();
  }
});

// 3.2.0 (spec 3.2.0 §4.5): an empty answer after a failure stuck for 10 minutes before; now only answers with routes
// are cached, so a recovered source answers the next request.
test('fallback smoke: an empty answer is not cached — the next call asks the lists again', async () => {
  delete require.cache[require.resolve('../src/server/ipListFetch')];
  let calls = 0;
  let up = false;
  const httpsMock = mock.method(https, 'request', (options, responseCb) => {
    calls += 1;
    const res = new EventEmitter();
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      res.statusCode = up ? 200 : 404;
      responseCb(res);
      if (up) res.emit('data', Buffer.from(JSON.stringify({ 'example.org': ['198.51.100.0/24'] })));
      res.emit('end');
    });
    return req;
  });
  try {
    const { fetchCidrsForDomains } = require('../src/server/ipListFetch');
    assert.deepEqual(Array.from((await fetchCidrsForDomains(['example.org'])).cidrs), []);
    up = true;
    assert.deepEqual(Array.from((await fetchCidrsForDomains(['example.org'])).cidrs), ['198.51.100.0/24']);
    assert.deepEqual(Array.from((await fetchCidrsForDomains(['example.org'])).cidrs), ['198.51.100.0/24']);
    assert.equal(calls, 2, 'the empty answer was asked again, the answer with routes came from the cache');
  } finally {
    httpsMock.mock.restore();
  }
});

// 3.2.0, owner decision 2026-11-01: Telegram stays transitional as in 3.1.9, whose list also held nine networks of
// cidr.txt. The live path adds a preset's legacy.cidrs4 to an answer of the lists; an empty answer stays empty, so
// the resolver takes the snapshot reserve.
test('fallback smoke: legacy.cidrs4 join an answer of the lists, never an empty one', async () => {
  delete require.cache[require.resolve('../src/server/ipListFetch')];
  let up = true;
  const httpsMock = mock.method(https, 'request', (options, responseCb) => {
    const res = new EventEmitter();
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      res.statusCode = up ? 200 : 404;
      responseCb(res);
      if (up) res.emit('data', Buffer.from(JSON.stringify({ 'example.org': ['198.51.100.0/24'] })));
      res.emit('end');
    });
    return req;
  });
  try {
    const { fetchLegacyCidrs } = require('../src/server/ipListFetch');
    const legacy = { cidrs4: ['203.0.113.0/24'] };
    const live = await fetchLegacyCidrs({ domains: ['example.org'], legacy });
    assert.deepEqual([...live.cidrs4].sort(), ['198.51.100.0/24', '203.0.113.0/24']);
    up = false;
    const empty = await fetchLegacyCidrs({ domains: ['example.net'], legacy });
    assert.deepEqual(empty.cidrs4, [], 'no answer of the lists: the resolver takes the reserve, not the nine networks alone');
  } finally {
    httpsMock.mock.restore();
  }
});

test('fallback smoke: a transitional preset whose sources fail takes the snapshot reserve, with a warning', async () => {
  delete require.cache[require.resolve('../src/server/ipListFetch')];
  delete require.cache[require.resolve('../src/server/communityIpFetch')];
  delete require.cache[require.resolve('../api/iplist')];
  const httpsMock = installCidrFallbackMock();
  try {
    const { getCatalog } = require('../src/server/ipCatalog');
    const reserve = getCatalog().plan(['discord']).snapshot.presets.discord.fallback.cidrs4;
    const handler = require('../api/iplist');
    const res = makeRes();
    await handler(makeReq('/api/iplist?presets=discord', { presets: 'discord' }), res);
    assert.equal(res.getStatus(), 200);
    assert.equal(res.getBody().cidrSource, 'catalog', 'the live part went to the reserve');
    assert.deepEqual(res.getBody().cidrs, [...reserve].sort());
    assert.ok(res.getBody().cidrs.includes('66.22.192.0/18'), 'the static Discord network of the recipe');
    assert.equal(res.getBody().presetStatus.discord.source, 'catalog-fallback');
    assert.deepEqual(res.getBody().warnings, ['Route source fallback: discord']);
    assert.equal(httpsMock.mock.calls.filter((c) => c.arguments[0].hostname === 'antifilter.download').length, 0);
  } finally {
    httpsMock.mock.restore();
  }
});

test('fallback smoke: /api/status reports the static registry as fallback source', async () => {
  clearEndpointModules();
  const handler = require('../api/status');
  const res = makeRes();
  await handler(makeReq('/api/status'), res);
  assert.equal(res.getStatus(), 200);
  assert.equal(res.getBody().cache_source, 'fallback');
  assert.ok(res.getBody().active_endpoints > 0);
});

// Changed in 3.2.0 (spec 3.2.0 §8): a catalogue preset takes its routes from the snapshot with cidrSource "catalog"
// and no request at all. The spec names telegram; it stayed transitional (owner, 2026-11-01), so github stands in.
test('fallback smoke: /api/iplist answers a catalogue preset from the snapshot, without network', async () => {
  delete require.cache[require.resolve('../src/server/ipListFetch')];
  delete require.cache[require.resolve('../api/iplist')];
  const httpsMock = installCidrFallbackMock();
  try {
    const handler = require('../api/iplist');
    const res = makeRes();
    await handler(makeReq('/api/iplist?presets=github', { presets: 'github' }), res);
    assert.equal(res.getStatus(), 200);
    assert.equal(res.getBody().success, true);
    assert.equal(res.getBody().cidrSource, 'catalog');
    assert.ok(res.getBody().cidrs.length > 0);
    assert.equal(httpsMock.mock.callCount(), 0, 'no route list request');
  } finally {
    httpsMock.mock.restore();
  }
});

test('endpoint registry has no Vercel KV integration and serves the static seed list', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies?.['@vercel/kv'], undefined);
  for (const file of ['src/server/endpointCache.js', 'api/warp.js', 'api/status.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /@vercel\/kv|KV_REST_API/, file);
  }

  clearEndpointModules();
  const registry = require('../src/server/endpointCache');
  assert.deepEqual(Object.keys(registry).sort(), ['HARDCODED_FALLBACK', 'getFallbackEndpoints', 'getTopEndpoints']);
  const top = await registry.getTopEndpoints({ port: 2408, limit: 3, excludeCidrs: ['162.159.192.0/24'] });
  assert.equal(top.length, 3);
  assert.ok(top.every((e) => e.port === 2408 && e.cidr24 !== '162.159.192.0/24'));
  top[0].ip = 'mutated';
  assert.notEqual(registry.HARDCODED_FALLBACK[0].ip, 'mutated');
  assert.deepEqual(await registry.getTopEndpoints({ port: 500 }), []);
});
