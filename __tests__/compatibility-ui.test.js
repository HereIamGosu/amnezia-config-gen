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

test('onboarding lives in the installation guide modal, after the setup steps', () => {
  const html = read('public/index.html');
  const styles = read('public/static/styles.css');
  const modal = html.indexOf('<div id="instructionModal" class="modal"');
  const steps = html.indexOf('data-i18n-html="instruction_step1"', modal);
  const onboarding = html.indexOf('<details id="onboardingBlock"', modal);
  const modalEnd = html.indexOf('<!-- Конфиденциальность -->', modal);

  assert.ok(modal > 0, 'installation guide modal must exist');
  assert.ok(steps > modal && steps < onboarding, 'onboarding follows the installation steps');
  assert.ok(onboarding < modalEnd, 'onboarding stays inside the guide modal');
  assert.match(html, /data-open-modal="instructionModal"/, 'the guide is reachable from the page');
  assert.match(styles, /\.onboarding__summary\s*\{[^}]*cursor:\s*pointer;/s);
});

// Профили выбираются карточками-радиокнопками; дисклеймер про WARP peer остаётся
// локализуемой подсказкой на карточке AWG 2.0 (раньше — на кнопке генерации).
const profileCard = (html, value) => {
  const input = html.indexOf(`name="awgProfile" value="${value}"`);
  assert.ok(input > 0, `profile ${value} must exist`);
  const start = html.lastIndexOf('<label class="profile-card"', input);
  return html.slice(start, html.indexOf('</label>', input));
};

test('AWG 2.0 disclaimer is a hover tooltip on the AWG 2.0 profile card', () => {
  const html = read('public/index.html');
  const card = profileCard(html, 'awg2');
  assert.match(card, /title="AWG 2\.0[^"]*Cloudflare WARP peer[^"]*"/);
  assert.match(card, /data-i18n-title="compat_awg2_disclaimer"/);
  // The old inline disclaimer element must be gone.
  assert.doesNotMatch(html, /id="awg2Disclaimer"/);
});

test('AWG 3.0 and 3.1 controls include mandatory WARP-safe guidance', () => {
  const html = read('public/index.html');
  for (const [value, key] of [
    ['awg3', 'compat_awg3_disclaimer'],
    ['awg31', 'compat_awg31_disclaimer'],
  ]) {
    assert.match(profileCard(html, value), new RegExp(`data-i18n-title="${key}"`));
  }
  assert.match(profileCard(html, 'awg31'), /data-i18n="profile_awg31_note"/, 'AWG 3.1 states the client requirement');
  assert.match(html, /class="awg3-warp-safe-note" data-i18n="awg3_warp_safe_help"/);
  assert.match(html, /Cloudflare остаётся стандартным WireGuard peer/);
});

test('four profiles in generation order, AWG 2.0 preselected, one generate button', () => {
  const html = read('public/index.html');
  const styles = read('public/static/styles.css');
  const values = [...html.matchAll(/name="awgProfile" value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(values, ['legacy', 'awg2', 'awg3', 'awg31']);
  assert.match(html, /name="awgProfile" value="awg2" id="profileAwg2" checked/, 'AWG 2.0 is the default profile');
  assert.equal((html.match(/name="awgProfile"[^>]*\bchecked\b/g) || []).length, 1, 'exactly one default profile');
  assert.equal((html.match(/id="generateButton[^"]*"/g) || []).length, 1, 'a single generate button');
  assert.doesNotMatch(html, /generateButtonAwg/, 'per-profile generate buttons are gone');
  assert.match(styles, /\.profile-grid\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/s);
});

test('AWG profile wiring is centralized and uses the mode helpers', () => {
  const script = read('public/static/script.js');
  assert.match(script, /const PROFILE_MODES = \['legacy', 'awg2', 'awg3', 'awg31'\];/);
  assert.match(script, /const DEFAULT_PROFILE = 'awg2';/);
  assert.equal(script.split('const generateConfig =').length - 1, 1, 'generateConfig must be declared once');
  const body = script.slice(script.indexOf('const generateConfig ='), script.indexOf('document.addEventListener(\'DOMContentLoaded\''));
  assert.match(body, /const mode = getSelectedProfile\(\);/);
  assert.match(body, /const filename = getModeFilename\(mode\);/);
  assert.match(body, /getModeLoadingLabel\(mode\)/);
  assert.match(body, /getModeSuccessLabel\(mode\)/);
});

test('asset cache keys use the package version', () => {
  const html = read('public/index.html');
  const { version } = JSON.parse(read('package.json'));
  assert.match(html, /AWG 1\.5, 2\.0, 3\.0 (?:и|and) 3\.1/);
  for (const asset of [
    'styles.css', 'analytics.js', 'result-explanation.js', 'live-status.js', 'script.js',
    'favicon.ico', 'favicon-32x32.png', 'favicon-16x16.png', 'icon-192.png', 'apple-touch-icon.png',
    'og-amneziawg-config-generator.png',
  ]) {
    assert.ok(html.includes(`static/${asset}?v=${version}"`), `${asset} carries the ?v=${version} cache key`);
  }
  const keys = html.match(/\?v=[^"&\s]+/g) || [];
  assert.deepEqual(keys.filter((key) => key !== `?v=${version}`), [], 'no asset with a stale cache key');
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
  for (const id of ['resultDownload', 'resultCopyLink', 'resultMoreBtn', 'resultCopyCode']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} must exist`);
  }
  for (const action of ['preview', 'explain', 'compat', 'regenerate']) {
    assert.match(html, new RegExp(`data-result-action="${action}"`), `${action} action must exist`);
  }
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
    'awg_feature_disable_cookies',
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
