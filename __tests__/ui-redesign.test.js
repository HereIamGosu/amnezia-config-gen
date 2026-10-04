// __tests__/ui-redesign.test.js
// Контракт интерфейса 2.8 (тёмная дизайн-система): маскировка ключа в превью, общий каркас
// модальных окон, полнота локалей, честные значения по умолчанию и быстрый первый экран.
// Как и остальные UI-тесты, проверяет исходники без DOM; маскировка — исполнением кода в vm.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const html = read('public/index.html');
const script = read('public/static/script.js');
const ru = JSON.parse(read('public/locales/ru.json'));
const en = JSON.parse(read('public/locales/en.json'));

/** Достаёт функции превью из script.js и исполняет их изолированно. */
const loadPreviewRenderers = () => {
  const start = script.indexOf('const escapeHtml =');
  const end = script.indexOf('let previewConfigText');
  assert.ok(start > 0 && end > start, 'preview helpers must exist in script.js');
  const context = {};
  vm.runInNewContext(`${script.slice(start, end)}
    this.renderConfigHtml = renderConfigHtml;
    this.renderVpnLinkHtml = renderVpnLinkHtml;`, context);
  return context;
};

const SAMPLE_CONFIG = [
  '[Interface]',
  'PrivateKey = TEST-ONLY-FAKE-PRIVATE-KEY',
  'Address = 172.16.0.2/32',
  'DNS = 1.1.1.1',
  '# <script>alert(1)</script>',
  '[Peer]',
  'PublicKey = bmotYS1zZWNyZXQtcHVibGljLWtleS12YWx1ZT0=',
  'Endpoint = engage.cloudflareclient.com:4500',
].join('\n');

test('config preview never renders the PrivateKey value but keeps the rest readable', () => {
  const { renderConfigHtml } = loadPreviewRenderers();
  const out = renderConfigHtml(SAMPLE_CONFIG);
  assert.doesNotMatch(out, /TEST-ONLY-FAKE-PRIVATE-KEY/, 'private key must not reach the screen');
  assert.match(out, /PrivateKey<\/span> = <span class="c-mask">•+<\/span>/);
  assert.match(out, /bmotYS1zZWNyZXQtcHVibGljLWtleS12YWx1ZT0=/, 'the public peer key stays visible');
  assert.match(out, /engage\.cloudflareclient\.com:4500/);
  assert.match(out, /<span class="c-section">\[Interface\]<\/span>/);
  assert.doesNotMatch(out, /<script>/, 'config text is escaped');
  assert.match(out, /&lt;script&gt;/);
});

test('vpn:// preview shows only the link prefix (the link embeds the key)', () => {
  const { renderVpnLinkHtml } = loadPreviewRenderers();
  const link = `vpn://${'A'.repeat(28)}SECRETTAIL${'B'.repeat(400)}`;
  const out = renderVpnLinkHtml(link);
  assert.doesNotMatch(out, /SECRETTAIL/);
  assert.ok(out.startsWith('vpn://'), 'the prefix stays recognisable');
  assert.match(out, /class="c-mask"/);
});

test('copy and download use the full config, the mask is display-only', () => {
  assert.match(script, /downloadFile\(variant\.decodedConfig, variant\.filename\)/);
  assert.match(script, /copyText\(previewConfigText\)/);
  assert.match(script, /currentResult\.tab === 'link' && variant\.vpnLink \? variant\.vpnLink : variant\.decodedConfig/);
});

