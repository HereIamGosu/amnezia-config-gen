// __tests__/unhandled-rejection-audit.test.js
// Audit of promises nobody waits for (3.1.7, docs/releases/3.1.7-source-audit.md). Every external source a handler
// depends on (Cloudflare API, opencck, itdoginfo community lists, antifilter, the Endpoint Lab pool file, the
// endpoint registry, TCP probes) fails here the ways it can fail: refusal, timeout, non-JSON. The handler still
// answers with a status and a JSON body, and no rejection goes unhandled. No network: https.request and sockets
// are fakes, timeouts and retry pauses run on mocked setTimeout. The last block runs server.js itself offline.

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { describe, test, before, after, beforeEach, afterEach, mock } = require('node:test');
const { generate, labProvider } = require('./helpers/warp-harness');

const ROOT = path.resolve(__dirname, '..');
const CLOUDFLARE = 'api.cloudflareclient.com';
const OPENCCK = 'iplist.opencck.org';
const COMMUNITY = 'raw.githubusercontent.com';
const ANTIFILTER = 'antifilter.download';
const DISCORD_SITES = ['discord.com', 'discord.gg', 'discord.media', 'discordapp.com', 'discordapp.net'];

// Rejections nobody handled; each test checks that none appeared while it ran.
const unhandled = [];
const onUnhandled = (reason) => unhandled.push(reason);
before(() => process.on('unhandledRejection', onUnhandled));
after(() => process.off('unhandledRejection', onUnhandled));
beforeEach(() => {
  unhandled.length = 0;
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
});
afterEach(async () => {
  // Fake I/O still in flight (a route lookup that outlives a failed registration) settles within a few turns;
  // 'unhandledRejection' is emitted once the microtasks after it drain.
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  mock.timers.reset();
  mock.restoreAll();
  assert.deepEqual(unhandled, [], 'no promise rejection may go unhandled');
});

// Node refuses these synchronously in the ClientRequest constructor, before any socket exists (first test below).
const INVALID_PATH = /[^!-ÿ]/;
const refuseLikeNode = (options) => {
  if (INVALID_PATH.test(options.path)) {
    throw Object.assign(new TypeError('Request path contains unescaped characters'), { code: 'ERR_UNESCAPED_CHARACTERS' });
  }
  for (const [name, value] of Object.entries(options.headers || {})) http.validateHeaderValue(name, value);
};

/**
 * Replaces https.request: `route(options)` decides each outgoing request. `{ status, body }` answers it,
 * `{ error: 'ECODE' }` fails it as an unreachable host does, `'hang'` never answers. TCP pre-checks connect.
 * Returns the list of requests made, as "METHOD host/path".
 */
const fakeNetwork = (route) => {
  const calls = [];
  mock.method(https, 'request', (options, onResponse) => {
    refuseLikeNode(options);
    calls.push(`${options.method} ${options.hostname}${options.path}`);
    const outcome = route(options);
    const req = new EventEmitter();
    req.write = () => true;
    req.destroy = () => req;
    req.end = () => {
      if (outcome === 'hang') return req;
      setImmediate(() => {
        if (outcome.error) {
          req.emit('error', Object.assign(new Error(`connect ${outcome.error}`), { code: outcome.error }));
          return;
        }
        const res = new EventEmitter();
        res.statusCode = outcome.status;
        onResponse(res);
        res.emit('data', Buffer.from(outcome.body));
        res.emit('end');
      });
      return req;
    };
    return req;
  });
  mock.method(net, 'createConnection', (_options, onConnect) => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    setImmediate(() => {
      socket.emit('connect');
      if (onConnect) onConnect();
    });
    return socket;
  });
  return calls;
};

const json = (status, value) => ({ status, body: JSON.stringify(value) });

// Placeholders only: a one-letter token and a peer key of 32 bytes of 0x01.
const PEER_KEY = Buffer.alloc(32, 1).toString('base64');
const registration = ({ id = 'audit-id', token = 't' } = {}) => json(200, {
  result: {
    id,
    token,
    config: {
      peers: [{ public_key: PEER_KEY, endpoint: { v4: '162.159.192.1:2408' } }],
      interface: { addresses: { v4: '172.16.0.2', v6: 'fd01::2' } },
    },
  },
});

/** Cloudflare answers every registration call with `registration` unless `cloudflare` says otherwise. */
const byHost = ({ cloudflare = () => registration(), opencck, community, antifilter }) => (options) => {
  const route = { [CLOUDFLARE]: cloudflare, [OPENCCK]: opencck, [COMMUNITY]: community, [ANTIFILTER]: antifilter }[options.hostname];
  assert.ok(route, `unexpected request to ${options.hostname}${options.path}`);
  return route(options);
};

// Fresh modules: the CIDR, community and antifilter caches, the rate limiter and the probe cache are module state.
const FRESH = ['../api/warp', '../api/iplist', '../api/status', '../api/healthcheck', '../src/server/ipListFetch', '../src/server/communityIpFetch'];
const load = (name) => {
  for (const id of FRESH) delete require.cache[require.resolve(id)];
  return require(name);
};

