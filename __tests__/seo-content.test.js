// __tests__/seo-content.test.js
// SEO-контракт поверх seo.test.js: видимый текст для поисковиков (FAQ), сниппеты, фавиконы для Яндекса и Google,
// консолидация зеркала GitHub Pages на основной домен и нейтральные (технические) формулировки.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const readJson = (file) => JSON.parse(read(file));

const html = read('public/index.html');
const enHtml = read('public/en/index.html');
const ru = readJson('public/locales/ru.json');
const en = readJson('public/locales/en.json');

const pngSize = (file) => {
  const png = fs.readFileSync(path.join(root, file));
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
};

// FAQ живёт в модалке (страница не должна разрастаться), но его текст есть в HTML с самого начала:
// поисковики индексируют его без JavaScript, а /#faq открывает окно сразу.
test('FAQ text is in the HTML on load (modal from the header), translated on /en', () => {
  const start = html.indexOf('<div id="faqModal" class="modal"');
  assert.ok(start > 0, 'FAQ modal exists');
  const faq = html.slice(start, html.indexOf('<!-- Конфиденциальность -->', start));
  assert.match(faq, /aria-labelledby="faqModalHeading"/);
  // data-i18n стоит на span текста: на <summary> перевод стёр бы номер и кнопку-шеврон
  const questions = [...faq.matchAll(/<summary class="faq__q"><span class="faq__num" aria-hidden="true">\d{2}<\/span><span class="faq__q-text" data-i18n="(faq_q\d+)">/g)].map((m) => m[1]);
  const answers = [...faq.matchAll(/<div class="faq__a" data-i18n-html="(faq_a\d+)">/g)].map((m) => m[1]);
  assert.equal((faq.match(/class="faq__toggle" aria-hidden="true"/g) || []).length, questions.length, 'every question shows a toggle');
  assert.equal((faq.match(/<details class="faq__item" name="faq"/g) || []).length, questions.length, 'one answer open at a time');
  assert.ok(questions.length >= 6, 'at least six questions');
  assert.equal(answers.length, questions.length);
  for (const key of [...questions, ...answers, 'faq_title', 'faq_lead']) {
    assert.ok(ru[key] && en[key], `${key} in both locales`);
    assert.notEqual(ru[key], en[key], `${key} is translated`);
  }
  assert.ok(enHtml.includes(`data-i18n="faq_q1">${en.faq_q1}<`), '/en serves the English FAQ without JavaScript');
  assert.match(html, /<a class="site-nav__link" href="#faq" data-open-modal="faqModal" data-i18n="nav_faq">/, 'header opens the FAQ');
  assert.match(html, /<a class="link-btn" href="#faq" data-open-modal="faqModal" data-i18n="footer_faq">/, 'footer opens the FAQ');
  assert.match(read('public/static/ui-shell.js'), /const openFromHash = \(\) =>/, '/#faq deep links open the modal');
  assert.doesNotMatch(html, /<section class="container faq"/, 'no long FAQ block on the page itself');
});

test('snippets: title and description fit search results and carry the main queries', () => {
  for (const [lang, strings] of [['ru', ru], ['en', en]]) {
    assert.ok(strings.meta_title.length <= 70, `${lang} title ≤ 70 chars`);
    assert.ok(strings.meta_description.length >= 70 && strings.meta_description.length <= 160, `${lang} description 70–160 chars`);
    assert.match(strings.meta_title, /AmneziaWG/);
    assert.match(strings.meta_title, /WARP/);
    assert.match(strings.meta_description, /AmneziaVPN/);
    assert.match(strings.meta_description, /vpn:\/\//);
  }
  assert.match(ru.meta_title, /конфиг/i, 'Russian title uses the searched word «конфиг»');
});

test('favicons: /favicon.ico in the site root and a 120×120 PNG for Yandex on every page', () => {
  const ico = fs.readFileSync(path.join(root, 'public/favicon.ico'));
  assert.equal(ico.readUInt16LE(0), 0, 'ICO reserved field');
  assert.equal(ico.readUInt16LE(2), 1, 'ICO type = icon');
  assert.equal(pngSize('public/static/favicon-120x120.png'), '120x120');
  for (const file of ['public/index.html', 'public/en/index.html', 'public/status.html', 'public/404.html']) {
    assert.match(read(file), /<link rel="icon" href="\/?static\/favicon-120x120\.png\?v=[^"]+" type="image\/png" sizes="120x120" \/>/, file);
  }
});

test('the old GitHub Pages landing redirects to the official site instead of competing with it', () => {
  const page = read('docs/index.html');
  assert.match(page, /<link rel="canonical" href="https:\/\/awgconfig\.com\/" \/>/);
  assert.match(page, /<meta http-equiv="refresh" content="0; url=https:\/\/awgconfig\.com\/" \/>/);
  assert.doesNotMatch(page, /github\.io/, 'no self-canonical on github.io');
  for (const file of ['docs/robots.txt', 'docs/sitemap.xml']) {
    assert.equal(fs.existsSync(path.join(root, file)), false, `${file} must not advertise the mirror`);
  }
  const config = read('docs/_config.yml');
  for (const dir of ['plans', 'specs', 'research', 'superpowers', 'srs']) {
    assert.match(config, new RegExp(`^\\s+- ${dir}$`, 'm'), `internal ${dir}/ is not published`);
  }
  for (const file of ['README.md', 'README.ru.md', 'public/llms.txt']) {
    assert.doesNotMatch(read(file), /hereiamgosu\.github\.io\/amnezia-config-gen/, `${file} does not link the mirror`);
  }
});

test('CSP no longer allows Google Fonts (fonts are self-hosted) and the manifest matches the dark theme', () => {
  const vercel = readJson('vercel.json');
  const csp = vercel.headers.flatMap((rule) => rule.headers).find((h) => h.key === 'Content-Security-Policy').value;
  assert.doesNotMatch(csp, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.match(csp, /font-src 'self';/);
  assert.match(csp, /style-src 'self' 'unsafe-inline';/);
  const manifest = readJson('public/site.webmanifest');
  const themeColor = /<meta name="theme-color" content="([^"]+)" \/>/.exec(html)[1];
  assert.equal(manifest.theme_color, themeColor);
  assert.equal(manifest.background_color, '#07090c');
});

test('public copy stays neutral and technical (no «обход блокировок» / «бесплатный VPN» wording)', () => {
  const corpus = [html, enHtml, read('public/llms.txt'), JSON.stringify(ru), JSON.stringify(en)].join('\n');
  assert.doesNotMatch(corpus, /обход\w*\s+(?:блокиров|DPI|РКН)/i);
  assert.doesNotMatch(corpus, /бесплатн\w+\s+VPN|free\s+VPN/i);
  assert.doesNotMatch(corpus, /DPI evasion|bypass(?:ing)?\s+(?:censorship|blocks?)/i);
});
