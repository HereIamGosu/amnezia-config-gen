// __tests__/compatibility-ui.test.js
// Static markup / script / locale checks for the 2.7.0 compatibility &
// onboarding UI. Mirrors the style of result-explanation-ui.test.js (no DOM).

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('index.html has the onboarding block as a collapsible <details>', () => {
  const html = read('public/index.html');
  assert.match(html, /<details id="onboardingBlock" class="onboarding">/);
  assert.match(html, /<summary class="onboarding__summary" data-i18n="onboarding_title">/);
  assert.match(html, /data-i18n="onboarding_body"/);
  assert.match(html, /data-i18n="onboarding_no_guarantee"/);
});

test('index.html has the AWG 2.0 disclaimer near the AWG2 generate button', () => {
  const html = read('public/index.html');
  const awg2Btn = html.indexOf('id="generateButtonAwg2"');
  const disclaimer = html.indexOf('id="awg2Disclaimer"');
  assert.ok(awg2Btn >= 0 && disclaimer >= 0);
  assert.ok(disclaimer > awg2Btn, 'disclaimer should follow the AWG2 button');
  assert.match(html, /data-i18n="compat_awg2_disclaimer"/);
});

test('index.html has the compatibility card with all sections, hidden by default', () => {
  const html = read('public/index.html');
  assert.match(html, /<section id="compatibilityCard" class="compat-card" aria-live="polite" hidden>/);
  assert.match(html, /id="compatRecommended"/);
  assert.match(html, /id="compatExperimental"/);
  assert.match(html, /id="compatNotRecommended"/);
  assert.match(html, /id="compatWarnings"/);
  assert.match(html, /data-i18n="compat_title"/);
});

test('script.js renders and can hide the compatibility card', () => {
  const script = read('public/static/script.js');
  assert.match(script, /const renderCompatibilityCard =/);
  assert.match(script, /renderCompatibilityCard\(lastCompatibility\)/);
  // Fallback: card hidden when compatibility summary is missing/invalid.
  assert.match(script, /card\.hidden = true;/);
  // Card is driven by the API response, not hardcoded client lists.
  assert.match(script, /data\.compatibility \|\| null/);
});

test('script.js does not break existing result actions', () => {
  const html = read('public/index.html');
  assert.match(html, /post-gen-row__download/);
  assert.match(html, /post-gen-row__preview/);
  assert.match(html, /post-gen-row__copy-vpn-link/);
});

test('styles.css uses a flat card style without drop shadows', () => {
  const css = read('public/static/styles.css');
  assert.match(css, /\.compat-card \{/);
  assert.match(css, /\.onboarding \{/);
  assert.match(css, /\.awg2-disclaimer \{/);
  // Flat style: the compatibility card rule must not add box-shadow noise.
  const cardRule = css.slice(css.indexOf('.compat-card {'), css.indexOf('.compat-card__title'));
  assert.doesNotMatch(cardRule, /box-shadow/);
});

test('RU and EN locales contain all 2.7.0 compatibility + onboarding keys', () => {
  const ru = JSON.parse(read('public/locales/ru.json'));
  const en = JSON.parse(read('public/locales/en.json'));
  const keys = [
    'onboarding_title', 'onboarding_body', 'onboarding_no_guarantee',
    'compat_awg2_disclaimer', 'compat_title', 'compat_format',
    'compat_recommended', 'compat_experimental', 'compat_not_recommended',
    'compat_cloudflare_peer_notice', 'compat_client_version_warning',
    'compat_unsupported_exporter_warning', 'compat_reason_no_exporter',
    'compat_reason_research', 'compat_reason_no_path',
  ];
  keys.forEach((key) => {
    assert.equal(typeof ru[key], 'string', `missing RU key ${key}`);
    assert.equal(typeof en[key], 'string', `missing EN key ${key}`);
    assert.ok(ru[key].length > 0, `empty RU key ${key}`);
    assert.ok(en[key].length > 0, `empty EN key ${key}`);
  });
});

test('no locale value contains undefined/null/[object Object]', () => {
  for (const file of ['public/locales/ru.json', 'public/locales/en.json']) {
    const obj = JSON.parse(read(file));
    for (const [k, v] of Object.entries(obj)) {
      assert.equal(typeof v, 'string', `${file}:${k} must be a string`);
      assert.doesNotMatch(v, /\[object Object\]/, `${file}:${k}`);
      assert.notEqual(v.trim().toLowerCase(), 'undefined', `${file}:${k}`);
      assert.notEqual(v.trim().toLowerCase(), 'null', `${file}:${k}`);
    }
  }
});

test('no UI or locale copy overpromises AWG 2.0 support on the Cloudflare side', () => {
  const corpus = [
    read('public/locales/ru.json'),
    read('public/locales/en.json'),
    read('public/index.html'),
  ].join('\n');
  // The Cloudflare peer must never be described as supporting AWG 2.0.
  assert.doesNotMatch(corpus, /Cloudflare[^.\n]{0,40}(supports?|поддержива)[^.\n]{0,20}AWG\s*2/i);
});
