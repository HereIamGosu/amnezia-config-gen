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
const { APP_SCRIPTS, readAppScript, readAllAppScripts } = require('./helpers/frontend-scripts');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const html = read('public/index.html');
// Скрипты генератора разбиты по зонам ответственности (__tests__/helpers/frontend-scripts.js):
// проверка читает файл, где живёт код, а «нигде во фронтенде» — все скрипты генератора сразу.
const script = readAppScript('script.js');
const i18n = readAppScript('i18n.js');
const common = readAppScript('common.js');
const status = readAppScript('status.js');
const result = readAppScript('result.js');
const settings = readAppScript('settings.js');
const allScripts = readAllAppScripts();
const ru = JSON.parse(read('public/locales/ru.json'));
const en = JSON.parse(read('public/locales/en.json'));

/** Достаёт функции превью из common.js и исполняет их изолированно. */
const loadPreviewRenderers = () => {
  const start = common.indexOf('const escapeHtml =');
  const end = common.indexOf('let previewConfigText');
  assert.ok(start > 0 && end > start, 'preview helpers must exist in common.js');
  const context = {};
  vm.runInNewContext(`${common.slice(start, end)}
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
  assert.match(result, /downloadFile\(variant\.decodedConfig, variant\.filename\)/);
  assert.match(script, /copyText\(previewConfigText\)/);
  assert.match(result, /currentResult\.tab === 'link' && variant\.vpnLink \? variant\.vpnLink : variant\.decodedConfig/);
});

test('every modal uses the shared shell: dialog role, labelled title, localized close button', () => {
  const modals = [...html.matchAll(/<div id="([^"]+)" class="modal\b[^"]*" role="dialog" aria-modal="true" aria-labelledby="([^"]+)" aria-hidden="true">/g)];
  const ids = modals.map((m) => m[1]);
  assert.deepEqual(ids.sort(), [
    'configPreviewModal', 'disclaimerModal', 'faqModal', 'historyModal', 'instructionModal', 'modal',
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
  for (const name of APP_SCRIPTS) {
    assert.ok(html.indexOf(`static/${name}?`) > html.indexOf('static/ui-shell.js'), `ui-shell loads before ${name}`);
  }
});

test('history clearing is a two-step destructive action', () => {
  const start = script.indexOf('historyClearBtn.addEventListener(\'click\'');
  const block = script.slice(start, start + 700);
  assert.match(block, /dataset\.confirm !== '1'/);
  assert.match(block, /history_clear_confirm/);
  assert.ok(block.indexOf('return;') < block.indexOf('localStorage.removeItem(HISTORY_KEY)'),
    'the first click only asks for confirmation');
});

test('every key used by index.html and the generator scripts exists in both locales', () => {
  const keys = new Set();
  for (const m of html.matchAll(/data-i18n(?:-html|-title|-aria-label|-alt)?="([^"]+)"/g)) keys.add(m[1]);
  for (const m of allScripts.matchAll(/\bt\('([a-z0-9_]+)'/g)) keys.add(m[1]);
  for (const m of allScripts.matchAll(/setI18nText\([^,]+,\s*'([a-z0-9_]+)'/g)) keys.add(m[1]);
  for (const key of keys) {
    assert.equal(typeof ru[key], 'string', `ru.json misses ${key}`);
    assert.equal(typeof en[key], 'string', `en.json misses ${key}`);
  }
});

test('parameter chips start from the real defaults, not from mockup values', () => {
  // I6: IPv6 is off unless explicitly enabled; full tunnel; port 4500; hostname endpoint by default (Lab Auto is opt-in).
  assert.match(html, /id="chipIpv6" data-i18n="chip_off"/);
  assert.match(html, /id="chipRouting" data-i18n="routing_mode_full"/);
  assert.match(html, /id="chipPort">4500</);
  assert.match(html, /<select id="warpPortSelect"[^>]*>\s*<option value="4500"/);
  assert.match(html, /id="chipEndpoint" data-i18n="chip_endpoint_hostname"/);
  assert.match(html, /<select id="warpEndpointSelect"[^>]*>\s*<option value="hostname"/);
  assert.match(html, /<input type="checkbox" class="switch" id="ipv6Toggle" \/>/, 'IPv6 toggle is unchecked by default');
  assert.match(settings, /const updateParamChips = \(\) =>/);
});

test('step 2 is one summary button: a single entry into the settings, changes named in words', () => {
  const step = html.slice(html.indexOf('id="stepParamsBody"'), html.indexOf('<!-- Шаг 3'));
  assert.equal((step.match(/<button\b/g) || []).length, 1, 'one entry point into the settings, not one per value');
  assert.match(step, /<button type="button" class="param-summary" id="paramSummary" aria-haspopup="dialog" aria-labelledby="paramSummaryEdit" aria-describedby="paramSummaryList paramSummaryState">/);
  assert.doesNotMatch(html, /data-settings-tab=/, 'no per-value shortcuts into settings tabs');
  assert.match(step, /id="paramSummaryState" data-i18n="params_state_default"/);
  assert.match(settings, /PARAM_DEFAULTS = \(window\.ShareLink && window\.ShareLink\.DEFAULTS\)/, 'same defaults as the settings link');
  assert.match(settings, /param-summary__item--changed/, 'changed values are highlighted');
  assert.match(settings, /params_state_changed/, 'and named in the state line (not colour only)');
  for (const key of ['params_edit', 'params_state_default', 'params_state_changed', 'params_count']) {
    assert.ok(ru[key] && en[key], `${key} in both locales`);
  }
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
  for (const asset of ['hero-warp.webp', 'hero-warp-760.webp', 'hero-warp-520.webp', 'hero-warp.png', 'logo-80.webp']) {
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
  assert.equal(allScripts.split('LiveStatus.createPoller(').length - 1, 1, 'exactly one poller on the page');
  assert.doesNotMatch(allScripts, /fetch\('\/api\/healthcheck'\)/, 'no separate healthcheck polling');
  const start = status.indexOf('const initHeroStatus');
  const block = status.slice(start, status.indexOf('const refreshHeroStatus', start));
  assert.match(block, /renderStatusModal\(snapshot\)/);
  assert.match(block, /renderHeroStatus\(\)/);
});

test('a dialog opened from another dialog stacks on top and returns to it on close', () => {
  const shell = read('public/static/ui-shell.js');
  assert.match(shell, /modal\.style\.zIndex = String\(60 \+ stack\.length \* 2\);/, 'the newest dialog is always on top');
  assert.doesNotMatch(shell, /closeModal\(top\);\s*openModal\(openerEl/, 'opening from a dialog no longer closes it');
  assert.match(read('public/static/styles.css'), /\.modal\.is-stacked \{/);
});

test('header items open dialogs on the page instead of leaving it; no duplicate controls', () => {
  // «Статус» убран из шапки: окно статуса открывает кнопка «Подробнее» панели статуса и ссылка в FAQ.
  const nav = /<nav class="site-nav"[\s\S]*?<\/nav>/.exec(html)[0];
  assert.doesNotMatch(nav, /nav_status|data-status-link|status\.html/, 'no Status item in the header');
  assert.match(html, /id="statusModalBtn"/, 'the status panel still opens the status dialog');
  assert.match(script, /closest\('\[data-status-link\]'\)/, 'the FAQ status link opens the status dialog');
  assert.match(en.faq_a5, /data-status-link/, 'the FAQ status link opens the dialog too');
  assert.match(html, /<a class="site-nav__link" href="#instructions" data-open-modal="instructionModal"/);
  assert.doesNotMatch(html, /id="settingsToggle"/, 'the step 2 summary already opens the settings');
  assert.doesNotMatch(html, /data-result-action="regenerate"/, 'the generate button is right above the result');
  assert.doesNotMatch(html, /class="result__links"/, 'the compatibility card is right below the result');
});

test('an unavailable vpn:// link is explained instead of silently hidden', () => {
  assert.match(result, /copyLinkBtn\.setAttribute\('aria-disabled', String\(!hasLink\)\);/);
  assert.match(result, /vpn_link_unavailable/);
  assert.ok(ru.vpn_link_unavailable && en.vpn_link_unavailable);
});

test('desktop card titles are plain titles for mouse and keyboard alike', () => {
  assert.match(read('public/static/styles.css'), /@media \(min-width: 721px\) \{\s*\.info-card__head \{\s*cursor: default;\s*pointer-events: none;/);
  assert.match(read('public/static/ui-shell.js'), /if \(desktop\) head\.setAttribute\('tabindex', '-1'\);/, 'no extra tab stop on desktop');
});

// ── Мобильная вёрстка и стабильность раскладки (QA 320–414 px) ──

const css = read('public/static/styles.css');

/** Тело первого @media-блока с данным условием (по балансу фигурных скобок). */
const mediaBlock = (condition) => {
  const start = css.indexOf(`@media ${condition} {`);
  assert.ok(start >= 0, `@media ${condition} must exist`);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') { depth -= 1; if (depth === 0) return css.slice(start, i + 1); }
  }
  throw new Error(`unbalanced @media ${condition}`);
};

test('status card starts with every row the API can return (no growth after the first poll)', () => {
  const rowsDecl = status.slice(status.indexOf('const HERO_STATUS_ROWS = ['), status.indexOf('];', status.indexOf('const HERO_STATUS_ROWS = [')));
  const rowCount = (rowsDecl.match(/\{ key: '/g) || []).length;
  const list = html.slice(html.indexOf('<ul class="status-list" id="statusList"'), html.indexOf('</ul>', html.indexOf('id="statusList"')));
  assert.equal((list.match(/<li class="status-row">/g) || []).length, rowCount, 'one placeholder per HERO_STATUS_ROWS entry');
  assert.match(list, /data-i18n="status_row_cidr"/);
  assert.match(status, /rows = HERO_STATUS_ROWS\.map\(\(row\) => \(\{ \.\.\.row, state: 'loading' \}\)\);/,
    'the loading state keeps the optional row');
});

test('result panel keeps its height between loading, error and success', () => {
  const start = result.indexOf('const showResultView = (view) => {');
  const block = result.slice(start, result.indexOf('\n};', start));
  assert.match(block, /panel\.dataset\.view = view;/);
  assert.match(block, /panel\.style\.minHeight = reserve \? `\$\{reserve\}px` : '';/, 'loading/error hold the previous height');
  assert.match(css, /\.result\[data-view="loading"\] \{\s*min-height: var\(--result-reserve\);/, 'the first loading reserves the result height');
});

test('.conf / vpn:// tabs do not change the note height', () => {
  const note = html.slice(html.indexOf('id="resultCodeNote"'), html.indexOf('</p>', html.indexOf('id="resultCodeNote"')));
  assert.match(html, /class="code-pane__note code-pane__note--stack" id="resultCodeNote"/);
  assert.match(note, /data-note="conf" data-i18n="result_code_note"/);
  assert.match(note, /data-note="link" data-i18n="result_link_note"/);
  assert.match(result, /note\.dataset\.active = showLink \? 'link' : 'conf';/);
  assert.match(css, /\.code-pane__note--stack > span \{\s*grid-area: 1 \/ 1;/);
});

test('modals do not shift the page sideways; the history list never outgrows the dialog', () => {
  assert.match(css, /html \{[^}]*scrollbar-gutter: stable;/);
  assert.match(css, /\.history-list \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
});

test('switching the language keeps the generated result and the scroll position', () => {
  const switchBlock = i18n.slice(i18n.indexOf('const switchLang = (lang) => {'), i18n.indexOf('\n};', i18n.indexOf('const switchLang = (lang) => {')));
  assert.ok(switchBlock.indexOf('saveLangHandoff(lang);') < switchBlock.indexOf('navigateToLang(lang);'));
  const take = i18n.slice(i18n.indexOf('const takeLangHandoff = () => {'), i18n.indexOf('\n};', i18n.indexOf('const takeLangHandoff = () => {')));
  assert.match(take, /sessionStorage\.removeItem\(LANG_HANDOFF_KEY\)/, 'the handoff is read once');
  assert.match(take, /data\.to !== PAGE_LANG/, 'only the target language page restores it');
  assert.match(script, /restoreLangHandoff\(\);/);
});

test('Russian interface strings do not leak English words', () => {
  assert.doesNotMatch(ru.history_title_split, /presets/i);
  assert.match(ru.history_title_split, /\{n\}/);
});

test('mobile tap targets are at least 40 px and narrow phones get compact controls', () => {
  const mobile = mediaBlock('(max-width: 720px)');
  assert.match(mobile, /\.step__toggle \{[^}]*width: 44px;\s*height: 44px;/);
  assert.match(mobile, /\.modal__close \{\s*width: 40px;\s*height: 40px;/);
  assert.match(mobile, /\.btn--sm,[\s\S]*?\.seg__btn,[\s\S]*?\.select \{\s*min-height: 40px;/);
  assert.match(mediaBlock('(max-width: 960px)'), /\.site-header\.is-menu-open \.site-nav \{[^}]*background: var\(--color-bg\);/, 'the open menu is opaque');
  const narrow = mediaBlock('(max-width: 400px)');
  assert.match(narrow, /#settingsModalReset,\s*#resultCopyCode \{\s*width: 40px;/, 'icon-only buttons keep their text for screen readers');
  assert.match(narrow, /\.btn--generate \{[^}]*white-space: normal;/);
  assert.match(mediaBlock('(max-width: 440px)'), /\.param-summary__list \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(mediaBlock('(max-width: 480px)'), /\.hero__feature \{[^}]*white-space: normal;/);
});
