// __tests__/csp-inline-scripts.test.js
// Content-Security-Policy без script-src 'unsafe-inline': на страницах нет исполняемых inline-скриптов
// и обработчиков в атрибутах, а вынесенный код подключается как внешние файлы с ключом кэша.
// JSON-LD (<script type="application/ld+json">) — данные, а не код: CSP его не блокирует.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const PAGES = ['public/index.html', 'public/en/index.html', 'public/status.html', 'public/404.html'];
const version = JSON.parse(read('package.json')).version;

const cspDirectives = () => {
  const vercel = JSON.parse(read('vercel.json'));
  const value = vercel.headers.flatMap((rule) => rule.headers).find((h) => h.key === 'Content-Security-Policy').value;
  return new Map(value.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [name, ...sources] = part.split(/\s+/);
    return [name, sources];
  }));
};

test('script-src allows only own files and the Metrika host, no inline code or eval', () => {
  const csp = cspDirectives();
  assert.deepEqual(csp.get('script-src'), ['\'self\'', 'https://mc.yandex.ru']);
  assert.deepEqual(csp.get('style-src'), ['\'self\'', '\'unsafe-inline\''], 'style-src is unchanged');
  assert.deepEqual(csp.get('default-src'), ['\'self\'']);
});

test('pages contain no executable inline scripts and no inline event handlers', () => {
  for (const file of PAGES) {
    const html = read(file);
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const [, attrs, body] = match;
      if (/\btype="application\/ld\+json"/.test(attrs)) {
        assert.doesNotThrow(() => JSON.parse(body), `${file}: JSON-LD stays valid data`);
        continue;
      }
      assert.match(attrs, /\ssrc="/, `${file}: inline <script${attrs}> would be blocked by the CSP`);
      assert.equal(body.trim(), '', `${file}: external <script> must not carry inline code`);
    }
    assert.doesNotMatch(html, /<[a-z][^>]*\son[a-z]+\s*=/i, `${file}: inline event handler attributes are blocked by the CSP`);
    assert.doesNotMatch(html, /href="javascript:/i, `${file}: javascript: URLs are blocked by the CSP`);
  }
});

test('moved scripts are loaded as versioned external files in the right order', () => {
  for (const file of ['public/index.html', 'public/en/index.html']) {
    const html = read(file);
    const scripts = [...html.matchAll(/<script defer src="\/?static\/([\w.-]+)\?v=([^"]+)"><\/script>/g)];
    const names = scripts.map((m) => m[1]);
    assert.equal(names[0], 'metrika.js', `${file}: Metrika queue is defined before analytics.js and script.js use ym`);
    assert.ok(names.indexOf('share-link.js') < names.indexOf('script.js'), `${file}: share-link.js before script.js`);
    for (const [, name, v] of scripts) assert.equal(v, version, `${file}: ${name} uses ?v=${version}`);
    assert.match(html, /<noscript>\s*<div>\s*<img\s+src="https:\/\/mc\.yandex\.ru\/watch\/99328227"/, `${file}: noscript pixel stays`);
  }
  const status = read('public/status.html');
  assert.match(status, new RegExp(`<script src="static/live-status\\.js\\?v=${version.replace(/\./g, '\\.')}"></script>\\s*<script src="static/status-page\\.js\\?v=`));
});

test('the Metrika init keeps the counter, options and goal of the former inline snippet', () => {
  const metrika = read('public/static/metrika.js');
  assert.match(metrika, /'https:\/\/mc\.yandex\.ru\/metrika\/tag\.js', 'ym'/);
  assert.match(metrika, /document\.scripts\[j\]\.src === r/, 'tag.js is never inserted twice');
  assert.match(metrika, /window\.ym\(99328227, 'init', \{\s*clickmap: true,\s*trackLinks: true,\s*accurateTrackBounce: true,\s*webvisor: false,\s*\}\);/);
  assert.match(metrika, /window\.ym\(99328227, 'reachGoal', 'infoLink'\);/);
  assert.match(metrika, /window\.va = window\.va \|\| function/);
});
