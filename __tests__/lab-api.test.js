// __tests__/lab-api.test.js
// /api/lab: read-only transport of the Lab's public export (full mode) or of active-pool.json + lab-status.json
// (compatibility mode). Real exporter output from __tests__/fixtures/lab-public, validated by the page's LabCore.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, before, after } = require('node:test');
const { createLabHandler } = require('../api/lab');
const labPublic = require('../src/server/labPublic');
const Core = require('../public/lab/lab-core.js');
const { writeLabPublic, tempLabDir, readFixture, flatten } = require('./helpers/lab-public');

const root = path.resolve(__dirname, '..');
const dir = tempLabDir();
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const call = (query = {}, { method = 'GET', labDir = dir } = {}) => {
  const headers = {};
  let body = '';
  const res = {
    statusCode: 200,
    setHeader: (k, v) => { headers[k.toLowerCase()] = String(v); },
    end: (chunk) => { body = chunk === undefined ? '' : String(chunk); },
  };
  createLabHandler({ dir: labDir })({ method, query }, res);
  return { status: res.statusCode, headers, body, json: body ? JSON.parse(body) : null };
};

const FORBIDDEN = [/private/i, /token/i, /registration/i, /device_?id/i, /\/etc\//, /var\/lib/, /wg\.key/, /identity/i,
  /systemd/i, /traceback/i, /blacklist/i, /operator/i, /^192\.0\.2\./, /negative_control/, /lab\.db/, /detail/];

const assertPublic = (doc) => {
  for (const item of flatten(doc)) {
    for (const re of FORBIDDEN) assert.doesNotMatch(item, re, `public API leaked ${item}`);
  }
};

const firstId = (overview) => `${overview.endpoints[0].ip}:${overview.endpoints[0].port}`;

test('full mode: overview is the exporter contract, valid for the page, no-store JSON', () => {
  writeLabPublic(dir);
  const r = call();
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(r.headers['cache-control'], 'no-store');
  const o = r.json;
  assert.deepEqual(Object.keys(o).sort(), ['activeHistory', 'counts', 'coverage', 'endpoints', 'events', 'freshness',
    'generatedAt', 'retryAfterSec', 'schemaVersion', 'sessions', 'status'].sort());
  assert.equal(o.coverage, 'full');
  assert.equal(o.retryAfterSec, 60);
  const norm = Core.normalizeOverview(o, Date.now());
  assert.equal(norm.ok, true);
  assert.deepEqual(norm.issues, [], 'real exporter output passes page validation without dropping anything');
  assert.equal(norm.view.endpoints.length, readFixture('web-overview.json').endpoints.length);
  assert.ok(norm.view.activeHistory.length > 0 && norm.view.events.length > 0);
  assert.equal(Core.deriveLabState(norm.view, Date.now()), 'ok');
  assertPublic(o);
});

test('HEAD answers like GET without a body; other methods are 405', () => {
  writeLabPublic(dir);
  const head = call({}, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.ok(Number(head.headers['content-length']) > 100);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = call({ action: 'refresh' }, { method });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, 'GET, HEAD');
    assert.equal(r.json.code, 'method_not_allowed');
  }
  assert.equal(call({ action: 'blacklist', endpoint: undefined }).status, 200, 'unknown parameters do nothing');
});

