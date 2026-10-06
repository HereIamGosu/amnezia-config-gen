// __tests__/locale-cache.test.js
//
// 3.0.0 shipped 480 new interface strings, but /locales/*.json had no Cache-Control and was requested at a
// fixed address: browsers kept the 2.7.4 dictionary from their heuristic cache and showed key names
// (lab_state_ok_title, …) instead of texts. The dictionary is now revalidated on every request and
// requested with the page asset version, so a release changes its address.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('locale dictionaries are revalidated on every request', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const rule = vercel.headers.find((r) => r.source === '/locales/(.*)');
  assert.ok(rule, 'vercel.json (also read by server.js) has a /locales rule');
  const cache = rule.headers.find((h) => h.key === 'Cache-Control');
  assert.equal(cache && cache.value, 'public, max-age=0, must-revalidate');
});

test('the generator and the Lab request the dictionary with the page asset version', () => {
  for (const file of ['public/static/i18n.js', 'public/lab/lab.js', 'public/lab/lab-quick.js']) {
    const src = read(file);
    assert.match(src, /querySelector\('script\[src\*="static\/"\]\[src\*="\?v="\]'\)/, file);
    assert.match(src, /fetch\(localeRequestUrl\(/, file);
  }
});

test('no browser script requests a dictionary without the version', () => {
  // 3.0.1 missed lab-quick.js (the Lab quick view on the generator page): scan every script, not a list.
  const scripts = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.js')) scripts.push(rel);
    }
  };
  walk('public');
  assert.ok(scripts.length > 10, 'found the browser scripts');
  for (const file of scripts) {
    const src = read(file);
    assert.doesNotMatch(src, /fetch\(\s*[`'"]\/?locales\//, `${file}: dictionary requested at a fixed address`);
    // A code line that builds a /locales/ address must also add the version (the URL helpers do it on one line).
    for (const line of src.split('\n').filter((l) => /[`'"]\/?locales\//.test(l) && !/^\s*(\/\/|\*)/.test(l))) {
      assert.match(line, /\?v=/, `${file}: dictionary address without the version: ${line.trim()}`);
    }
  }
});

test('every page that loads a dictionary carries a versioned static script to take the version from', () => {
  const version = JSON.parse(read('package.json')).version;
  for (const page of ['public/index.html', 'public/en/index.html', 'public/lab/index.html', 'public/en/lab/index.html']) {
    assert.match(read(page), new RegExp(`<script[^>]+src="/?static/[^"]+\\?v=${version.replace(/\./g, '\\.')}"`), page);
  }
});