test('every modal uses the shared shell: dialog role, labelled title, localized close button', () => {
  const modals = [...html.matchAll(/<div id="([^"]+)" class="modal\b[^"]*" role="dialog" aria-modal="true" aria-labelledby="([^"]+)" aria-hidden="true">/g)];
  const ids = modals.map((m) => m[1]);
  assert.deepEqual(ids.sort(), [
    'configPreviewModal', 'disclaimerModal', 'historyModal', 'instructionModal', 'modal',
    'privacyModal', 'resultInfoModal', 'settingsModal', 'statusModal',
  ].sort());
  assert.equal((html.match(/class="modal\b/g) || []).length, modals.length, 'no modal outside the shared shell');
  for (const [, id, labelledBy] of modals) {
    assert.match(html, new RegExp(`id="${labelledBy}"`), `${id}: title ${labelledBy} must exist`);
    const start = html.indexOf(`<div id="${id}" class="modal`);
    const header = html.slice(start, html.indexOf('</header>', start));
    assert.match(header, /class="modal__close"[^>]*data-close-modal[^>]*data-i18n-aria-label="(?:close_btn_aria|settings_close_aria)"/,
      `${id}: localized close button in the header`);
  }
});

test('ui-shell provides focus trap, ESC, backdrop close and focus return', () => {
  const shell = read('public/static/ui-shell.js');
  assert.match(shell, /ev\.key === 'Escape'/);
  assert.match(shell, /ev\.key !== 'Tab'/);
  assert.match(shell, /opener\.focus\(/, 'focus returns to the element that opened the modal');
  assert.match(shell, /pressStartedOnBackdrop/, 'a drag that starts inside the dialog does not close it');
  assert.ok(html.indexOf('static/ui-shell.js') < html.indexOf('static/script.js'), 'ui-shell loads before script.js');
});

test('history clearing is a two-step destructive action', () => {
  const start = script.indexOf('historyClearBtn.addEventListener(\'click\'');
  const block = script.slice(start, start + 700);
  assert.match(block, /dataset\.confirm !== '1'/);
  assert.match(block, /history_clear_confirm/);
  assert.ok(block.indexOf('return;') < block.indexOf('localStorage.removeItem(HISTORY_KEY)'),
    'the first click only asks for confirmation');
});

test('every key used by index.html and script.js exists in both locales', () => {
  const keys = new Set();
  for (const m of html.matchAll(/data-i18n(?:-html|-title|-aria-label|-alt)?="([^"]+)"/g)) keys.add(m[1]);
  for (const m of script.matchAll(/\bt\('([a-z0-9_]+)'/g)) keys.add(m[1]);
  for (const m of script.matchAll(/setI18nText\([^,]+,\s*'([a-z0-9_]+)'/g)) keys.add(m[1]);
  for (const key of keys) {
    assert.equal(typeof ru[key], 'string', `ru.json misses ${key}`);
    assert.equal(typeof en[key], 'string', `en.json misses ${key}`);
  }
});

test('parameter chips start from the real defaults, not from mockup values', () => {
  // I6: IPv6 is off unless explicitly enabled; full tunnel; port 4500; hostname endpoint = auto choice.
  assert.match(html, /id="chipIpv6" data-i18n="chip_off"/);
  assert.match(html, /id="chipRouting" data-i18n="routing_mode_full"/);
  assert.match(html, /id="chipPort">4500</);
  assert.match(html, /<select id="warpPortSelect"[^>]*>\s*<option value="4500"/);
  assert.match(html, /id="chipEndpoint" data-i18n="chip_endpoint_auto"/);
  assert.match(html, /<select id="warpEndpointSelect"[^>]*>\s*<option value="hostname"/);
  assert.match(html, /<input type="checkbox" class="switch" id="ipv6Toggle" \/>/, 'IPv6 toggle is unchecked by default');
  assert.match(script, /const updateParamChips = \(\) =>/);
});

test('recent changes start with the current release', () => {
  const { version } = JSON.parse(read('package.json'));
  const versions = [...html.matchAll(/<li data-version="([^"]+)">/g)].map((m) => m[1]);
  assert.equal(versions[0], version, 'update the "Recent changes" card together with the release');
  assert.match(ru.changes_latest_sub, new RegExp(`^${version.replace(/\./g, '\\.')} · `));
  assert.match(en.changes_latest_sub, new RegExp(`^${version.replace(/\./g, '\\.')} · `));
});

test('first screen loads fast: self-hosted fonts, sized hero image, no third-party font CSS', () => {
  for (const file of ['public/index.html', 'public/status.html', 'public/404.html']) {
    assert.doesNotMatch(read(file), /fonts\.googleapis\.com|fonts\.gstatic\.com/, `${file} must not block on Google Fonts`);
  }
  assert.match(html, /<link rel="preload" href="static\/fonts\/inter-latin\.woff2" as="font" type="font\/woff2" crossorigin \/>/);
  for (const font of ['inter-latin.woff2', 'inter-cyrillic.woff2', 'OFL.txt']) {
    assert.ok(fs.existsSync(path.join(root, 'public/static/fonts', font)), `fonts/${font} must be committed`);
  }
  const hero = /<img class="hero-art__img"[^>]*>/.exec(html);
  assert.ok(hero, 'hero image must exist');
  assert.match(hero[0], /width="1460" height="901"/, 'hero reserves its box (no layout shift)');
  assert.match(hero[0], /fetchpriority="high"/);
  for (const asset of ['hero-warp.webp', 'hero-warp-760.webp', 'hero-warp.png']) {
    assert.ok(fs.existsSync(path.join(root, 'public/static', asset)), `${asset} must be committed`);
  }
});

test('hero checklist labels are live, translatable text over the illustration', () => {
  const labels = html.slice(html.indexOf('<ul class="hero-art__labels"'), html.indexOf('</ul>', html.indexOf('<ul class="hero-art__labels"')));
  assert.match(labels, /data-i18n="hero_check_config"/);
  assert.match(labels, /data-i18n="hero_check_routes"/);
  assert.match(labels, />DNS</);
  assert.match(labels, />Endpoint</);
});

test('system status card shares one live poller with the status modal', () => {
  assert.equal(script.split('LiveStatus.createPoller(').length - 1, 1, 'exactly one poller on the page');
  assert.doesNotMatch(script, /fetch\('\/api\/healthcheck'\)/, 'no separate healthcheck polling');
  const start = script.indexOf('const initHeroStatus');
  const block = script.slice(start, script.indexOf('const refreshHeroStatus', start));
  assert.match(block, /renderStatusModal\(snapshot\)/);
  assert.match(block, /renderHeroStatus\(\)/);
});