/** One handler call with Vercel-style req/res fakes. */
const call = (handler, query = {}) => {
  const req = { method: 'GET', url: `/?${new URLSearchParams(query)}`, query, body: null, headers: {}, socket: { remoteAddress: '10.9.0.1' } };
  const out = { status: 200, body: undefined, headers: {} };
  const res = {
    setHeader(name, value) { out.headers[name.toLowerCase()] = value; },
    getHeader: (name) => out.headers[name.toLowerCase()],
    status(code) { out.status = code; return res; },
    json(value) { out.body = value; return res; },
  };
  return Promise.resolve(handler(req, res)).then(() => out);
};

/** Settles `promise` on mocked setTimeout: one I/O turn, then the clock moves `stepMs`, until it settles. */
const drive = async (promise, stepMs = 1000) => {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let turn = 0; !settled; turn += 1) {
    assert.ok(turn < 2000, 'the promise never settled');
    await new Promise((resolve) => setImmediate(resolve));
    if (!settled) mock.timers.tick(stepMs);
  }
  return promise;
};

const assertFailureBody = (out, status) => {
  assert.equal(out.status, status);
  assert.equal(out.body.success, false);
  assert.equal(typeof out.body.message, 'string');
  assert.ok(out.body.message.length > 0);
};

describe('what the fakes reproduce', () => {
  test('Node refuses a path with a space and a header with a newline synchronously', () => {
    assert.throws(() => http.request({ host: '127.0.0.1', port: 9, path: '/v0i1909051800/reg/audit id' }), { code: 'ERR_UNESCAPED_CHARACTERS' });
    assert.throws(
      () => http.request({ host: '127.0.0.1', port: 9, path: '/reg', headers: { Authorization: 'Bearer t\nt' } }),
      { code: 'ERR_INVALID_CHAR' },
    );
  });
});

describe('Cloudflare API fails (/api/warp)', () => {
  test('an unreachable host after every retry → 500 with a message', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const calls = fakeNetwork(byHost({ cloudflare: () => ({ error: 'ECONNREFUSED' }) }));
    const out = await drive(call(load('../api/warp')));
    assertFailureBody(out, 500);
    assert.equal(calls.length, 3, 'a refused connection is retried, three attempts in all');
  });

  test('503 on every attempt → 503 with a message', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const calls = fakeNetwork(byHost({ cloudflare: () => json(503, { message: 'Service Unavailable' }) }));
    const out = await drive(call(load('../api/warp')));
    assertFailureBody(out, 503);
    assert.equal(calls.length, 3);
  });

  test('no answer at all → the request timer fires on every attempt → 500 with a message', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const calls = fakeNetwork(byHost({ cloudflare: () => 'hang' }));
    const out = await drive(call(load('../api/warp')));
    assertFailureBody(out, 500);
    assert.match(out.body.message, /Таймаут запроса к Cloudflare API/);
    assert.equal(calls.length, 3);
  });

  test('2xx with a body that is not JSON → 500 with a message', async () => {
    fakeNetwork(byHost({ cloudflare: () => ({ status: 200, body: '<html>captcha</html>' }) }));
    assertFailureBody(await call(load('../api/warp')), 500);
  });

  test('split tunnel: registration fails while the route lists fail too → the registration error, nothing unhandled', async () => {
    fakeNetwork(byHost({
      cloudflare: () => json(403, { message: 'Forbidden' }),
      opencck: () => ({ status: 200, body: 'not json' }),
      community: () => ({ error: 'ECONNRESET' }),
      antifilter: () => ({ status: 500, body: '' }),
    }));
    assertFailureBody(await call(load('../api/warp'), { routeMode: 'split', presets: 'discord' }), 403);
  });
});

