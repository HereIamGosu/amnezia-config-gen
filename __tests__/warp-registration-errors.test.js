// __tests__/warp-registration-errors.test.js
// How /api/warp answers when the Cloudflare WARP API fails (3.1.8, spec table 4.2 = R5 4.D without the `error`
// field): a fixed HTTP code per class, a fixed Russian `message` that carries nothing of Cloudflare's answer, no
// `error` field, `Retry-After` for 429 and 503. The requests repeated are those of 3.1.7: 429, 502, 503, 504, the
// listed network codes and the timeout. Errors outside the registration keep their old answers. No network: the
// harness answers the API requests, retry pauses and the request timer run on mocked setTimeout.

'use strict';

const assert = require('node:assert/strict');
const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const { generate, registrationAnswer, labSnapshot, LAB_POOL, labProvider } = require('./helpers/warp-harness');

const MESSAGES = {
  rate_limited: 'Cloudflare временно ограничил создание устройств WARP. Повторите через минуту; если ошибка держится, это сбой на стороне Cloudflare, а не вашего подключения.',
  unavailable: 'Сервис регистрации Cloudflare WARP сейчас не отвечает. Повторите позже.',
  rejected: 'Cloudflare не принял запрос регистрации WARP. Это сбой на стороне сервиса, а не ваших настроек.',
};
const MARKER = 'cf-body-marker';
const cfJson = (status, headers) => ({ status, body: JSON.stringify({ success: false, message: MARKER, errors: [{ message: MARKER }] }), ...(headers ? { headers } : {}) });

beforeEach(() => {
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
});
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

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

const run = (query, cloudflare, opts = {}) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  return drive(generate(query, { cloudflare, ...opts }));
};

/** A registration failure as table 4.2 answers it. */
const assertRefusal = (out, status, klass, retryAfter) => {
  assert.equal(out.status, status, JSON.stringify(out.body));
  assert.deepEqual(Object.keys(out.body).sort(), ['message', 'success']);
  assert.equal(out.body.success, false);
  assert.equal(out.body.message, MESSAGES[klass]);
  assert.equal(out.headers.getHeader('Retry-After'), retryAfter);
  assert.doesNotMatch(JSON.stringify(out.body), new RegExp(MARKER));
};

describe('table 4.2: each outcome of POST reg', () => {
  const rows = [
    // [name, answer to every request, HTTP, class, Retry-After, requests made]
    ['2xx with a body that is not JSON', { status: 200, body: `<html>${MARKER}</html>` }, 502, 'rejected', undefined, 1],
    ['2xx with an empty body', { status: 200, body: '' }, 502, 'rejected', undefined, 1],
    ['2xx with JSON null', { status: 200, body: 'null' }, 502, 'rejected', undefined, 1],
    ['2xx without id and token', { status: 200, body: JSON.stringify({ result: { config: {} } }) }, 502, 'rejected', undefined, 1],
    ['2xx with a non-string id', registrationAnswer({ id: 7 }), 502, 'rejected', undefined, 1],
    ['an answer over 2 MB', { status: 200, body: [Buffer.alloc(1_100_000, 0x61), Buffer.alloc(1_100_000, 0x61)] }, 502, 'rejected', undefined, 1],
    ['a 503 answer over 2 MB (not repeated, as in 3.1.7)', { status: 503, body: [Buffer.alloc(1_100_000, 0x61), Buffer.alloc(1_100_000, 0x61)] }, 502, 'rejected', undefined, 1],
    ['301', cfJson(301), 502, 'rejected', undefined, 1],
    ['302 with an HTML body', { status: 302, body: `<a>${MARKER}</a>` }, 502, 'rejected', undefined, 1],
    ['400', cfJson(400), 502, 'rejected', undefined, 1],
    ['401', cfJson(401), 502, 'rejected', undefined, 1],
    ['403 with JSON', cfJson(403), 502, 'rejected', undefined, 1],
    ['403 with HTML', { status: 403, body: `<html>${MARKER}</html>` }, 502, 'rejected', undefined, 1],
    ['404', cfJson(404), 502, 'rejected', undefined, 1],
    ['405', cfJson(405), 502, 'rejected', undefined, 1],
    ['409', cfJson(409), 502, 'rejected', undefined, 1],
    ['422', cfJson(422), 502, 'rejected', undefined, 1],
    ['408', cfJson(408), 503, 'unavailable', '60', 1],
    ['429 on every attempt, Retry-After 120', cfJson(429, { 'retry-after': '120' }), 429, 'rate_limited', '120', 3],
    ['429 without headers (the existing fakes)', cfJson(429), 429, 'rate_limited', '60', 3],
    ['429, Retry-After 3600', cfJson(429, { 'retry-after': '3600' }), 429, 'rate_limited', '3600', 3],
    ['429, Retry-After 99999', cfJson(429, { 'retry-after': '99999' }), 429, 'rate_limited', '60', 3],
    ['429, Retry-After 0', cfJson(429, { 'retry-after': '0' }), 429, 'rate_limited', '60', 3],
    ['429, Retry-After abc', cfJson(429, { 'retry-after': 'abc' }), 429, 'rate_limited', '60', 3],
    ['429, Retry-After 1.5', cfJson(429, { 'retry-after': '1.5' }), 429, 'rate_limited', '60', 3],
    ['500 (not repeated)', cfJson(500), 503, 'unavailable', '60', 1],
    ['501', cfJson(501), 502, 'rejected', undefined, 1],
    ['502 on every attempt', cfJson(502), 503, 'unavailable', '60', 3],
    ['503 on every attempt, text body', { status: 503, body: `Service Unavailable ${MARKER}` }, 503, 'unavailable', '60', 3],
    ['504 on every attempt', cfJson(504), 503, 'unavailable', '60', 3],
    ['505 (not repeated)', cfJson(505), 503, 'unavailable', '60', 1],
    ['ECONNRESET on every attempt', { error: 'ECONNRESET' }, 503, 'unavailable', '60', 3],
    ['ECONNREFUSED on every attempt', { error: 'ECONNREFUSED' }, 503, 'unavailable', '60', 3],
    ['ENOTFOUND on every attempt', { error: 'ENOTFOUND' }, 503, 'unavailable', '60', 3],
    ['EHOSTUNREACH (a network code not repeated)', { error: 'EHOSTUNREACH' }, 503, 'unavailable', '60', 1],
    ['no answer: the request timer fires on every attempt', 'hang', 503, 'unavailable', '60', 3],
  ];

  for (const [name, answer, status, klass, retryAfter, requests] of rows) {
    test(`${name} → ${status}${retryAfter ? `, Retry-After ${retryAfter}` : ''}, ${requests} request(s)`, async () => {
      const out = await run({ mode: 'awg2' }, answer);
      assertRefusal(out, status, klass, retryAfter);
      assert.equal(out.apiCalls, requests);
    });
  }
});

