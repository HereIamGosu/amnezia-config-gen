// __tests__/warp-registration-stats.test.js
// Passive counters of WARP registration outcomes (3.1.8, R5 4.D "Лог на сервере"): one outcome per registration,
// one line `[warp-registration-stats]` per 10-minute window that had a registration and one at shutdown, numbers
// and the profile name only. The window timer never keeps a process alive. No network.

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const { generate, registrationAnswer } = require('./helpers/warp-harness');
const { freePort } = require('./helpers/free-port');
const registration = require('../src/server/warpRegistration');

const ROOT = path.resolve(__dirname, '..');
const LINE = /^\[warp-registration-stats\] window=600s profile=legacy ok=(\d+) ok_ipv4_only=(\d+) rate_limited=(\d+) unavailable=(\d+) rejected=(\d+) malformed=(\d+)$/;
const cfStatus = (status) => ({ status, body: JSON.stringify({ success: false }) });

beforeEach(() => {
  registration.__stats.reset();
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
});
afterEach(() => {
  registration.__stats.reset();
  mock.timers.reset();
  mock.restoreAll();
});

/** Settles `promise` on mocked setTimeout (retry pauses, request timers). */
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

const flushed = () => {
  const lines = [];
  const line = registration.flushRegistrationStats((l) => lines.push(l));
  assert.equal(lines.length, line ? 1 : 0);
  return line;
};

describe('one outcome per registration', () => {
  test('200, 429, 503 → ok=1 rate_limited=1 unavailable=1', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    for (const answer of [registrationAnswer(), cfStatus(429), cfStatus(503)]) await drive(generate({ mode: 'awg2' }, { cloudflare: answer }));
    assert.equal(flushed(), '[warp-registration-stats] window=600s profile=legacy ok=1 ok_ipv4_only=0 rate_limited=1 unavailable=1 rejected=0 malformed=0');
  });

  test('every class and the IPv4-only success have their own counter', async () => {
    const answers = [
      registrationAnswer({ v6: null }), cfStatus(403), cfStatus(501), { status: 200, body: 'not json' },
      registrationAnswer({ v4: '300.1.1.1' }), cfStatus(408), { error: 'EHOSTUNREACH' },
    ];
    for (const answer of answers) await generate({ mode: 'awg2' }, { cloudflare: answer });
    assert.equal(flushed(), '[warp-registration-stats] window=600s profile=legacy ok=0 ok_ipv4_only=1 rate_limited=0 unavailable=2 rejected=2 malformed=2');
  });

  test('count=3 is three registrations; mobile=1 without IPv6 in the answer counts as ok_ipv4_only', async () => {
    await generate({ mode: 'awg2', count: '3' }, { cloudflare: registrationAnswer() });
    await generate({ mode: 'awg2', mobile: '1' }, { cloudflare: registrationAnswer({ v6: null }) });
    assert.match(flushed(), / ok=3 ok_ipv4_only=1 /);
  });

  test('a request refused before registration counts nothing', async () => {
    await generate({ mode: 'awg2', routeMode: 'split', presets: 'no-such-preset' });
    await generate({ mode: 'awg2', i1: '<b 0x01>', i3: '<b 0x02>' });
    assert.equal(flushed(), null);
  });
});

describe('the line', () => {
  test('an empty window writes nothing; a flush starts a new window', async () => {
    assert.equal(flushed(), null);
    await generate({ mode: 'awg2' }, { cloudflare: registrationAnswer() });
    assert.match(flushed(), / ok=1 /);
    assert.equal(flushed(), null);
  });

  // Placeholder secrets only (token 't'); the token itself is checked by secret-leakage.test.js.
  test('numbers and the profile name only: no address, id, key or Cloudflare text', async () => {
    const answers = [
      registrationAnswer({ id: 'stats-id-marker' }),
      { status: 403, body: JSON.stringify({ message: 'stats-text-marker' }) },
    ];
    for (const answer of answers) await generate({ mode: 'awg2' }, { cloudflare: answer });
    const line = flushed();
    assert.match(line, LINE);
    assert.doesNotMatch(line, /marker|172\.16|fd01|162\.159|10\.0\.0\.1|=[A-Za-z0-9+/]{20,}/);
  });

  test('every 10 minutes from the first registration, only for a window that had one', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    const log = mock.method(console, 'log', () => {});
    await generate({ mode: 'awg2' }, { cloudflare: registrationAnswer() });
    mock.timers.tick(10 * 60 * 1000 - 1);
    assert.equal(log.mock.callCount(), 0);
    mock.timers.tick(1);
    assert.deepEqual(log.mock.calls.map((c) => c.arguments[0]), ['[warp-registration-stats] window=600s profile=legacy ok=1 ok_ipv4_only=0 rate_limited=0 unavailable=0 rejected=0 malformed=0']);
    mock.timers.tick(10 * 60 * 1000);
    assert.equal(log.mock.callCount(), 1, 'a window without a registration writes nothing');
  });

  test('the window timer does not keep the process alive', async () => {
    await generate({ mode: 'awg2' }, { cloudflare: registrationAnswer() });
    assert.equal(registration.__stats.timer().hasRef(), false);
    const child = spawnSync(process.execPath, ['-e', `
      const https = require('node:https');
      const { EventEmitter } = require('node:events');
      https.request = (o, cb) => {
        const req = new EventEmitter();
        req.write = () => {}; req.destroy = () => {};
        req.end = () => setImmediate(() => { const res = new EventEmitter(); res.statusCode = 403; cb(res); res.emit('end'); });
        return req;
      };
      require('./src/server/warpRegistration').registerDevice('k').catch(() => console.log('registered once'));
    `], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.error, undefined, 'the child exited on its own');
    assert.equal(child.status, 0);
    assert.equal(child.stdout.trim(), 'registered once');
  });
});

describe('server.js writes the line when it stops', () => {
  test('a stop after a registration writes the window; a stop without one writes nothing', async () => {
    for (const [withRegistration, expected] of [[true, / unavailable=1 /], [false, null]]) {
      const port = await freePort();
      const helpers = path.join(__dirname, 'helpers');
      const server = spawn(process.execPath, ['--require', path.join(helpers, 'offline-network.js'), '--require', path.join(helpers, 'sigterm-on-stdin.js'), 'server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ENDPOINT_LAB_PUBLIC_DIR: path.join(ROOT, '__tests__', 'no-lab-dir') },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      server.stdout.on('data', (chunk) => { stdout += chunk; });
      const exited = new Promise((resolve) => server.on('exit', resolve));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
        server.stdout.on('data', () => { if (stdout.includes('listening')) { clearTimeout(timer); resolve(); } });
      });
      if (withRegistration) assert.equal((await fetch(`http://127.0.0.1:${port}/api/warp`)).status, 503);
      server.stdin.write('stop\n');
      assert.equal(await exited, 0);
      const lines = stdout.split('\n').filter((l) => l.startsWith('[warp-registration-stats]'));
      if (expected) {
        assert.equal(lines.length, 1, stdout);
        assert.match(lines[0], LINE);
        assert.match(lines[0], expected);
      } else {
        assert.deepEqual(lines, []);
      }
    }
  });
});
