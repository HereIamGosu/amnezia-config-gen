// __tests__/warp-presets-invalid.test.js
// Invalid route presets are rejected with 400 before any Cloudflare registration, and a preset resolution that
// fails while registration is still running never becomes an unhandled rejection (3.1.1).

'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test, mock } = require('node:test');
const https = require('node:https');
const net = require('node:net');
const { generate } = require('./helpers/warp-harness');

const UNKNOWN = 'Неизвестные пресеты маршрутов: bogus';
const NO_DOMAINS = 'Не заданы домены для выбранных пресетов.';

test('GET split + unknown preset: 400 before registration', async () => {
  const r = await generate({ routeMode: 'split', presets: 'bogus' });
  assert.equal(r.status, 400);
  assert.equal(r.body.success, false);
  assert.equal(r.body.message, UNKNOWN);
  assert.equal(r.body.error, UNKNOWN);
  assert.equal(r.apiCalls, 0);
});

test('GET split + mixed known and unknown presets: 400 before registration', async () => {
  const r = await generate({ routeMode: 'split', presets: 'telegram,zzz' });
  assert.equal(r.status, 400);
  assert.equal(r.body.message, 'Неизвестные пресеты маршрутов: zzz');
  assert.equal(r.apiCalls, 0);
});

test('POST split + unknown preset in body: 400 before registration', async () => {
  const r = await generate({ routeMode: 'split' }, { method: 'POST', body: { presets: ['zzz'] } });
  assert.equal(r.status, 400);
  assert.equal(r.body.message, 'Неизвестные пресеты маршрутов: zzz');
  assert.equal(r.apiCalls, 0);
});

test('preset key that normalises to an empty string: 400 before registration', async () => {
  const r = await generate({ routeMode: 'split', presets: '!!!' });
  assert.equal(r.status, 400);
  assert.equal(r.body.message, NO_DOMAINS);
  assert.equal(r.apiCalls, 0);
});

test('unknown preset is rejected before Lab Auto selection', async () => {
  let selections = 0;
  const lab = { provider: { selectForGeneration: () => { selections += 1; return { ok: false, code: 'lab_unavailable' }; } } };
  const r = await generate({ routeMode: 'split', presets: 'bogus', endpointMode: 'lab' }, { lab });
  assert.equal(r.status, 400);
  assert.equal(selections, 0);
  assert.equal(r.apiCalls, 0);
});

test('routeMode=full ignores presets, as before', async () => {
  const r = await generate({ routeMode: 'full', presets: 'bogus' });
  assert.equal(r.status, 200);
});

test('control: split + known preset answers 200', async () => {
  const r = await generate({ routeMode: 'split', presets: 'telegram' });
  assert.equal(r.status, 200);
});

test('registration failure while preset resolution is pending leaves no unhandled rejection', async () => {
  delete require.cache[require.resolve('../api/warp')];
  const seen = [];
  const onUnhandled = (reason) => { seen.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  const httpsMock = mock.method(https, 'request', () => {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => setImmediate(() => req.emit('error', new Error('registration refused')));
    return req;
  });
  const realNet = net.createConnection;
  net.createConnection = () => {
    const s = new EventEmitter();
    s.destroy = () => {};
    setImmediate(() => s.emit('error', new Error('no route')));
    return s;
  };
  try {
    const handler = require('../api/warp');
    let status = 200;
    let body = null;
    const res = { setHeader() {}, status(c) { status = c; return res; }, json(d) { body = d; return res; } };
    const query = { routeMode: 'split', presets: 'youtube' };
    const errLog = mock.method(console, 'error', () => {});
    try {
      await handler({ method: 'GET', url: '/api/warp', query, body: null, socket: { remoteAddress: '10.0.0.2' }, headers: {} }, res);
    } finally {
      errLog.mock.restore();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(status >= 400, `expected an error response, got ${status}`);
    assert.equal(body.success, false);
    assert.deepEqual(seen, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    httpsMock.mock.restore();
    net.createConnection = realNet;
  }
});
