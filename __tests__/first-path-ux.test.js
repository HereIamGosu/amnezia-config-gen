// __tests__/first-path-ux.test.js
// QA первых пользователей: подсказки и тексты ошибок на пути «главная → первый .conf».
// Скрипты не грузятся в DOM; тесты проверяют инварианты исходников и локалей.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');

const { readAppScript } = require('./helpers/frontend-scripts');

const script = readAppScript('script.js');
const result = readAppScript('result.js');
const PUBLIC = path.join(__dirname, '..', 'public');
const locales = {
  ru: JSON.parse(fs.readFileSync(path.join(PUBLIC, 'locales', 'ru.json'), 'utf8')),
  en: JSON.parse(fs.readFileSync(path.join(PUBLIC, 'locales', 'en.json'), 'utf8')),
};
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const NEW_KEYS = [
  'err_network', 'err_rate_limited', 'err_server', 'hero_cta', 'status_lab_fallback_hint',
  'result_autodownload_note', 'result_next_steps', 'result_next_instruction',
];

describe('first-path UX strings', () => {
  for (const lang of ['ru', 'en']) {
    test(`${lang}: every new key is present and non-empty`, () => {
      for (const key of NEW_KEYS) {
        assert.ok(typeof locales[lang][key] === 'string' && locales[lang][key].length > 0, `${lang}.${key}`);
      }
    });
  }

  test('error texts keep their placeholders in both languages', () => {
    for (const lang of ['ru', 'en']) {
      assert.match(locales[lang].err_server, /\{code\}/);
      assert.match(locales[lang].result_autodownload_note, /\{file\}/);
    }
  });

  test('user-facing error texts do not tell visitors to run vercel dev', () => {
    for (const lang of ['ru', 'en']) {
      assert.doesNotMatch(locales[lang].err_html_response, /vercel/i);
    }
  });
});

describe('first-path UX wiring', () => {
  test('429 and 5xx get their own message before the generic HTTP prefix', () => {
    assert.match(script, /status === 429\) return t\('err_rate_limited'/);
    assert.match(script, /status >= 500\) return t\('err_server'/);
    assert.match(script, /throw apiError\(data, httpErrorMessage\(response\.status\)\)/);
  });

  test('a network failure of the request stays a TypeError so telemetry classifies it as network', () => {
    assert.match(script, /throw new TypeError\(t\('err_network'/);
    assert.doesNotMatch(script, /error instanceof TypeError/);
  });

  test('auto-download note appears only when the result carries the file name', () => {
    assert.match(script, /autoDownloaded: variants\[0\]\.filename/);
    assert.match(result, /autoNote\.hidden = !currentResult\.autoDownloaded/);
    assert.match(html, /id="resultAutoNote"[^>]*hidden/);
  });

  test('the hero links to the generator', () => {
    assert.match(html, /id="heroCta"/);
    assert.match(html, /href="#generator"/);
  });
});
