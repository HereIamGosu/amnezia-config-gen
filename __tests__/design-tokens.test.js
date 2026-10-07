// __tests__/design-tokens.test.js
// Светлые текстовые оттенки статусов — токены общей дизайн-системы: в компонентах генератора и Lab
// нет сырых #4ade80 / #fbbf24 / #fca5a5, токены Lab — алиасы общих.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const STATUS_TEXT = {
  '--color-success-text': '#4ade80',
  '--color-warning-text': '#fbbf24',
  '--color-error-text': '#fca5a5',
};

/** Первый блок `:root { … }` файла и всё остальное. */
const splitRoot = (css) => {
  const start = css.indexOf(':root {');
  assert.ok(start >= 0, ':root block present');
  const end = css.indexOf('\n}', start);
  return { rootBlock: css.slice(start, end), rest: css.slice(0, start) + css.slice(end) };
};

test('styles.css: status text shades are tokens in :root and nowhere else', () => {
  const { rootBlock, rest } = splitRoot(read('public/static/styles.css'));
  for (const [token, hex] of Object.entries(STATUS_TEXT)) {
    assert.match(rootBlock, new RegExp(`${token}: ${hex};`), `${token} defined in :root`);
    assert.doesNotMatch(rest, new RegExp(hex, 'i'), `raw ${hex} outside :root — use var(${token})`);
  }
});

test('lab.css: Lab status tokens alias the shared ones, no raw shades', () => {
  const css = read('public/lab/lab.css');
  assert.match(css, /--lab-ok: var\(--color-success-text\);/);
  assert.match(css, /--lab-warn: var\(--color-warning-text\);/);
  assert.match(css, /--lab-error: var\(--color-error-text\);/);
  for (const hex of Object.values(STATUS_TEXT)) assert.doesNotMatch(css, new RegExp(hex, 'i'), `raw ${hex} in lab.css`);
});
