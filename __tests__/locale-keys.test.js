// __tests__/locale-keys.test.js
// ru.json and en.json carry the same keys: a key present in one dictionary only shows its name, or a stale
// fallback, in the other language. A failure names what each file lacks.

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const ru = require('../public/locales/ru.json');
const en = require('../public/locales/en.json');

/** Dotted paths of every leaf value (the dictionaries are flat today). */
const flatKeys = (obj, prefix = '') => Object.entries(obj).flatMap(([key, value]) => (
  value !== null && typeof value === 'object' ? flatKeys(value, `${prefix}${key}.`) : [`${prefix}${key}`]
));

test('ru.json and en.json have the same set of keys', () => {
  const ruKeys = new Set(flatKeys(ru));
  const enKeys = new Set(flatKeys(en));
  const missing = {
    'en.json': [...ruKeys].filter((key) => !enKeys.has(key)).sort(),
    'ru.json': [...enKeys].filter((key) => !ruKeys.has(key)).sort(),
  };
  assert.deepEqual(missing, { 'en.json': [], 'ru.json': [] });
  assert.ok(ruKeys.size > 800, `only ${ruKeys.size} keys read`);
});
