const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, before, after } = require('node:test');

// Checks the Cache-Control the self-hosted server actually sends. server.js applies every
// matching vercel.json rule in order and the last one wins, so rule order matters.
const root = path.resolve(__dirname, '..');
const PORT = 41000 + Math.floor(Math.random() * 2000);
let server;

before(async () => {
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    server.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } });
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
});

after(() => { server?.kill(); });

const cacheControl = async (pathname) => (await fetch(`http://127.0.0.1:${PORT}${pathname}`, { method: 'HEAD' })).headers.get('cache-control');

test('presets-fallback.json is revalidated, not cached for a year', async () => {
  assert.equal(await cacheControl('/static/presets-fallback.json'), 'public, max-age=0, must-revalidate');
});

test('versioned static assets are immutable', async () => {
  assert.equal(await cacheControl('/static/script.js?v=1'), 'public, max-age=31536000, immutable');
  assert.equal(await cacheControl('/static/icon.svg'), 'public, max-age=31536000, immutable');
});

test('HTML entry points and API are not cached', async () => {
  assert.equal(await cacheControl('/'), 'public, max-age=0, must-revalidate');
  assert.equal(await cacheControl('/status.html'), 'public, max-age=0, must-revalidate');
  assert.equal(await cacheControl('/api/status'), 'no-store');
});
