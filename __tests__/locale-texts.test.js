// __tests__/locale-texts.test.js
// Texts fixed in 3.1.7: Russian strings left in English, and a hint that promised different endpoints although
// standard WARP templates give every config the same Endpoint hostname (keys differ in every mode). The Russian
// pages repeat these strings as static markup, seen before the dictionary loads and without JS, so the markup
// must equal ru.json.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const ru = require('../public/locales/ru.json');
const en = require('../public/locales/en.json');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', shy: '­' };
const decode = (text) => text
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&([a-z]+);/g, (entity, name) => ENTITIES[name] ?? entity);

test('config_count_hint promises different keys, not different endpoints', () => {
  assert.equal(ru.config_count_hint, 'Сгенерировать 1–3 конфигурации с разными ключами');
  assert.equal(en.config_count_hint, 'Generate 1–3 configs with different keys');
});

test('Endpoint Lab, result summary and status strings are Russian in ru.json', () => {
  const expected = {
    lab_session_failed: 'Ошибка',
    lab_source_consumer_official_seed: 'Официальный список',
    lab_source_phase_a_verified: 'Исторический',
    lab_source_legacy_builtin: 'Встроенный',
    lab_source_community: 'Сообщество',
    lab_source_experimental: 'Поиск',
    lab_check_handshake: 'Handshake WireGuard',
    lab_step_handshake: 'Handshake WireGuard',
    lab_check_tunnel: 'Туннель WARP',
    lab_step_tunnel: 'Туннель WARP',
    lab_check_https: 'Трафик HTTPS',
    lab_step_https: 'Трафик HTTPS',
    result_summary_presets: 'Пресеты',
    result_summary_routes_community: 'списки сообщества',
    status_row_engage: 'Endpoint WARP',
  };
  for (const [key, value] of Object.entries(expected)) assert.equal(ru[key], value, key);
});

test('the Lab pipeline step names the WARP tunnel as the check does', () => {
  assert.equal(en.lab_step_tunnel, 'WARP tunnel');
  assert.equal(en.lab_step_tunnel, en.lab_check_tunnel);
});

test('plain-text data-i18n elements of the Russian pages equal ru.json', () => {
  for (const page of ['public/index.html', 'public/lab/index.html']) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    let checked = 0;
    for (const [, key, text] of html.matchAll(/data-i18n="([a-z0-9_]+)"[^>]*>([^<]*)</g)) {
      checked += 1;
      assert.ok(Object.hasOwn(ru, key), `${page}: ${key} is missing from ru.json`);
      assert.equal(decode(text).trim(), String(ru[key]).trim(), `${page}: ${key}`);
    }
    assert.ok(checked > 100, `${page}: only ${checked} plain-text elements found`);
  }
});