test('no Lab files (Vercel, forks, no mount): 503 lab_not_available with Retry-After', () => {
  const r = call({}, { labDir: path.join(dir, 'missing') });
  assert.equal(r.status, 503);
  assert.deepEqual(r.json, { success: false, code: 'lab_not_available' });
  assert.equal(r.headers['retry-after'], '60');
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('compatibility mode: only real data from active-pool.json + lab-status.json', () => {
  writeLabPublic(dir, { mode: 'compat' });
  const r = call();
  assert.equal(r.status, 200);
  const o = r.json;
  assert.equal(o.coverage, 'active-only');
  assert.equal(o.activeHistory, undefined, 'no invented history');
  assert.equal(o.events, undefined, 'no invented events');
  const pool = readFixture('active-pool.json');
  assert.equal(o.endpoints.length, pool.endpoints.length);
  for (const e of o.endpoints) {
    assert.equal(e.state, 'ACTIVE');
    assert.equal(e.https, 'ok', 'ACTIVE implies a TLS-verified HTTPS pass');
    assert.equal(e.session, null);
    assert.equal(e.reliability, null);
  }
  assert.deepEqual(o.counts, { active: 8, verified: 0, suspect: 0, quarantine: 0, dead: 1 });
  assert.equal(o.freshness.activeTtlSec, 420, 'derived from expires_at - lab_verified_at of the pool');
  assert.deepEqual([o.sessions.firstSession, o.sessions.retryRescued, o.sessions.failed], [0.8, 0.2, 0]);
  const norm = Core.normalizeOverview(o, Date.now());
  assert.equal(norm.ok, true);
  assert.equal(norm.view.coverage, 'active-only');
  assertPublic(o);
  assert.doesNotMatch(r.body, /probe identity|PROBE_IDENTITY|scheduler|matches_install/);
});

test('compatibility counts are hidden while blacklisted endpoints would be counted in them', () => {
  writeLabPublic(dir, { mode: 'compat' });
  const file = path.join(dir, 'lab-status.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.pool.blacklisted = 2;
  fs.writeFileSync(file, JSON.stringify(doc));
  assert.equal(call().json.counts, null);
});

test('broken files: controlled 503 lab_malformed, never a raw file or stack', () => {
  writeLabPublic(dir);
  const overview = path.join(dir, 'web-overview.json');
  for (const [label, content] of [['not JSON', '{"schemaVersion":1,'], ['wrong schema', '{"schemaVersion":7}'],
    ['bad status', JSON.stringify({ ...readFixture('web-overview.json'), status: 'great' })],
    ['future', JSON.stringify({ ...readFixture('web-overview.json'), generatedAt: '2099-01-01T00:00:00Z' })],
    ['unbounded', JSON.stringify({ ...readFixture('web-overview.json'), endpoints: new Array(501).fill(null) })],
    ['oversized', `{"schemaVersion":1,"pad":"${'x'.repeat(labPublic.MAX_BYTES.overview)}"}`]]) {
    fs.writeFileSync(overview, content);
    const r = call();
    assert.equal(r.status, 503, label);
    assert.deepEqual(r.json, { success: false, code: 'lab_malformed' }, label);
    assert.equal(r.headers['retry-after'], '60');
  }
  writeLabPublic(dir, { mode: 'compat' });
  fs.unlinkSync(path.join(dir, 'lab-status.json'));
  assert.equal(call().json.code, 'lab_malformed', 'half of the compatibility pair');
  writeLabPublic(dir, { mode: 'compat' });
  fs.writeFileSync(path.join(dir, 'active-pool.json'), JSON.stringify({ ...readFixture('active-pool.json'), token: 'x' }));
  assert.equal(call().json.code, 'lab_malformed', 'active-pool.json is validated as strictly as the provider does');
});

test('stale snapshot: 200 with the old data, the page shows STALE and expired endpoints are not ACTIVE', () => {
  writeLabPublic(dir, { ageMs: 40 * 60e3 });
  const r = call();
  assert.equal(r.status, 200);
  const view = Core.normalizeOverview(r.json, Date.now()).view;
  assert.equal(Core.deriveLabState(view, Date.now()), 'stale');
  assert.equal(Core.freshActiveCount(view, Date.now()), 0);
});

test('unknown fields, negative controls and secret-looking values never leave the API', () => {
  writeLabPublic(dir);
  const file = path.join(dir, 'web-overview.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.privateKey = 'AAAA';
  doc.registration_id = 'reg';
  doc.endpoints.push({ ...doc.endpoints[0], ip: '192.0.2.1' }, { ...doc.endpoints[0], ip: '162.159.192.200', source: 'negative_control' });
  doc.endpoints[0].manual_blacklist = 1;
  doc.endpoints[0].note = '/etc/amnezia-endpoint-lab/identity.json';
  doc.events.push({ type: 'restored', endpoint: '192.0.2.5:2408', at: doc.generatedAt, reason: 'operator' });
  doc.counts.blacklisted = 3;
  fs.writeFileSync(file, JSON.stringify(doc));
  const o = call().json;
  assertPublic(o);
  assert.ok(!o.endpoints.some((e) => e.ip === '192.0.2.1' || e.ip === '162.159.192.200'));
  assert.deepEqual(Object.keys(o.endpoints[0]).sort(), ['expiresAt', 'https', 'ip', 'lastVerifiedAt', 'port', 'reliability', 'session', 'source', 'state']);
  assert.deepEqual(Object.keys(o.counts).sort(), ['active', 'dead', 'quarantine', 'suspect', 'verified']);
});

test('endpoint details: valid, unknown, malformed id, ranges, and id mismatch', () => {
  writeLabPublic(dir);
  const overview = call().json;
  const id = firstId(overview);
  const r = call({ endpoint: id, range: '24h' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  const d = r.json;
  assert.deepEqual(Object.keys(d).sort(), ['checks', 'endpoint', 'generatedAt', 'history', 'lastError', 'schemaVersion', 'stability', 'timeline']);
  assert.equal(d.history.range, '24h');
  assert.ok(d.history.buckets.length > 0 && d.history.buckets.length <= 120);
  const norm = Core.normalizeEndpointDetails(d, Date.now());
  assert.equal(norm.ok, true);
  assert.equal(norm.view.endpoint.id, id);
  assert.equal(norm.view.lastErrorKnown, true);
  assertPublic(d);
  for (const range of ['all', '7d', '30d']) assert.equal(call({ endpoint: id, range }).json.history.range, range);
  assert.equal(call({ endpoint: id }).json.history.range, 'all', 'range defaults to all');

  assert.deepEqual(call({ endpoint: '162.159.192.250:2408' }).json, { success: false, code: 'endpoint_not_found' });
  assert.equal(call({ endpoint: '162.159.192.250:2408' }).status, 404);
  for (const bad of ['../../etc/passwd', '162.159.192.1', '162.159.192.1:0', '999.1.1.1:2408', '<b>:1', 'x'.repeat(100)]) {
    const b = call({ endpoint: bad });
    assert.equal(b.status, 400, bad);
    assert.equal(b.json.code, 'endpoint_invalid');
  }
  assert.equal(call({ endpoint: ['a', 'b'] }).status, 400, 'repeated parameter');
  assert.deepEqual(call({ endpoint: id, range: '90d' }).json, { success: false, code: 'range_invalid' });

  // A detail file that names another endpoint is refused, whatever its file name says.
  const other = overview.endpoints.find((e) => `${e.ip}:${e.port}` !== id);
  const otherFile = path.join(dir, 'web-endpoints', labPublic.detailFileName(`${other.ip}:${other.port}`));
  fs.copyFileSync(path.join(dir, 'web-endpoints', labPublic.detailFileName(id)), otherFile);
  assert.deepEqual(call({ endpoint: `${other.ip}:${other.port}` }).json, { success: false, code: 'lab_malformed' });
});

test('compatibility details: only what ACTIVE proves, unknown endpoints are 404', () => {
  writeLabPublic(dir, { mode: 'compat' });
  const pool = readFixture('active-pool.json');
  const id = `${pool.endpoints[0].ip}:${pool.endpoints[0].port}`;
  const r = call({ endpoint: id, range: '7d' });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['checks', 'endpoint', 'generatedAt', 'schemaVersion']);
  assert.deepEqual(Object.values(r.json.checks).map((c) => c.result), ['ok', 'ok', 'ok']);
  const norm = Core.normalizeEndpointDetails(r.json, Date.now());
  assert.equal(norm.ok, true);
  assert.equal(norm.view.lastErrorKnown, false, 'unknown, not "no errors"');
  assert.equal(norm.view.history, null);
  assert.equal(norm.view.timeline, null);
  assert.equal(call({ endpoint: '162.159.193.20:2408' }).status, 404, 'no longer ACTIVE: not in the pool');
});

test('the handler only reads its fixed directory: the request never picks a path', () => {
  const code = (file) => fs.readFileSync(path.join(root, file), 'utf8').split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*\*|\*)/.test(line)).join('\n');
  const src = code('api/lab.js') + code('src/server/labPublic.js');
  assert.doesNotMatch(src,/writeFile|unlink|rmSync|mkdir|appendFile|sqlite|lab\.db|child_process/);
  assert.match(src, /const DEFAULT_DIR = '\/run\/endpoint-lab';/);
  // Same naming as the Python exporter: every file it wrote is found under the id it contains.
  const fixtureDir = path.join(__dirname, 'fixtures', 'lab-public', 'web-endpoints');
  for (const name of fs.readdirSync(fixtureDir)) {
    const ep = JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8')).endpoint;
    assert.equal(labPublic.detailFileName(`${ep.ip}:${ep.port}`), name);
  }
  assert.equal(labPublic.detailFileName('162.159.192.1:2408'), 'a7c340799e3e5ea59e0113e5174c79e0.json');
});

test('size and processing time of real responses', () => {
  writeLabPublic(dir);
  labPublic._cache.clear();
  let t = process.hrtime.bigint();
  const cold = call();
  const coldMs = Number(process.hrtime.bigint() - t) / 1e6;
  t = process.hrtime.bigint();
  for (let i = 0; i < 20; i += 1) call();
  const warmMs = Number(process.hrtime.bigint() - t) / 1e6 / 20;
  const detail = call({ endpoint: firstId(cold.json) });
  console.log(`[lab-api] overview ${cold.body.length} B, cold ${coldMs.toFixed(1)} ms, warm ${warmMs.toFixed(2)} ms; detail ${detail.body.length} B`);
  assert.ok(warmMs < 50, 'file read + validation only');
});

// ── Real self-hosted server ────────────────────────────────────

const PORT = 44500 + Math.floor(Math.random() * 1000);
let server;
const serverDir = tempLabDir();

before(async () => {
  writeLabPublic(serverDir);
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ENDPOINT_LAB_PUBLIC_DIR: serverDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    server.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } });
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
});

after(() => {
  server?.kill();
  fs.rmSync(serverDir, { recursive: true, force: true });
});

test('server.js routes /api/lab with the site headers', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/lab`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.ok(res.headers.get('content-security-policy'));
  const body = await res.json();
  assert.equal(body.coverage, 'full');
  const post = await fetch(`http://127.0.0.1:${PORT}/api/lab`, { method: 'POST' });
  assert.equal(post.status, 405);
  const detail = await fetch(`http://127.0.0.1:${PORT}/api/lab?endpoint=${encodeURIComponent(firstId(body))}&range=24h`);
  assert.equal(detail.status, 200);
});
