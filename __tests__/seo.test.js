// __tests__/seo.test.js
// Search-engine contract: language versions (/ = ru, /en = en), hreflang/canonical, sitemap,
// robots.txt, service files and how the self-hosted server serves them.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, before, after } = require('node:test');

const { buildEnPage, translateBody, TARGET } = require('../scripts/build-en-page');
const { readAppScript, readAllAppScripts } = require('./helpers/frontend-scripts');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const readJson = (file) => JSON.parse(read(file));

const SITE = 'https://awgconfig.com';
const RU_URL = `${SITE}/`;
const EN_URL = `${SITE}/en`;
const PAGES = { ru: { file: 'public/index.html', url: RU_URL }, en: { file: TARGET, url: EN_URL } };

const ru = readJson('public/locales/ru.json');
const en = readJson('public/locales/en.json');

const linkHrefs = (html, rel) => [...html.matchAll(new RegExp(`<link rel="${rel}" href="([^"]*)"`, 'g'))].map((m) => m[1]);
const hreflangs = (html) => Object.fromEntries(
  [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)" \/>/g)].map((m) => [m[1], m[2]]),
);
const metaContent = (html, name) => new RegExp(`<meta\\s+(?:name|property)="${name}"\\s+content="([^"]*)"`).exec(html)?.[1];
const jsonLd = (html) => JSON.parse(/<script type="application\/ld\+json">\n([\s\S]*?)\n\s*<\/script>/.exec(html)[1]);

test('the English page is regenerated from index.html and en.json (run npm run seo:en)', () => {
  assert.equal(read(TARGET), buildEnPage(read('public/index.html'), en, ru));
});

test('the generator refuses a Russian head that drifted from ru.json', () => {
  const html = read('public/index.html').replace(/<title>[^<]*<\/title>/, '<title>Другой заголовок</title>');
  assert.throws(() => buildEnPage(html, en, ru), /<title> differs from ru\.json "meta_title"/);
});

test('the generator translates like applyTranslations() and fails on a missing key', () => {
  const strings = { text: 'A < B & C', rich: 'Use <strong>this</strong>', tip: 'Say "hi"', alt: 'Logo' };
  const out = translateBody([
    '<p data-i18n="text">Текст</p>',
    '<div data-i18n-html="rich"><div>старое</div></div>',
    '<button title="Подсказка" data-i18n-title="tip">x</button>',
    '<img src="a.png" alt="Логотип" data-i18n-alt="alt">',
    '<script>const s = \'<p data-i18n="none">\';</script>',
  ].join('\n'), strings);
  assert.match(out, /<p data-i18n="text">A &lt; B &amp; C<\/p>/);
  assert.match(out, /<div data-i18n-html="rich">Use <strong>this<\/strong><\/div>/, 'nested same-name tags are matched');
  assert.match(out, /title="Say &quot;hi&quot;"/);
  assert.match(out, /alt="Logo"/);
  assert.match(out, /<p data-i18n="none">/, 'script contents are not translated');
  assert.throws(() => translateBody('<span data-i18n="missing">x</span>', strings), /has no key "missing"/);
});

test('each language version is canonical to itself and lists the same hreflang set', () => {
  const expected = { ru: RU_URL, en: EN_URL, 'x-default': EN_URL };
  for (const [lang, page] of Object.entries(PAGES)) {
    const html = read(page.file);
    assert.match(html, new RegExp(`<html lang="${lang}">`), page.file);
    assert.deepEqual(linkHrefs(html, 'canonical'), [page.url], `${page.file} canonical`);
    assert.equal(metaContent(html, 'og:url'), page.url, `${page.file} og:url`);
    assert.deepEqual(hreflangs(html), expected, `${page.file} hreflang`);
  }
  assert.equal(metaContent(read(PAGES.en.file), 'og:locale'), 'en_US');
  assert.equal(metaContent(read(PAGES.en.file), 'og:locale:alternate'), 'ru_RU');
  assert.equal(metaContent(read(PAGES.ru.file), 'og:locale'), 'ru_RU');
  assert.equal(metaContent(read(PAGES.ru.file), 'og:locale:alternate'), 'en_US');
});

