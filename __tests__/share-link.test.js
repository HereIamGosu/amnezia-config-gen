// __tests__/share-link.test.js
// Ссылка с настройками генератора (?profile=awg3&routes=youtube,discord…): чистые функции разбора и
// сборки из public/static/share-link.js исполняются в vm так же, как в браузере (window.ShareLink),
// плюс проверки связки со скриптами генератора, вёрсткой настроек, локалями и robots.txt.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { readAppScript } = require('./helpers/frontend-scripts');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const source = read('public/static/share-link.js');
const html = read('public/index.html');
// Связка с интерфейсом: применение и копирование ссылки — settings-link.js, модал настроек —
// settings.js, профиль из ссылки — script.js (__tests__/helpers/frontend-scripts.js).
const script = readAppScript('script.js');
const settings = readAppScript('settings.js');
const settingsLink = readAppScript('settings-link.js');

/** Исполняет файл как классический браузерный скрипт: результат — window.ShareLink. */
const loadInBrowserContext = () => {
  const context = { URL, URLSearchParams };
  context.window = context;
  vm.runInNewContext(source, context, { filename: 'share-link.js' });
  return context.ShareLink;
};

const ShareLink = loadInBrowserContext();
/** Значения из vm-контекста имеют чужие прототипы: сравниваем как обычные данные. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const fallback = JSON.parse(read('public/static/presets-fallback.json'));
const CATALOGUE = {
  routes: fallback.presets.map((p) => p.id),
  dns: fallback.dnsPresets.map((d) => d.id),
};

const DEFAULT_STATE = {
  profile: 'awg2',
  routes: [],
  dns: fallback.dnsDefault,
  dnsDefault: fallback.dnsDefault,
  device: 'universal',
  ipv6: false,
  cps: 'auto',
  cps5: false,
  endpoint: 'hostname',
  port: 4500,
  count: 1,
};

test('the browser build exposes window.ShareLink and the Node build exports the same API', () => {
  assert.equal(typeof ShareLink.parseShareParams, 'function');
  const viaRequire = require('../public/static/share-link.js');
  assert.deepEqual(Object.keys(viaRequire).sort(), Object.keys(ShareLink).sort());
});

test('a full share link is parsed into validated settings', () => {
  const parsed = ShareLink.parseShareParams(
    '?profile=awg3&routes=youtube,discord&dns=adguard&port=2408&ipv6=1&device=router&cps=stun&cps5=1&count=2&endpoint=162.159.192.1',
    CATALOGUE,
  );
  assert.deepEqual(plain(parsed), {
    profile: 'awg3',
    routes: ['youtube', 'discord'],
    dns: 'adguard',
    device: 'router',
    ipv6: true,
    cps: 'stun',
    cps5: true,
    endpoint: '162.159.192.1',
    port: 2408,
    count: 2,
  });
  assert.deepEqual(plain(ShareLink.parseShareParams('profile=legacy', CATALOGUE)), { profile: 'legacy' }, 'leading "?" is optional');
  assert.deepEqual(plain(ShareLink.parseShareParams('', CATALOGUE)), {});
});

test('unknown or invalid values are ignored, never passed through', () => {
  const parsed = ShareLink.parseShareParams(
    '?profile=awg9&routes=nope,<script>&dns=evil.example&port=51820&device=tablet&cps=custom&count=7&endpoint=1.2.3.4&ipv6=yes&cps5=2',
    CATALOGUE,
  );
  assert.deepEqual(plain(parsed), {});
  for (const port of ['0', '-1', '2408abc', '4500.5', '99999', ' ', '2408,4500']) {
    assert.equal(ShareLink.parseShareParams(`port=${encodeURIComponent(port)}`).port, undefined, `port=${port}`);
  }
  for (const count of ['0', '4', '1.5', 'two']) {
    assert.equal(ShareLink.parseShareParams(`count=${count}`).count, undefined, `count=${count}`);
  }
});

test('routes: only catalogue ids, de-duplicated, order kept; no catalogue means no routes or DNS', () => {
  const parsed = ShareLink.parseShareParams('routes=discord,unknown,youtube,discord,,%20steam%20&dns=quad9', CATALOGUE);
  assert.deepEqual(plain(parsed.routes), ['discord', 'youtube', 'steam']);
  assert.equal(parsed.dns, 'quad9');
  const offline = ShareLink.parseShareParams('routes=youtube&dns=quad9&port=2408');
  assert.deepEqual(plain(offline), { port: 2408 });
  assert.equal(ShareLink.parseShareParams('routes=unknown', CATALOGUE).routes, undefined, 'no valid route → full tunnel stays');
});

test('mobile devices never get IPv6 from a link (invariant I7 / mobile cascade)', () => {
  for (const device of ['mobile', 'mobile-router']) {
    const parsed = ShareLink.parseShareParams(`device=${device}&ipv6=1`, CATALOGUE);
    assert.equal(parsed.device, device);
    assert.notEqual(parsed.ipv6, true, `${device} must not enable IPv6`);
    assert.equal(ShareLink.buildShareQuery({ ...DEFAULT_STATE, device, ipv6: true }).includes('ipv6'), false);
  }
  assert.equal(ShareLink.parseShareParams('device=router&ipv6=1').ipv6, true);
});

test('device names map to the mobile/router toggles and back', () => {
  for (const device of ShareLink.DEVICES) {
    const { mobile, router } = ShareLink.flagsOfDevice(device);
    assert.equal(ShareLink.deviceOf(mobile, router), device);
  }
});

test('the canonical link carries only non-default values in a stable order', () => {
  assert.equal(ShareLink.buildShareQuery(DEFAULT_STATE), '');
  assert.equal(
    ShareLink.buildShareUrl('https://awgconfig.com/?utm_source=tg&profile=legacy#faq', DEFAULT_STATE),
    'https://awgconfig.com/',
    'old parameters and the hash are dropped',
  );
  const state = {
    ...DEFAULT_STATE,
    profile: 'awg3',
    routes: ['youtube', 'discord'],
    dns: 'adguard',
    port: 2408,
    ipv6: true,
    device: 'router',
    cps: 'stun',
    count: 2,
    endpoint: '162.159.192.1',
  };
  const query = ShareLink.buildShareQuery(state);
  assert.equal(query, 'profile=awg3&routes=youtube,discord&dns=adguard&device=router&ipv6=1&cps=stun&endpoint=162.159.192.1&port=2408&count=2');
  assert.equal(ShareLink.buildShareUrl('https://awgconfig.com/en?x=1', state), `https://awgconfig.com/en?${query}`, '/en keeps its path');
  // Разбор канонической ссылки возвращает те же настройки.
  const parsed = ShareLink.parseShareParams(query, CATALOGUE);
  assert.deepEqual(plain(parsed), {
    profile: 'awg3', routes: ['youtube', 'discord'], dns: 'adguard', device: 'router', ipv6: true,
    cps: 'stun', endpoint: '162.159.192.1', port: 2408, count: 2,
  });
});

test('allowed values match the settings controls and the API allowlist', () => {
  const optionsOf = (selectId) => {
    const block = new RegExp(`<select id="${selectId}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
    assert.ok(block, `#${selectId} exists`);
    return [...block[1].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  };
  const radiosOf = (name) => [...html.matchAll(new RegExp(`name="${name}" value="([^"]+)"`, 'g'))].map((m) => m[1]);
  assert.deepEqual(optionsOf('warpPortSelect').map(Number), [...ShareLink.PORTS]);
  assert.deepEqual(optionsOf('warpEndpointSelect'), [...ShareLink.ENDPOINTS]);
  assert.deepEqual(radiosOf('cpsProtocol'), [...ShareLink.CPS_PROTOCOLS]);
  assert.deepEqual(radiosOf('configCount').map(Number), [...ShareLink.COUNTS]);
  assert.deepEqual(radiosOf('awgProfile'), [...ShareLink.PROFILES]);
  const apiPorts = /const PORT_ALLOWLIST = \[([^\]]+)\]/.exec(read('api/warp.js'))[1].split(',').map((p) => Number(p.trim()));
  assert.deepEqual([...apiPorts].sort((a, b) => a - b), [...ShareLink.PORTS].sort((a, b) => a - b));
});

test('the generator applies the link after the catalogue is loaded and keeps the mobile cascade', () => {
  const start = settingsLink.indexOf('const applySharedSettings = () => {');
  const end = settingsLink.indexOf('\n};', start);
  assert.ok(start > 0 && end > start, 'applySharedSettings exists');
  const body = settingsLink.slice(start, end);
  assert.match(body, /shareLink\.parseShareParams\(window\.location\.search, \{/);
  assert.match(body, /routes: cfgState\.presets\.map/);
  assert.match(body, /dns: cfgState\.dnsPresets\.map/);
  assert.match(body, /cfgState\.routeMode = ROUTE_MODES\.SPLIT/, 'routes in the link imply split routing');
  assert.match(body, /applyMobileModeCascade\(\)/);
  // Профиль не зависит от каталога: выставляется сразу, ссылка важнее запомненного, но не сохраняется.
  const profileInit = script.slice(script.indexOf('const initProfileSelector = () => {'), script.indexOf('let generationInFlight'));
  assert.match(profileInit, /const linked = shareLink \? shareLink\.parseShareParams\(window\.location\.search\)\.profile : undefined;/);
  assert.match(profileInit, /const initial = linked \|\| saved;/);

  const init = settings.slice(settings.indexOf('const initSettingsPanel = async'));
  const loaded = init.indexOf('cfgState.dnsPresets = data.dnsPresets');
  const applied = init.indexOf('applySharedSettings();');
  assert.ok(loaded > 0 && applied > loaded, 'applied only after the presets catalogue is known');
  assert.ok(applied < init.indexOf('updateRouteModeUI(cfgState.routeMode)'), 'route mode UI and chips are refreshed afterwards');
  assert.ok(applied < init.indexOf('updateParamChips();', applied));
});

test('settings dialog has a "Copy settings link" action next to "Done", localized in both languages', () => {
  const footer = /<footer class="modal__footer settings-modal__footer">([\s\S]*?)<\/footer>/.exec(html);
  assert.ok(footer, 'settings footer exists');
  assert.match(footer[1], /id="settingsShareLink"[\s\S]*data-i18n="settings_share_btn"[\s\S]*data-i18n="settings_apply"/);
  assert.match(settings, /getElementById\('settingsShareLink'\)\?\.addEventListener\('click', copySettingsLink\)/);
  assert.match(settingsLink, /const copySettingsLink = async[\s\S]*?copyText\(url\)[\s\S]*?toast\(/);
  assert.ok(html.indexOf('static/share-link.js') < html.indexOf('static/script.js'), 'share-link.js loads before script.js');
  assert.ok(html.indexOf('static/share-link.js') < html.indexOf('static/settings-link.js'),
    'settings-link.js reads window.ShareLink when it loads');
  const ru = JSON.parse(read('public/locales/ru.json'));
  const en = JSON.parse(read('public/locales/en.json'));
  for (const key of ['settings_share_btn', 'settings_share_title', 'settings_share_copied']) {
    assert.ok(ru[key], `ru.${key}`);
    assert.ok(en[key], `en.${key}`);
  }
  assert.equal(ru.settings_share_btn, 'Скопировать ссылку на настройки');
  assert.equal(en.settings_share_btn, 'Copy settings link');
});

test('robots.txt: Yandex Clean-param folds settings links into the page', () => {
  const robots = read('public/robots.txt');
  const yandex = robots.slice(robots.indexOf('User-agent: Yandex'));
  const lines = [...yandex.matchAll(/^Clean-param:.*$/gm)].map((m) => m[0]);
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.match(line, /^Clean-param: [A-Za-z0-9_]+(?:&[A-Za-z0-9_]+)*(?: \/\S*)?$/, `valid syntax: ${line}`);
    assert.ok(line.length <= 500, 'Yandex limits a Clean-param rule to 500 characters');
  }
  const cleaned = new Set(lines.flatMap((line) => line.slice('Clean-param: '.length).split(' ')[0].split('&')));
  for (const name of ShareLink.PARAM_NAMES) assert.ok(cleaned.has(name), `Clean-param covers ${name}`);
  // Ссылки с настройками не меняют канонический адрес страницы.
  assert.match(html, /<link rel="canonical" href="https:\/\/awgconfig\.com\/" \/>/);
});
