#!/usr/bin/env node
// e2e/run.js — `npm run test:e2e`
// Поднимает server.js на свободном порту (заголовки и CSP из vercel.json), запускает headless Chrome
// и прогоняет e2e/*.e2e.js через node:test по одному файлу. Без новых зависимостей: CDP поверх
// встроенного WebSocket Node 22.
//
// Переменные окружения:
//   CHROME_PATH         — путь к Chrome/Chromium (иначе стандартные места установки);
//   E2E_REQUIRE_CHROME=1 — без Chrome падать, а не пропускать (CI);
//   E2E_PORT            — порт сервера (по умолчанию свободный);
//   E2E_PUBLIC_DIR      — отдавать другую копию public/ (например, собранную scripts/build-assets.js).
// Публичные файлы Endpoint Lab: сервер читает пустой временный каталог (ENDPOINT_LAB_PUBLIC_DIR), тесты Lab
// кладут в него данные сами (E2E_LAB_DIR); каталог удаляется после прогона.
// Аргументы после `--` — фильтр файлов: `npm run test:e2e -- generate` прогонит generate.e2e.js.
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { findChrome, launchChrome } = require('./lib/chrome');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const out = (line) => process.stdout.write(`${line}\n`);

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

const LAB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awg-e2e-lab-'));

const startServer = async (port) => {
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', ENDPOINT_LAB_PUBLIC_DIR: LAB_DIR };
  if (process.env.E2E_PUBLIC_DIR) env.PUBLIC_DIR = path.resolve(process.env.E2E_PUBLIC_DIR);
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const keep = (chunk) => { log = (log + chunk).slice(-8000); };
  proc.stdout.on('data', keep);
  proc.stderr.on('data', keep);
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    if (proc.exitCode !== null) break;
    try {
      const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return { proc, baseUrl, log: () => log };
    } catch { /* ещё стартует */ }
    await sleep(100);
  }
  proc.kill();
  throw new Error(`server.js did not start on ${baseUrl}\n${log}`);
};

const stopProcess = async (proc) => {
  if (!proc || proc.exitCode !== null) return;
  proc.kill();
  await Promise.race([new Promise((resolve) => proc.once('exit', resolve)), sleep(5000)]);
};

const main = async () => {
  const chromePath = findChrome();
  if (!chromePath) {
    const msg = 'e2e: Chrome/Chromium not found (set CHROME_PATH). Browser tests skipped.';
    if (process.env.E2E_REQUIRE_CHROME === '1') {
      out(`${msg} E2E_REQUIRE_CHROME=1 — failing.`);
      return 1;
    }
    out(msg);
    return 0;
  }

  const filters = process.argv.slice(2);
  const files = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.e2e.js'))
    .filter((f) => !filters.length || filters.some((part) => f.includes(part)))
    .sort()
    .map((f) => path.join(__dirname, f));
  if (!files.length) {
    out(`e2e: no test files match ${filters.join(', ')}`);
    return 1;
  }

  const port = Number(process.env.E2E_PORT) || await freePort();
  let server = null;
  let chrome = null;
  const cleanup = async () => {
    await Promise.all([chrome && chrome.close(), stopProcess(server && server.proc)]);
    fs.rmSync(LAB_DIR, { recursive: true, force: true });
  };
  process.once('SIGINT', () => { cleanup().finally(() => process.exit(130)); });

  try {
    server = await startServer(port);
    chrome = await launchChrome(chromePath);
    out(`e2e: server ${server.baseUrl}, Chrome ${chromePath}`);
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', ...files], {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, E2E_BASE_URL: server.baseUrl, E2E_BROWSER_WS: chrome.wsUrl, E2E_LAB_DIR: LAB_DIR },
      });
      child.on('exit', (exitCode, signal) => resolve(signal ? 1 : exitCode));
    });
    if (code !== 0) out(`e2e: server log tail:\n${server.log()}`);
    return code;
  } finally {
    await cleanup();
  }
};

main().then((code) => { process.exitCode = code; }, (err) => {
  out(`e2e: ${err.stack || err}`);
  process.exitCode = 1;
});
