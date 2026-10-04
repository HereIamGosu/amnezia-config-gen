// __tests__/server-precompressed.test.js
// server.js serves the .br/.gz siblings written by scripts/build-assets.js: Brotli first, then
// gzip, only when Accept-Encoding allows it, never for Range requests, with the original
// Content-Type, Vary: Accept-Encoding and the unchanged vercel.json headers. Bodies decode to
// the exact built file.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { test, before, after } = require('node:test');

const { build } = require('../scripts/build-assets');

const root = path.resolve(__dirname, '..');
const PORT = 43000 + Math.floor(Math.random() * 2000);
const site = fs.mkdtempSync(path.join(os.tmpdir(), 'awg-precompressed-'));
let server;

const write = (rel, content) => {
  const file = path.join(site, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

/** Raw HTTP request: no automatic decompression (fetch would hide Content-Encoding). */
const request = (pathname, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject);
  req.end();
});

const decode = (res) => {
  if (res.headers['content-encoding'] === 'br') return zlib.brotliDecompressSync(res.body);
  if (res.headers['content-encoding'] === 'gzip') return zlib.gunzipSync(res.body);
  return res.body;
};

const built = (rel) => fs.readFileSync(path.join(site, rel));

before(async () => {
  const lines = Array.from({ length: 300 }, (_, i) => `  value${i}: 'настройка ${i}',`).join('\n');
  write('static/app.js', `const SETTINGS = {\n${lines}\n};\nfunction readSetting(key) {\n  return SETTINGS[key];\n}\n`);
  // Distinct rules: esbuild drops duplicate ones.
  write('static/styles.css', Array.from({ length: 100 }, (_, i) => `.row-${i} {\n  display: flex;\n  gap: ${i}px;\n}\n`).join(''));
  write('static/stale.css', Array.from({ length: 100 }, (_, i) => `.stale-${i} {\n  color: red;\n}\n`).join(''));
  write('static/logo.png', Buffer.alloc(4096, 3));
  write('index.html', `<!doctype html><html><head><title>t</title></head><body>${'<p>Генератор</p>\n'.repeat(300)}</body></html>`);
  write('404.html', '<!doctype html><title>404</title>');
  write('tiny.txt', 'ok');
  await build(site, { force: true });
  // A source edited after the build must not be shadowed by its old siblings.
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(site, 'static/stale.css'), later, later);

  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', PUBLIC_DIR: site, APP_REVISION: 'b'.repeat(40) },
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
  fs.rmSync(site, { recursive: true, force: true });
});

test('Brotli is preferred; the response keeps the original type and the vercel.json headers', async () => {
  const res = await request('/static/app.js?v=1', { headers: { 'accept-encoding': 'gzip, deflate, br' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'br');
  assert.equal(res.headers['content-type'], 'application/javascript; charset=utf-8');
  assert.equal(res.headers.vary, 'Accept-Encoding');
  assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(res.headers['content-security-policy']);
  assert.equal(res.headers['x-app-revision'], 'b'.repeat(40));
  assert.equal(Number(res.headers['content-length']), res.body.length);
  assert.equal(res.body.length, built('static/app.js.br').length);
  assert.ok(res.body.length < built('static/app.js').length);
  assert.deepEqual(decode(res), built('static/app.js'));
});

test('gzip is used when Brotli is not acceptable', async () => {
  for (const acceptEncoding of ['gzip', 'gzip, deflate', 'br;q=0, gzip;q=0.8', 'deflate, gzip;q=1.0, *;q=0']) {
    const res = await request('/static/styles.css', { headers: { 'accept-encoding': acceptEncoding } });
    assert.equal(res.headers['content-encoding'], 'gzip', acceptEncoding);
    assert.equal(res.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal(res.headers.vary, 'Accept-Encoding');
    assert.deepEqual(decode(res), built('static/styles.css'), acceptEncoding);
  }
});

test('a wildcard accepts Brotli; no or refused encodings get the plain file with Vary', async () => {
  assert.equal((await request('/static/styles.css', { headers: { 'accept-encoding': '*' } })).headers['content-encoding'], 'br');
  for (const headers of [{}, { 'accept-encoding': 'identity' }, { 'accept-encoding': 'br;q=0, gzip;q=0' }, { 'accept-encoding': 'deflate' }]) {
    const res = await request('/static/app.js', { headers });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], undefined, JSON.stringify(headers));
    assert.equal(res.headers.vary, 'Accept-Encoding', 'caches must still key on Accept-Encoding');
    assert.deepEqual(res.body, built('static/app.js'));
  }
});

test('Range requests always get the plain file', async () => {
  const res = await request('/static/app.js', { headers: { 'accept-encoding': 'br, gzip', range: 'bytes=0-99' } });
  assert.equal(res.headers['content-encoding'], undefined);
  assert.deepEqual(res.body, built('static/app.js'));
});

test('HTML entry points are precompressed and keep their revalidation policy', async () => {
  const res = await request('/', { headers: { 'accept-encoding': 'br' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'br');
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'public, max-age=0, must-revalidate');
  assert.deepEqual(decode(res), built('index.html'));
});

test('HEAD reports the encoded length without a body', async () => {
  const res = await request('/static/app.js', { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(Number(res.headers['content-length']), built('static/app.js.gz').length);
  assert.equal(res.body.length, 0);
});

test('each representation has its own ETag and revalidates to 304', async () => {
  const br = await request('/static/app.js', { headers: { 'accept-encoding': 'br' } });
  const plain = await request('/static/app.js');
  assert.notEqual(br.headers.etag, plain.headers.etag);
  const notModified = await request('/static/app.js', { headers: { 'accept-encoding': 'br', 'if-none-match': br.headers.etag } });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.vary, 'Accept-Encoding');
  const changed = await request('/static/app.js', { headers: { 'if-none-match': br.headers.etag } });
  assert.equal(changed.status, 200, 'a Brotli validator does not match the plain representation');
});

test('files without a sibling, binaries and stale siblings are served plain', async () => {
  for (const pathname of ['/static/logo.png', '/tiny.txt', '/static/stale.css']) {
    const res = await request(pathname, { headers: { 'accept-encoding': 'br, gzip' } });
    assert.equal(res.status, 200, pathname);
    assert.equal(res.headers['content-encoding'], undefined, pathname);
    assert.equal(res.headers.vary, undefined, pathname);
    assert.deepEqual(res.body, built(pathname.slice(1)), pathname);
  }
  assert.equal((await request('/static/logo.png')).headers['content-type'], 'image/png');
});

test('siblings are not addressable directly', async () => {
  for (const pathname of ['/static/app.js.br', '/static/app.js.gz', '/index.html.br']) {
    assert.ok(fs.existsSync(path.join(site, pathname.slice(1))), `${pathname} exists on disk`);
    const res = await request(pathname, { headers: { 'accept-encoding': 'br, gzip' } });
    assert.equal(res.status, 404, pathname);
  }
});
