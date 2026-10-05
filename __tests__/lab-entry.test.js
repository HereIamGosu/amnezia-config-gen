// __tests__/lab-entry.test.js
// Точка входа в Endpoint Lab на главной: строка «Endpoint Lab» в карточке «Статус системы» открывает быстрый
// просмотр (public/lab/lab-quick.js). Генератор берёт адреса из Lab только в явно выбранном режиме «Endpoint Lab —
// авто» (по умолчанию — hostname Cloudflare), поэтому строка не влияет на общий статус карточки и не вызывает
// предупреждений над шагами.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ru = JSON.parse(read('public/locales/ru.json'));
const en = JSON.parse(read('public/locales/en.json'));
const status = read('public/static/status.js');
const quick = read('public/lab/lab-quick.js');
const PAGES = ['public/index.html', 'public/en/index.html'];

const block = (source, start, end = '\n};') => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `${start} must exist`);
  return source.slice(from, source.indexOf(end, from));
};

const statusList = (html) => block(html, '<ul class="status-list" id="statusList"', '</ul>');

test('both generator pages load the Lab adapter and quick view before the generator, revalidated like on /lab', () => {
  for (const file of PAGES) {
    const html = read(file);
    const srcs = [...html.matchAll(/<script defer src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    const lab = ['/lab/lab-core.js', '/lab/lab-data.js', '/lab/lab-quick.js'].map((src) => srcs.indexOf(src));
    assert.ok(lab.every((i) => i >= 0), `${file}: all three Lab scripts, without ?v=`);
    assert.deepEqual([...lab].sort((a, b) => a - b), lab, `${file}: lab-core → lab-data → lab-quick`);
    const uiShell = srcs.findIndex((s) => /static\/ui-shell\.js/.test(s));
    const i18n = srcs.findIndex((s) => /static\/i18n\.js/.test(s));
    assert.ok(uiShell < lab[0] && lab[2] < i18n, `${file}: after ui-shell.js, before the generator scripts`);
    assert.doesNotMatch(html, /lab-fixtures\.js|\/lab\/lab\.js|lab\/lab\.css/, `${file}: no Lab page code, fixtures or eager Lab styles`);
  }
});

test('status card: the Lab row is one button opening the quick view, last in the list; the built-in pool row is gone', () => {
  for (const file of PAGES) {
    const list = statusList(read(file));
    assert.doesNotMatch(list, /status_row_pool/, `${file}: the unmeasured built-in pool row left the hero card`);
    const rows = [...list.matchAll(/<li class="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(rows.filter((c) => c.includes('status-row--lab')).length, 1, `${file}: one Lab row`);
    assert.equal(rows[rows.length - 1], 'status-row status-row--lab', `${file}: Lab row is last`);
    // "off" until /api/status confirms the Lab: a click before that never requests /api/lab.
    assert.match(list, /<li class="status-row status-row--lab" id="statusLabRow">\s*<button type="button" class="status-lab" id="statusLabBtn" data-lab-quick="off" aria-haspopup="dialog">/);
  }
});

test('Lab is not an /api/status row: it never changes the overall state or the warning above the steps', () => {
  const rows = block(status, 'const HERO_STATUS_ROWS = [', '];');
  assert.doesNotMatch(rows, /endpoint_pool|\blab\b/i);
  const render = block(status, 'const renderHeroStatus = () => {');
  assert.doesNotMatch(render, /textContent = ''/, 'the list is not wiped: the focused Lab button would lose focus every minute');
  assert.match(render, /list\.insertBefore\(li, labRow\)/, 'polled rows go before the persistent Lab row');
});

test('Lab row reads the shared adapter and LabCore.statusSummary; manual refresh also refreshes the Lab', () => {
  assert.match(status, /window\.LabData\.createPoller\(/);
  assert.match(block(status, 'const renderHeroLab = () => {'), /const Core = window\.LabCore;[\s\S]*Core\.statusSummary\(heroLab, now\)/);
  assert.match(block(status, 'const refreshHeroStatus = () => {'), /labPoller\.refresh\(\)/);
});

test('the Lab row requests /api/lab only after /api/status says the Lab is published: no 503 in the console otherwise', () => {
  const sync = block(status, 'const syncHeroLab = (available) => {');
  assert.match(sync, /btn\.dataset\.labQuick = available === true \? '' : 'off';/);
  assert.match(sync, /if \(available === true\) \{\s*if \(!labPoller\) startLabPoller\(\);/);
  assert.match(sync, /heroLab = \{ kind: 'not-connected' \};/);
  const init = block(status, 'const initHeroStatus = () => {');
  assert.match(init, /syncHeroLab\(snapshot\.lab\.available\)/);
  assert.doesNotMatch(init, /startLabPoller\(\)/, 'never polled before the flag is known');
  assert.match(block(status, 'const startLabPoller = () => {'), /window\.LabData\.createPoller\(/);
  assert.equal((status.match(/createPoller\(\{\s*load: source\.loadOverview/g) || []).length, 1);
});

test('quick view opened from a row marked data-lab-quick="off" says "not connected" without requesting /api/lab', () => {
  const open = block(quick, 'const open = async', '\n  };');
  assert.match(open, /const offline = !!\(opener && opener\.dataset && opener\.dataset\.labQuick === 'off'\);/);
  assert.match(open, /if \(offline \|\| !source\.connected\) \{/);
});

test('Lab row strings exist and are non-empty in both locales', () => {
  const keys = new Set([...status.matchAll(/\bt\('(status_lab_[a-z_]+)'/g)].map((m) => m[1]));
  assert.ok(keys.size >= 4, [...keys].join(', '));
  for (const key of keys) {
    assert.equal(typeof ru[key], 'string', `ru: ${key}`);
    assert.equal(typeof en[key], 'string', `en: ${key}`);
    assert.ok(ru[key].trim() && en[key].trim(), key);
  }
});

test('every icon the quick view draws exists in the generator sprite', () => {
  const ids = new Set([...quick.matchAll(/'(i-[a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(ids.has('i-database') && ids.has('i-clock'));
  for (const file of PAGES) {
    const html = read(file);
    for (const id of ids) assert.match(html, new RegExp(`<symbol id="${id}"`), `${file}: #${id}`);
  }
});

test('quick view brings its own styles: lab.css is linked on first open and awaited before the dialog opens', () => {
  assert.match(quick, /const LAB_CSS = '\/lab\/lab\.css';/);
  const open = block(quick, 'const open = async', '\n  };');
  assert.match(open, /await Promise\.all\(\[loadStrings\(\), ensureStyles\(\)\]\);/);
  assert.ok(open.indexOf('ensureStyles()') < open.indexOf('openModal('), 'styles are in place before the dialog shows');
});

test('lab.css is safe on the generator page: every rule is scoped to Lab classes, :root only adds --lab-* tokens', () => {
  const css = read('public/lab/lab.css').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of css.matchAll(/([^{};]+)\{/g)) {
    const selector = m[1].trim();
    if (selector.startsWith('@')) continue;
    for (const part of selector.split(',').map((p) => p.trim())) {
      if (part === ':root' || /^(from|to|\d+(\.\d+)?%)$/.test(part)) continue;
      assert.match(part, /\.lab/, `unscoped selector would restyle the generator: ${part}`);
    }
  }
  for (const [, body] of css.matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const [, name] of body.matchAll(/(--[\w-]+)\s*:/g)) assert.match(name, /^--lab-/, `:root redefines ${name}`);
  }
});
