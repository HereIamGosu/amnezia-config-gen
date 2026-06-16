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

test('fallback smoke: generation succeeds without Vercel KV', async () => {
  const oldUrl = process.env.KV_REST_API_URL;
  const oldToken = process.env.KV_REST_API_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
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
    if (oldUrl === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = oldUrl;
    if (oldToken === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = oldToken;
  }
});

test('fallback smoke: failed endpoint candidates do not block a successful candidate', async () => {
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
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

test('fallback smoke: CIDR resolution uses antifilter when the primary source is unavailable', async () => {
  delete require.cache[require.resolve('../src/server/ipListFetch')];
  const httpsMock = installCidrFallbackMock();
  try {
    const { fetchCidrsForDomains } = require('../src/server/ipListFetch');
    const result = await fetchCidrsForDomains(['release-2-4-1.invalid']);
    assert.equal(result.source, 'antifilter');
    assert.deepEqual(Array.from(result.cidrs), ['203.0.113.0/24']);
  } finally {
    httpsMock.mock.restore();
  }
});

test('fallback smoke: /api/status reports fallback registry source without KV', async () => {
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  clearEndpointModules();
  const handler = require('../api/status');
  const res = makeRes();
  await handler(makeReq('/api/status'), res);
  assert.equal(res.getStatus(), 200);
  assert.equal(res.getBody().cache_source, 'fallback');
  assert.ok(res.getBody().active_endpoints > 0);
});

test('fallback smoke: /api/iplist reports static when static CIDRs are the actual route source', async () => {
  delete require.cache[require.resolve('../src/server/ipListFetch')];
  delete require.cache[require.resolve('../api/iplist')];
  const httpsMock = installCidrFallbackMock();
  try {
    const handler = require('../api/iplist');
    const res = makeRes();
    await handler(makeReq('/api/iplist?presets=telegram', { presets: 'telegram' }), res);
    assert.equal(res.getStatus(), 200);
    assert.equal(res.getBody().success, true);
    assert.equal(res.getBody().cidrSource, 'static');
    assert.ok(res.getBody().cidrs.includes('149.154.160.0/20'));
  } finally {
    httpsMock.mock.restore();
  }
});