describe('the later steps of one registration', () => {
  test('PATCH 429 after a good POST → 429 rate_limited, no config', async () => {
    const out = await run({ mode: 'awg2' }, (n) => (n === 1 ? registrationAnswer() : cfJson(429)));
    assertRefusal(out, 429, 'rate_limited', '60');
    assert.equal(out.apiCalls, 4, 'POST once, PATCH three times');
  });

  test('2xx without peers → 502 after POST and PATCH', async () => {
    const out = await run({ mode: 'awg2' }, registrationAnswer({ result: { id: 'harness-id', token: 't', config: {} } }));
    assertRefusal(out, 502, 'rejected', undefined);
    assert.equal(out.apiCalls, 2);
  });

  for (const v4 of ['', '300.1.1.1', 'fd01::2']) {
    test(`2xx with IPv4 ${JSON.stringify(v4)} → 502`, async () => {
      const out = await run({ mode: 'awg2' }, registrationAnswer({ v4 }));
      assertRefusal(out, 502, 'rejected', undefined);
    });
  }

  test('a failing GET after PATCH still falls back to the POST config (unchanged)', async () => {
    const out = await run({ mode: 'awg2' }, (n) => (n === 3 ? cfJson(403) : registrationAnswer()));
    assert.equal(out.status, 200);
    assert.equal(out.apiCalls, 3);
  });
});

describe('repeats that help', () => {
  test('503, then 200 → the config', async () => {
    const out = await run({ mode: 'awg2' }, (n) => (n === 1 ? cfJson(503) : registrationAnswer()));
    assert.equal(out.status, 200);
    assert.equal(out.apiCalls, 4);
  });

  test('ECONNRESET, then 200 → the config', async () => {
    const out = await run({ mode: 'awg2' }, (n) => (n === 1 ? { error: 'ECONNRESET' } : registrationAnswer()));
    assert.equal(out.status, 200);
  });

  test('count=2: the first registration succeeds, the second gets 429 → 200 with one config (unchanged)', async () => {
    const out = await run({ mode: 'awg2', count: '2' }, (n) => (n <= 3 ? registrationAnswer() : cfJson(429)));
    assert.equal(out.status, 200);
    assert.equal(out.body.count, 1);
    assert.equal(out.body.warning, 'Удалось сгенерировать только 1 из 2 запрошенных конфигураций.');
  });
});

describe('errors outside the registration keep their answers', () => {
  test('a gap in the own CPS chains stays 400 cps_chain_gap, before any registration', async () => {
    const out = await run({ mode: 'awg2', i1: '<b 0x01>', i3: '<b 0x02>' }, cfJson(400));
    assert.equal(out.status, 400);
    assert.equal(out.body.error, 'cps_chain_gap');
    assert.equal(out.apiCalls, 0);
  });

  test('an unknown preset stays 400 with its error, before any registration', async () => {
    const out = await run({ mode: 'awg2', routeMode: 'split', presets: 'no-such-preset' }, cfJson(400));
    assert.equal(out.status, 400);
    assert.match(out.body.error, /Неизвестные пресеты/);
    assert.equal(out.apiCalls, 0);
  });

  test('a 400 from Cloudflare is not a local 400: 502 without `error`', async () => {
    const out = await run({ mode: 'awg2' }, cfJson(400));
    assertRefusal(out, 502, 'rejected', undefined);
  });

  test('an unexpected exception without a class or status stays 500', async () => {
    const registration = require('../src/server/warpRegistration');
    mock.method(registration, 'registerDevice', async () => { throw new TypeError('unexpected'); });
    const out = await run({ mode: 'awg2' }, registrationAnswer());
    assert.equal(out.status, 500);
    assert.equal(out.body.message, 'unexpected');
  });

  test('Lab Auto: a registration failure is answered by its class, never by a hostname config (I11)', async () => {
    const out = await run({ mode: 'awg2', endpointMode: 'lab' }, cfJson(403), { lab: labProvider(labSnapshot(LAB_POOL)) });
    assertRefusal(out, 502, 'rejected', undefined);
  });
});
