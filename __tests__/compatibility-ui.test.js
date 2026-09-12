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

test('AWG 2.0 disclaimer is a hover tooltip on the AWG2 generate button', () => {
  const html = read('public/index.html');
  // The AWG2 button carries the disclaimer as a localizable title attribute.
  const btnMatch = html.match(/<button id="generateButtonAwg2"[^>]*>/);
  assert.ok(btnMatch, 'AWG2 generate button must exist');
  assert.match(btnMatch[0], /title="AWG 2\.0[^"]*Cloudflare WARP peer[^"]*"/);
  assert.match(btnMatch[0], /data-i18n-title="compat_awg2_disclaimer"/);
  // The old inline disclaimer element must be gone.
  assert.doesNotMatch(html, /id="awg2Disclaimer"/);
});

test('AWG 3.0 and 3.1 controls include mandatory WARP-safe guidance', () => {
  const html = read('public/index.html');
  for (const [id, key] of [
    ['generateButtonAwg3', 'compat_awg3_disclaimer'],
    ['generateButtonAwg31', 'compat_awg31_disclaimer'],
  ]) {
    const button = html.match(new RegExp(`<button id="${id}"[^>]*>`));
    assert.ok(button, `${id} must exist`);
    assert.match(button[0], new RegExp(`data-i18n-title="${key}"`));
  }
  assert.match(html, /class="awg3-warp-safe-note" data-i18n="awg3_warp_safe_help"/);
  assert.match(html, /Cloudflare остаётся стандартным WireGuard peer/);
});

test('generation controls are arranged as a two-by-two grid', () => {
  const html = read('public/index.html');
  const styles = read('public/static/styles.css');
  const buttonIds = [
    'generateButton',
    'generateButtonAwg2',
    'generateButtonAwg3',
    'generateButtonAwg31',
  ];
  const positions = buttonIds.map((id) => html.indexOf(`id="${id}"`));

  assert.ok(positions.every((position) => position >= 0), 'all four generation buttons must exist');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.match(
    styles,
    /\.buttons__gen-stack\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s,
  );
  assert.match(styles, /\.awg3-warp-safe-note\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/s);
});

test('AWG 3.x frontend wiring is unique and uses centralized mode helpers', () => {
  const script = read('public/static/script.js');
  for (const declaration of [
    'const generateButtonAwg3 =',
    'const generateButtonAwg31 =',
    'const awg3Options =',
    'const awg31Options =',
  ]) {
    assert.equal(script.split(declaration).length - 1, 1, `${declaration} must be declared once`);
  }
  assert.match(script, /const getModeFilename =/);
  assert.match(script, /const getModeLoadingLabel =/);
  assert.match(script, /const getModeSuccessLabel =/);
});

test('release metadata and asset cache keys identify AWG 3.x release 2.7.0', () => {
  const html = read('public/index.html');
  assert.match(html, /AWG 1\.5, 2\.0, 3\.0 (?:и|and) 3\.1/);
  assert.equal((html.match(/\?v=2\.7\.0/g) || []).length, 4);
  assert.doesNotMatch(html, /\?v=2\.5\.0/);
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
    'awg3_warp_safe_help', 'awg_warp_safe', 'awg_profile_label',
    'awg_enabled_features', 'awg_experimental_features', 'awg_disabled_for_warp',
    'awg_client_compatibility', 'awg_feature_header_disabled',
    'awg_feature_trailers_disabled', 'awg_feature_timing', 'awg_feature_keepalive',
    'awg_feature_content_padding', 'awg_router_warning',
    'awg3_client_warning', 'awg31_client_warning',
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