describe('route list sources fail', () => {
  const allListsDown = {
    opencck: () => ({ status: 500, body: 'Internal Server Error' }),
    community: () => ({ status: 500, body: '' }),
    antifilter: () => ({ error: 'ECONNREFUSED' }),
  };

  test('/api/warp split: every list source down → 502 with a message after registration', async () => {
    fakeNetwork(byHost(allListsDown));
    const out = await call(load('../api/warp'), { routeMode: 'split', presets: 'discord' });
    assertFailureBody(out, 502);
    assert.match(out.body.message, /пустой ответ/);
  });

  test('/api/iplist: every list source down → 200 with zero routes (the counter shows 0)', async () => {
    fakeNetwork(byHost(allListsDown));
    const out = await call(load('../api/iplist'), { presets: 'discord' });
    assert.equal(out.status, 200);
    assert.equal(out.body.count4, 0);
    assert.deepEqual(out.body.cidrs, []);
  });

  test('/api/iplist: opencck times out on every retry → the community list answers', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const calls = fakeNetwork(byHost({
      opencck: () => 'hang',
      community: () => ({ status: 200, body: '198.51.100.0/24\n' }),
    }));
    const out = await drive(call(load('../api/iplist'), { presets: 'discord' }));
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.cidrs, ['198.51.100.0/24']);
    assert.equal(out.body.cidrSource, 'community');
    assert.equal(calls.filter((c) => c.includes(OPENCCK)).length, 5, 'a timeout is retried, five attempts in all');
  });

  test('/api/iplist: opencck sends non-JSON, the community list never answers → antifilter answers', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    fakeNetwork(byHost({
      opencck: () => ({ status: 200, body: '<html>' }),
      community: () => 'hang',
      antifilter: () => ({ status: 200, body: '# list\n203.0.113.0/24\n' }),
    }));
    const out = await drive(call(load('../api/iplist'), { presets: 'discord' }));
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.cidrs, ['203.0.113.0/24']);
    assert.equal(out.body.cidrSource, 'antifilter');
  });

  test('/api/iplist: opencck answers, community down → opencck routes only', async () => {
    fakeNetwork(byHost({
      opencck: () => json(200, Object.fromEntries(DISCORD_SITES.map((site) => [site, site === 'discord.gg' ? [] : ['192.0.2.0/24']]))),
      community: () => ({ error: 'ETIMEDOUT' }),
    }));
    const out = await call(load('../api/iplist'), { presets: 'discord' });
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.cidrs, ['192.0.2.0/24']);
  });
});

describe('Endpoint Lab pool file fails (Lab Auto)', () => {
  for (const [name, lab] of [
    ['the file is missing', labProvider({}, { missing: true })],
    ['the file is not JSON', labProvider('{"schema_version": 2, "endpoints": [')],
  ]) {
    test(`${name} → 503 lab_* with a message, no registration`, async () => {
      const out = await generate({ endpointMode: 'lab' }, { lab });
      assert.equal(out.status, 503);
      assert.match(out.body.error, /^lab_/);
      assert.equal(typeof out.body.message, 'string');
      assert.equal(out.apiCalls, 0);
    });
  }
});

describe('endpoint registry fails (/api/status)', () => {
  test('the registry rejects → 200 with status unknown', async () => {
    const endpointCache = require('../src/server/endpointCache');
    mock.method(endpointCache, 'getTopEndpoints', async () => { throw new Error('registry down'); });
    const out = await call(load('../api/status'));
    assert.equal(out.status, 200);
    assert.equal(out.body.status, 'unknown');
    assert.equal(out.body.message, 'Status could not be computed');
  });
});

describe('TCP probes fail (/api/healthcheck)', () => {
  test('every probe refused → 200 with every service down', async () => {
    mock.method(net.Socket.prototype, 'connect', function connect() {
      setImmediate(() => this.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })));
      return this;
    });
    const out = await call(load('../api/healthcheck'));
    assert.equal(out.status, 200);
    assert.deepEqual(Object.values(out.body.services).map((s) => s.ok), [false, false, false]);
  });

  test('no probe answers → the probe timer fires → 200 with every service down', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    mock.method(net.Socket.prototype, 'connect', function connect() { return this; });
    const out = await drive(call(load('../api/healthcheck')));
    assert.equal(out.status, 200);
    assert.deepEqual(Object.values(out.body.services).map((s) => s.ok), [false, false, false]);
  });
});

// A port from the OS ephemeral range: the other server tests draw random ports from 41000-45500 in parallel files.
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

describe('server.js with the network cut off', () => {
  let PORT;
  let server;
  let stderr = '';

  before(async () => {
    PORT = await freePort();
    server = spawn(process.execPath, ['--require', path.join(__dirname, 'helpers', 'offline-network.js'), 'server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ENDPOINT_LAB_PUBLIC_DIR: path.join(ROOT, '__tests__', 'no-lab-dir') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stderr.on('data', (chunk) => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
      server.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } });
      server.on('exit', (code) => reject(new Error(`server exited ${code}: ${stderr}`)));
    });
  });

  after(() => { server?.kill(); });

  test('every API path answers with a status and a JSON body, and the process stays up', async () => {
    const base = `http://127.0.0.1:${PORT}`;
    const cases = [
      ['GET', '/api/warp', 500],
      ['GET', '/api/warp?routeMode=split&presets=discord', 500],
      ['GET', '/api/warp?endpointMode=lab', 503],
      ['POST', '/api/warp', 400, '{"presets":'],
      ['GET', '/api/iplist?presets=discord', 200],
      ['GET', '/api/healthcheck', 200],
      ['GET', '/api/status', 200],
      ['GET', '/api/lab', 503],
    ];
    for (const [method, url, status, body] of cases) {
      const res = await fetch(base + url, { method, body, headers: body ? { 'Content-Type': 'application/json' } : {} });
      assert.equal(res.status, status, `${method} ${url}`);
      assert.equal(typeof (await res.json()), 'object', `${method} ${url} answers JSON`);
    }
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal(server.exitCode, null, `server.js exited: ${stderr}`);
    assert.doesNotMatch(stderr, /unhandled|UnhandledPromiseRejection|uncaught/i);
  });
});
