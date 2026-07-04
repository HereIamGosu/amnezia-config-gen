// __tests__/routing-frontend-guards.test.js
// Release 2.6.1 — Routing & Secret Leakage Hardening.
//
// The browser bundle (public/static/script.js) is not loaded into a DOM here;
// following the established convention in result-explanation-ui.test.js, these
// tests assert the source-level invariants of the frontend guards. They exist to
// FAIL if a future edit silently removes a guard (empty-split block, CIDR limit,
// 80% warning, no-limit opt-out, mobile→IPv6 override) or starts persisting extra
// secrets in local history.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');

const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'public/static/script.js'), 'utf8');

describe('FR-RSH-004 — empty split tunnel is blocked on the frontend before any request', () => {
  test('generateConfig guards routeMode=split with zero selected routes and returns before fetch', () => {
    // The guard must appear before the fetch('/api/warp' ...) call in generateConfig.
    const guardIdx = script.indexOf('cfgState.routeMode === ROUTE_MODES.SPLIT && getSelectedRouteIds().length === 0');
    assert.ok(guardIdx > 0, 'empty split guard condition must exist');

    const fetchIdx = script.indexOf('fetch(`/api/warp?');
    assert.ok(fetchIdx > 0, 'warp fetch call must exist');
    assert.ok(guardIdx < fetchIdx, 'empty split guard must run before the warp fetch');

    // The guard must early-return (no request) and surface a user-facing message.
    const guardBlock = script.slice(guardIdx, guardIdx + 320);
    assert.match(guardBlock, /routing_empty_split_error/, 'guard must show the empty-split error message');
    assert.match(guardBlock, /return;/, 'guard must early-return so the request is never sent');
  });
});

describe('FR-RSH-001 — route mode is always sent; presets only leave the client in split mode', () => {
  test('buildWarpQueryString sets routeMode and gates presets behind split mode', () => {
    assert.match(script, /params\.set\('routeMode', cfgState\.routeMode\)/,
      'routeMode must always be included in the warp query');
    assert.match(script, /if \(cfgState\.routeMode === ROUTE_MODES\.SPLIT\)\s*\{\s*const routeIds = getSelectedRouteIds\(\);\s*if \(routeIds\.length\) params\.set\('presets'/,
      'presets must only be sent when routeMode is split');
  });
});

describe('FR-RSH-007..010 — CIDR counter, 80% warning, hard limit and no-limit opt-out', () => {
  test('FR-RSH-009 — hard limit constant is 1000 IPv4 CIDR', () => {
    assert.match(script, /const MAX_CIDR_LIMIT = 1000;/,
      'MAX_CIDR_LIMIT must stay 1000 (router / mobile routing-table safety)');
  });

  test('FR-RSH-007 — split-mode counter renders the live IPv4 count against the limit', () => {
    // updateCidrCounter shows count4 / MAX_CIDR_LIMIT while in split mode.
    assert.match(script, /const updateCidrCounter = \(count4\) =>/);
    assert.match(script, /\$\{count4\} \/ \$\{MAX_CIDR_LIMIT\}/,
      'counter must display the live IPv4 count against the limit');
    // Full tunnel must not show a misleading CIDR count.
    assert.match(script, /if \(cfgState\.routeMode === ROUTE_MODES\.FULL\)[\s\S]{0,200}routing_counter_not_applicable/,
      'full tunnel must show "not applicable" instead of a misleading CIDR count');
  });

  test('FR-RSH-008 — warning fires at 80% of the limit and "over" at 100%', () => {
    assert.match(script, /const warn = count4 >= MAX_CIDR_LIMIT \* 0\.8 && count4 < MAX_CIDR_LIMIT;/,
      '80% warning threshold must be preserved');
    assert.match(script, /const over = count4 >= MAX_CIDR_LIMIT;/,
      'hard-limit (over) threshold must be preserved');
  });

  test('FR-RSH-009 — unchecked tiles are disabled once the limit is reached', () => {
    assert.match(script, /const overLimit = !cfgState\.ignoreLimit && cfgState\.cidrCount4 >= MAX_CIDR_LIMIT;/,
      'tile disabling must respect the hard limit and the no-limit opt-out');
  });

  test('FR-RSH-010 — "no limit" opt-out still counts but stops disabling tiles / warning as over', () => {
    // ignoreLimit branch shows the count with a "limit disabled" note and never marks over.
    assert.match(script, /if \(cfgState\.ignoreLimit\)/, 'no-limit opt-out branch must exist');
    assert.match(script, /cidr_limit_disabled/, 'no-limit branch must label the counter as limit-disabled');
    // When ignoreLimit is on, overLimit is false → tiles are never disabled.
    assert.match(script, /!cfgState\.ignoreLimit && cfgState\.cidrCount4 >= MAX_CIDR_LIMIT/);
  });
});

describe('FR-RSH-011 — mobile profile forces IPv6 off on the frontend (any route mode)', () => {
  test('applyMobileModeCascade unchecks and disables the IPv6 toggle while mobile is on', () => {
    const idx = script.indexOf('const applyMobileModeCascade');
    assert.ok(idx > 0, 'applyMobileModeCascade must exist');
    const block = script.slice(idx, idx + 500);
    assert.match(block, /if \(cfgState\.mobileMode\)/);
    assert.match(block, /cfgState\.includeIpv6 = false;/, 'mobile must force includeIpv6 = false');
    assert.match(block, /ipv6Toggle\.disabled = true;/, 'mobile must disable the IPv6 toggle');
  });
});

describe('FR-RSH-015 — local history persists only the deliberately generated config, no extra secrets', () => {
  test('saveToHistory entry stores no WARP token, device id, or standalone key material', () => {
    const idx = script.indexOf('const saveToHistory');
    assert.ok(idx > 0, 'saveToHistory must exist');
    const block = script.slice(idx, idx + 500);

    // The deliberately-saved user result (b64 of their own .conf) is expected.
    assert.match(block, /b64: btoa\(decodedConfig\)/, 'history stores the user-generated config only');

    // No extra secret channels beyond that config.
    assert.doesNotMatch(block, /\btoken\b/i, 'history must not store a WARP token');
    assert.doesNotMatch(block, /deviceId|device_id/i, 'history must not store the WARP device id');
    assert.doesNotMatch(block, /privateKey|PrivateKey/, 'history must not store standalone private key material');
  });
});
