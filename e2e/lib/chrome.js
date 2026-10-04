// e2e/lib/chrome.js
// Поиск и запуск headless Chrome без зависимостей. Порт отладки выбирает сам Chrome
// (--remote-debugging-port=0) и пишет его в DevToolsActivePort профиля — конфликтов портов нет.
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const windowsCandidates = () => {
  const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  return roots.flatMap((root) => [
    path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(root, 'Chromium', 'Application', 'chrome.exe'),
  ]);
};

const macCandidates = () => [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

const LINUX_BINARIES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];

const whichLinux = (name) => {
  const result = spawnSync('which', [name], { encoding: 'utf8' });
  const found = result.status === 0 ? result.stdout.trim() : '';
  return found || null;
};

/** Путь к Chrome: CHROME_PATH, затем стандартные места установки. null — Chrome не найден. */
const findChrome = () => {
  if (process.env.CHROME_PATH) {
    return fs.existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null;
  }
  if (process.platform === 'win32') return windowsCandidates().find((p) => fs.existsSync(p)) || null;
  if (process.platform === 'darwin') return macCandidates().find((p) => fs.existsSync(p)) || null;
  for (const name of LINUX_BINARIES) {
    const found = whichLinux(name);
    if (found) return found;
  }
  return null;
};

/**
 * Запускает headless Chrome с одноразовым профилем.
 * @returns {Promise<{ wsUrl: string, close: () => Promise<void> }>}
 */
const launchChrome = async (executable) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awg-e2e-chrome-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
  ];
  // Раннеры CI на Linux часто не дают Chrome собственную песочницу (AppArmor / user namespaces).
  // Страницы здесь — только локальный сайт, внешние запросы тестами заблокированы.
  if (process.platform === 'linux' && process.env.CI) args.push('--no-sandbox');
  args.push('about:blank');

  const proc = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });

  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  let wsUrl = null;
  for (let i = 0; i < 150 && !wsUrl; i += 1) {
    if (proc.exitCode !== null) break;
    try {
      const [port, wsPath] = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
      if (port && wsPath) wsUrl = `ws://127.0.0.1:${port}${wsPath}`;
    } catch { /* ещё не создан */ }
    if (!wsUrl) await sleep(100);
  }
  if (!wsUrl) {
    proc.kill();
    throw new Error(`Chrome did not start (${executable}).\n${stderr}`);
  }

  const close = async () => {
    if (proc.exitCode === null) {
      proc.kill();
      await Promise.race([new Promise((resolve) => proc.once('exit', resolve)), sleep(5000)]);
    }
    // Chrome отпускает файлы профиля не сразу (особенно на Windows).
    for (let i = 0; i < 10; i += 1) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
        return;
      } catch {
        await sleep(300);
      }
    }
  };

  return { wsUrl, close };
};

module.exports = { findChrome, launchChrome };
