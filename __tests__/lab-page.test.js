// __tests__/lab-page.test.js
// Страница Endpoint Lab (/lab, /en/lab): разметка, только чтение, безопасный вывод, словари, кэш и CSP.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, before, after } = require('node:test');
const { buildLabPage, TARGET } = require('../scripts/build-lab-page');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ru = JSON.parse(read('public/locales/ru.json'));
const en = JSON.parse(read('public/locales/en.json'));
const html = read('public/lab/index.html');
const enHtml = read('public/en/lab/index.html');
const LAB_SCRIPTS = ['lab-core.js', 'lab-data.js', 'lab.js', 'lab-quick.js', 'lab-fixtures.js', 'lab-history.js'];
const scripts = Object.fromEntries(LAB_SCRIPTS.map((f) => [f, read(`public/lab/${f}`)]));
const allLab = [html, read('public/lab/lab.css'), ...Object.values(scripts)].join('\n');

test('/lab page and its generated English twin exist and are up to date', () => {
  assert.match(html, /<html lang="ru">/);
  assert.match(enHtml, /<html lang="en">/);
  assert.equal(enHtml.replace(/\r\n/g, '\n'), buildLabPage(html, en, ru), `${TARGET} is stale: run npm run seo:en`);
  assert.match(html, /<meta name="robots" content="noindex,follow" \/>/, 'not indexed until the Lab is public');
});

test('semantic structure: landmarks, one h1, table semantics, Lab is the active nav item', () => {
  for (const tag of ['<header class="site-header"', '<nav class="site-nav"', '<main id="labMain"', '<footer class="site-footer"']) assert.ok(html.includes(tag), tag);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /<table class="lab-table"[\s\S]*<caption[\s\S]*<thead>[\s\S]*<th scope="col"/);
  assert.match(html, /<a class="site-nav__link site-nav__link--active" href="\/lab"[^>]*aria-current="page"/);
  assert.match(html, /<a class="site-nav__link" href="\/" data-href-en="\/en" data-i18n="nav_generator">/, 'way back to the generator');
  assert.match(enHtml, /href="\/en" data-href-en="\/en" data-i18n="nav_generator">Generator</);
  assert.doesNotMatch(/<nav class="site-nav"[\s\S]*?<\/nav>/.exec(html)[0], /nav_status|status\.html/, 'header has no Status item, like the generator');
  for (const id of ['labStatus', 'labMetrics', 'labChartFrame', 'labActivityList', 'labTableBody', 'labCards', 'labEndpointModal', 'labHistoryModal', 'labInfoModal']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /<button[^>]*class="lang-btn lang-btn--active" data-lang="ru"|<button class="lang-btn lang-btn--active" data-lang="ru"/);
});

test('read-only: no operator actions, no write requests', () => {
  const forbidden = /force[\s_-]?refresh|rescan|blacklist|unquarantine|discovery[\s_-]?now|identity[\s_-]?reset|systemctl|wg-quick|sudo\b/i;
  for (const [name, src] of Object.entries({ 'index.html': html, ...scripts })) {
    assert.doesNotMatch(src, forbidden, `${name}: operator controls do not belong to the public page`);
    assert.doesNotMatch(src, /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i, `${name}: GET only`);
  }
  assert.doesNotMatch(html, /<form[^>]*method="post"/i);
  for (const [k, v] of Object.entries(ru)) {
    if (k.startsWith('lab_')) assert.doesNotMatch(v, /blacklist|quarantine now|rescan/i, k);
  }
});

test('network strings never reach innerHTML or code evaluation', () => {
  for (const [name, src] of Object.entries(scripts)) {
    assert.doesNotMatch(src, /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, name);
    assert.doesNotMatch(src, /data-i18n-html/, `${name} never applies translated HTML`);
  }
  // Translated HTML only in the shell blocks shared with the generator (footer, FAQ, privacy, disclaimer):
  // their text is in the markup, the English twin gets it at build time, no Lab script touches it.
  const SHARED_SHELL_HTML = new Set(['footer_tagline', 'privacy_body', 'disclaimer_body',
    ...Array.from({ length: 10 }, (_, i) => `faq_a${i + 1}`)]);
  for (const [, key] of html.matchAll(/data-i18n-html="([^"]+)"/g)) {
    assert.ok(SHARED_SHELL_HTML.has(key), `no translated HTML on the Lab page outside the shared shell: ${key}`);
  }
});