test('the English page has English head, JSON-LD and body text', () => {
  const html = read(TARGET);
  assert.ok(html.includes(`<title>${en.meta_title}</title>`));
  assert.equal(metaContent(html, 'description'), en.meta_description);
  const graph = jsonLd(html)['@graph'];
  const page = graph.find((node) => node['@type'] === 'WebPage');
  assert.equal(page.url, EN_URL);
  assert.equal(page.inLanguage, 'en-US');
  assert.equal(graph.find((node) => node['@type'] === 'WebApplication').description, en.ld_app_description);
  assert.ok(html.includes(`data-i18n="window_title">${en.window_title}<`));
  assert.match(html, /<button class="lang-btn lang-btn--active" data-lang="en"/);
  assert.doesNotMatch(html, /\s(?:href|src)="static\//, 'asset paths are root-relative');
  // Visible copy outside scripts and comments is English (the brand alias in JSON-LD and the
  // bilingual switcher label are intentional; #statusModalContent is replaced before it is shown).
  const visible = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace('aria-label="Language / Язык"', '')
    .replace('<div id="statusModalContent" class="status-loading-msg">Загрузка...</div>', '');
  assert.deepEqual(visible.match(/[^\s<>"]*[Ѐ-ӿ][^\s<>"]*/g) || [], []);
});

test('JSON-LD is valid and describes the current release', () => {
  const { version } = readJson('package.json');
  for (const page of Object.values(PAGES)) {
    const app = jsonLd(read(page.file))['@graph'].find((node) => node['@type'] === 'WebApplication');
    assert.equal(app.softwareVersion, version, page.file);
    assert.equal(app.applicationCategory, 'UtilitiesApplication');
    assert.ok(Array.isArray(app.featureList) && app.featureList.length > 0);
  }
});

test('language follows the URL, not navigator.language', () => {
  const i18n = readAppScript('i18n.js');
  assert.doesNotMatch(readAllAppScripts(), /navigator\.language/, 'Googlebot renders with en-US and would get English on the Russian URL');
  assert.match(i18n, /const LANG_PATHS = \{ ru: '\/', en: '\/en' \};/);
  assert.match(i18n, /const PAGE_LANG = document\.documentElement\.lang === 'en' \? 'en' : 'ru';/);
  assert.match(i18n, /data-i18n-alt/, 'applyTranslations() supports every attribute the generator translates');
});

test('head icons and manifest icons point to real files', () => {
  for (const file of ['public/index.html', TARGET, 'public/status.html', 'public/404.html']) {
    const html = read(file);
    const icons = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)" href="([^"?]+)\?v=[^"]+"/g)].map((m) => m[1]);
    assert.ok(icons.length >= 4, `${file} declares favicons`);
    for (const href of icons) assert.ok(fs.existsSync(path.join(root, 'public', href.replace(/^\//, ''))), `${file}: ${href}`);
  }
  const manifest = readJson('public/site.webmanifest');
  for (const icon of manifest.icons) {
    const file = path.join(root, 'public', icon.src.replace(/\?.*$/, ''));
    const png = fs.readFileSync(file);
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes, icon.src);
  }
});

test('sitemap lists both language versions with reciprocal hreflang', () => {
  const sitemap = read('public/sitemap.xml');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, [RU_URL, EN_URL]);
  for (const block of sitemap.split('<url>').slice(1)) {
    const links = Object.fromEntries([...block.matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)].map((m) => [m[1], m[2]]));
    assert.deepEqual(links, { ru: RU_URL, en: EN_URL, 'x-default': EN_URL });
  }
});

test('robots.txt keeps rendering resources and noindex pages crawlable', () => {
  const robots = read('public/robots.txt');
  assert.match(robots, /^Sitemap: https:\/\/awgconfig\.com\/sitemap\.xml$/m);
  const disallowed = [...robots.matchAll(/^Disallow:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(disallowed.length > 0 && disallowed.every((rule) => rule === '/api/'), `only /api/ is closed, got ${disallowed}`);
});

test('security.txt follows RFC 9116', () => {
  const text = read('public/.well-known/security.txt');
  assert.match(text, /^Contact: https:\/\//m);
  assert.match(text, /^Expires: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/m);
  assert.match(text, /^Canonical: https:\/\/awgconfig\.com\/\.well-known\/security\.txt$/m);
});

const PORT = 43000 + Math.floor(Math.random() * 2000);
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

const get = (pathname) => fetch(`http://127.0.0.1:${PORT}${pathname}`, { redirect: 'manual' });

test('server: /en is the English page and /en/ redirects to it', async () => {
  const res = await get('/en');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  assert.match(await res.text(), /<html lang="en">/);
  const slash = await get('/en/');
  assert.equal(slash.status, 308);
  assert.equal(slash.headers.get('location'), '/en');
});

test('server: unknown paths get the 404 page with a 404 status and noindex', async () => {
  const res = await get('/no/such/page');
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  const body = await res.text();
  assert.match(body, /<meta name="robots" content="noindex" \/>/);
  assert.match(body, /href="\/"/);
  assert.match(body, /href="\/en"/);
});

test('server: service files are served as revalidated plain text', async () => {
  for (const pathname of ['/.well-known/security.txt', '/llms.txt', '/robots.txt']) {
    const res = await get(pathname);
    assert.equal(res.status, 200, pathname);
    assert.match(res.headers.get('content-type'), /^text\/plain/, pathname);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=0, must-revalidate', pathname);
  }
  assert.equal((await get('/sitemap.xml')).status, 200);
});