test('the Lab page shares the generator footer and opens FAQ, privacy and disclaimer in place', () => {
  const main = read('public/index.html');
  const footerOf = (page) => /<footer class="site-footer">[\s\S]*?<\/footer>/.exec(page)[0]
    .replace('src="static/', 'src="/static/');
  assert.equal(footerOf(html), footerOf(main), 'same footer as the generator');
  assert.match(html, /<a class="site-nav__link" href="#faq" data-open-modal="faqModal" data-i18n="nav_faq">FAQ<\/a>/);
  assert.doesNotMatch(html, /href="\/#faq"/, 'FAQ does not leave the page');
  for (const id of ['faqModal', 'privacyModal', 'disclaimerModal']) {
    const dialog = (page) => new RegExp(`<div id="${id}"[\\s\\S]*?\\n    </div>\\n`).exec(page)[0];
    assert.equal(dialog(html), dialog(main), `${id} is the generator's dialog`);
  }
  for (const icon of ['i-help', 'i-heart', 'i-lock', 'i-alert', 'i-x', 'i-chevron-down', 'i-code', 'i-download', 'i-eye', 'i-history']) {
    assert.match(html, new RegExp(`<symbol id="${icon}"`), `sprite has ${icon}`);
  }
});

test('"История" on the Lab page opens the generator history dialog in place', () => {
  const main = read('public/index.html');
  const item = (page) => /<button type="button" class="site-nav__link" id="historyModalBtn"[\s\S]*?<\/button>/.exec(page)[0];
  assert.equal(item(html), item(main), 'same header item as the generator');
  assert.doesNotMatch(html, /id="labHistoryLink"/, 'no link to the generator page');
  for (const id of ['configPreviewModal', 'historyModal']) {
    const dialog = (page) => new RegExp(`<div id="${id}"[\\s\\S]*?\\n    </div>\\n`).exec(page)[0];
    assert.equal(dialog(html), dialog(main), `${id} is the generator's dialog`);
  }
  // The generator's history stack loads before the Lab adapter; the adapter is the last script.
  const srcs = [...html.matchAll(/<script defer src="([^"]+)"><\/script>/g)].map((m) => m[1].replace(/\?v=.*$/, ''));
  const order = ['/static/ui-shell.js', '/static/i18n.js', '/static/common.js', '/static/result.js', '/static/settings.js', '/static/history.js'];
  assert.deepEqual(srcs.slice(0, order.length), order);
  assert.equal(srcs.at(-1), '/lab/lab-history.js');
  const adapter = scripts['lab-history.js'];
  assert.match(adapter, /renderHistoryPanel\(\);\s*openModal\('historyModal', historyModalBtn\);/);
  assert.match(adapter, /fetch\(localeRequestUrl\(lang\)\)/, 'dictionary with the asset version, like lab.js');
});

test('no operator internals in the page, scripts or fixtures', () => {
  // The config preview dialog is the generator's: its note about the visitor's own PrivateKey is not a Lab secret.
  const previewDialog = /<div id="configPreviewModal"[\s\S]*?\n {4}<\/div>\n/;
  assert.match(html, previewDialog);
  assert.equal(previewDialog.exec(html)[0], previewDialog.exec(read('public/index.html'))[0], 'exactly the generator dialog');
  const labOwn = allLab.replace(previewDialog, '');
  assert.doesNotMatch(labOwn, /\/etc\/|\/var\/lib\/|\.sqlite|\.db\b|wg\.key|identity\.json|registration[_ ]?(id|token)|private[_ ]?key|PrivateKey|stack trace/i);
});

test('fixtures load only through the localhost gate, never from the page markup', () => {
  assert.doesNotMatch(html, /lab-fixtures\.js/);
  assert.doesNotMatch(html, /lab-quick\.js/);
  const lab = scripts['lab.js'];
  assert.match(lab, /const fixtureName = Core\.fixtureFromLocation\(win\.location\.search, win\.location\.hostname\);/);
  assert.match(lab, /if \(fixtureName\) \{\s*fixtures = await loadFixtures\(\);/);
  assert.match(lab, /Core\.isLocalHost\(win\.location\.hostname\) && new URLSearchParams\(win\.location\.search\)\.get\('quick'\) === '1'/);
});

test('CSP: external same-origin scripts only, no inline code or handlers', () => {
  for (const [name, page] of [['ru', html], ['en', enHtml]]) {
    for (const m of page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(m[1], /\ssrc="\/(static|lab)\//, `${name}: <script${m[1]}>`);
      assert.equal(m[2].trim(), '', `${name}: no inline code`);
    }
    assert.doesNotMatch(page, /<[a-z][^>]*\son[a-z]+\s*=/i, `${name}: no inline handlers`);
    assert.doesNotMatch(page, /https?:\/\/(?!github\.com\/HereIamGosu)[^"\s]+\.(js|css)/, `${name}: no external assets`);
  }
  const vercel = JSON.parse(read('vercel.json'));
  const csp = vercel.headers.flatMap((r) => r.headers).find((h) => h.key === 'Content-Security-Policy').value;
  assert.doesNotMatch(csp, /unsafe-eval/);
});

test('Lab assets live outside the immutable /static cache; shared assets keep ?v=', () => {
  const version = JSON.parse(read('package.json')).version;
  assert.ok(!fs.existsSync(path.join(root, 'public/static/lab.js')) && !fs.existsSync(path.join(root, 'public/static/lab.css')));
  for (const m of html.matchAll(/(?:href|src)="(\/static\/[^"]+)"/g)) {
    if (/\/static\/fonts\//.test(m[1])) continue;
    assert.match(m[1], new RegExp(`\\?v=${version.replace(/\./g, '\\.')}$`), m[1]);
  }
  for (const m of html.matchAll(/(?:href|src)="(\/lab\/[^"]+)"/g)) assert.doesNotMatch(m[1], /\?v=/, 'revalidated, not versioned');
});

test('every key used by the Lab page exists and is non-empty in both locales', () => {
  const keys = new Set();
  for (const m of html.matchAll(/data-i18n(?:-aria-label|-title|-alt|-placeholder)?="([^"]+)"/g)) keys.add(m[1]);
  for (const src of [scripts['lab.js'], scripts['lab-quick.js']]) {
    for (const m of src.matchAll(/\bt\('([a-z][a-z0-9_-]+)'/g)) keys.add(m[1]);
  }
  const families = {
    lab_state_: ['ACTIVE', 'VERIFIED', 'SUSPECT', 'QUARANTINE', 'DEAD', 'DISCOVERED', 'CHECKING', 'EXPIRED', 'UNKNOWN'],
    lab_state_long_: ['ACTIVE', 'VERIFIED', 'SUSPECT', 'QUARANTINE', 'DEAD', 'DISCOVERED', 'CHECKING', 'EXPIRED', 'UNKNOWN'],
    lab_source_: ['consumer_official_seed', 'phase_a_verified', 'legacy_builtin', 'cloudflare_one_observation', 'community', 'experimental', 'other'],
    lab_event_: ['restored', 'promoted', 'suspect', 'demoted', 'excluded', 'dead', 'restored_sub', 'promoted_sub', 'suspect_sub', 'demoted_sub', 'excluded_sub', 'dead_sub', 'discovery_sub_one', 'discovery_sub_few', 'discovery_sub_many', 'discovery_sub_other'],
    lab_session_: ['first', 'retry', 'failed', 'long_first', 'long_retry', 'long_failed'],
    lab_chart_sub_: ['1h', '6h', '24h'],
    lab_ago_: ['now', 'sec', 'min', 'hour', 'hour_min', 'day'],
  };
  for (const [prefix, names] of Object.entries(families)) names.forEach((n) => keys.add(prefix + n));
  for (const s of ['not-connected', 'error', 'malformed', 'nodata', 'ok', 'degraded', 'unavailable', 'stale', 'empty']) {
    keys.add(`lab_state_${s}_title`);
    keys.add(`lab_state_${s}_text`);
  }
  for (const key of keys) {
    if (!key.startsWith('lab_') && !key.startsWith('nav_') && !['window_title', 'menu_aria', 'close_btn_aria'].includes(key)) continue;
    for (const [lang, dict] of [['ru', ru], ['en', en]]) {
      assert.equal(typeof dict[key], 'string', `${lang}.json: ${key}`);
      assert.ok(dict[key].length > 0, `${lang}.json: ${key} is empty`);
    }
  }
  const labKeys = (dict) => Object.keys(dict).filter((k) => k.startsWith('lab_')).sort();
  assert.deepEqual(labKeys(ru), labKeys(en), 'ru and en have the same lab_* keys');
});

test('honest copy: the Lab never promises availability from the visitor network', () => {
  assert.match(ru.lab_disclaimer, /не гарантирует/);
  assert.match(en.lab_disclaimer, /does not guarantee/);
  assert.match(ru.lab_info_note, /не гарантирует/);
  assert.equal(en.lab_disclaimer, 'Verification is performed from the project server and does not guarantee availability from your network.');
  // Phase D: генератор берёт адреса из Lab только в явно выбранном режиме «Endpoint Lab — авто», по умолчанию —
  // hostname. Тексты не утверждают, что пул использует генератор вообще, а каждый текст о генераторе называет режим.
  for (const [lang, dict, re, generator, mode] of [
    ['ru', ru, /используются генератором|доступн\S* генератор/i, /генератор/i, /«Endpoint Lab — авто»|hostname/],
    ['en', en, /used by the generator|available to the generator/i, /generator/i, /“Endpoint Lab — auto”|hostname/],
  ]) {
    for (const [k, v] of Object.entries(dict)) {
      if (!k.startsWith('lab_') || k === 'lab_meta_title') continue;
      assert.doesNotMatch(v, re, `${lang}.json ${k}`);
      if (generator.test(v)) assert.match(v, mode, `${lang}.json ${k} names the endpoint mode`);
    }
    assert.match(dict.lab_lead, mode, `${lang}.json lab_lead says which generator mode uses the pool`);
  }
});

test('mobile layout switches to cards at the same breakpoint in JS and CSS', () => {
  const query = /const MOBILE_QUERY = '\(max-width: (\d+)px\)';/.exec(scripts['lab.js']);
  assert.ok(query, 'MOBILE_QUERY constant');
  assert.match(read('public/lab/lab.css'), new RegExp(`@media \\(max-width: ${query[1]}px\\)`));
  assert.match(html, /<ul class="lab-cards" id="labCards"[^>]*hidden><\/ul>/, 'cards list exists, hidden until the phone layout');
  assert.match(read('public/lab/lab.css'), /prefers-reduced-motion: reduce/);
});

// ── Реальные заголовки self-hosted сервера ─────────────────────

const PORT = 43000 + Math.floor(Math.random() * 1500);
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

const head = (pathname) => fetch(`http://127.0.0.1:${PORT}${pathname}`, { method: 'HEAD', redirect: 'manual' });

test('Lab HTML, CSS and JS are revalidated, never cached for a year', async () => {
  for (const pathname of ['/lab', '/en/lab', '/lab/lab.css', '/lab/lab.js', '/lab/lab-core.js', '/lab/lab-hero.webp']) {
    const res = await head(pathname);
    assert.equal(res.status, 200, pathname);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=0, must-revalidate', pathname);
    assert.ok(res.headers.get('etag'), `${pathname}: ETag for cheap revalidation`);
    assert.ok(res.headers.get('content-security-policy'), `${pathname}: site CSP applies`);
  }
  const slash = await head('/lab/');
  assert.equal(slash.status, 308);
  assert.equal(slash.headers.get('location'), '/lab');
  assert.equal((await head('/static/styles.css?v=1')).headers.get('cache-control'), 'public, max-age=31536000, immutable', 'global contract unchanged');
});
