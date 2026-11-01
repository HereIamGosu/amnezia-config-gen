// __tests__/route-limit-ui.test.js
// The route limit in the UI after 3.1.9, run as code (vm) rather than read as text: the counter warns from 80 % up
// to the limit itself and is "over" only above it (DECISIONS No. 31); unchecked tiles are disabled from the limit
// itself (decision No. 5); "No limit" never disables. The "Route budget:" warning of /api/warp is shown in the
// visitor's language with its three numbers. The functions are cut out of settings.js and result.js as they ship.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, test } = require('node:test');
const { readAppScript } = require('./helpers/frontend-scripts');

const LOCALES = path.resolve(__dirname, '..', 'public', 'locales');
const slice = (source, from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start > 0 && end > start, `${from} … ${to}`);
  return source.slice(start, end);
};

const classList = () => {
  const set = new Set();
  return {
    toggle: (name, on) => { if (on) set.add(name); else set.delete(name); },
    remove: (...names) => names.forEach((n) => set.delete(n)),
    contains: (name) => set.has(name),
  };
};

/** updateCidrCounter and updateTileDisabledState of settings.js over a fake page with three tiles, one checked. */
const loadSettings = () => {
  const settings = readAppScript('settings.js');
  const limit = Number(/const MAX_CIDR_LIMIT = (\d+);/.exec(settings)[1]);
  const counter = { classList: classList(), innerHTML: '', textContent: '' };
  const mini = { className: '', textContent: '' };
  const tile = (checked) => {
    const cb = { checked, disabled: false };
    return { cb, classList: classList(), querySelector: () => cb };
  };
  const tiles = [tile(true), tile(false), tile(false)];
  const context = {
    MAX_CIDR_LIMIT: limit,
    ROUTE_MODES: { FULL: 'full', SPLIT: 'split' },
    cfgState: { routeMode: 'split', ignoreLimit: false, cidrCount4: 0 },
    document: { getElementById: (id) => ({ cidrCounter: counter, cidrCounterMini: mini })[id] },
    t: (_key, fallback) => fallback,
    forEachRouteTile: (fn) => tiles.forEach(fn),
  };
  const code = `${slice(settings, 'const updateCidrCounter', 'const refreshPresetStats')}\n;({ updateCidrCounter, updateTileDisabledState })`;
  const fns = vm.runInNewContext(code, context, { filename: 'settings.js' });
  const show = (count4) => {
    context.cfgState.cidrCount4 = count4;
    fns.updateCidrCounter(count4);
    fns.updateTileDisabledState();
    return {
      warn: counter.classList.contains('cidr-counter--warn'),
      over: counter.classList.contains('cidr-counter--over'),
      uncheckedDisabled: tiles.filter((t) => !t.cb.checked).map((t) => t.cb.disabled),
      checkedDisabled: tiles.filter((t) => t.cb.checked).map((t) => t.cb.disabled),
    };
  };
  return { limit, show, cfgState: context.cfgState };
};

describe('the counter and the tiles around the limit', () => {
  test('the limit is still 1000', () => {
    assert.equal(loadSettings().limit, 1000);
  });

  test('799: no warning, tiles enabled', () => {
    assert.deepEqual(loadSettings().show(799), { warn: false, over: false, uncheckedDisabled: [false, false], checkedDisabled: [false] });
  });

  test('800 and 999: --warn, tiles enabled', () => {
    const ui = loadSettings();
    for (const n of [800, 999]) {
      assert.deepEqual(ui.show(n), { warn: true, over: false, uncheckedDisabled: [false, false], checkedDisabled: [false] }, String(n));
    }
  });

  test('exactly 1000: --warn, not --over; unchecked tiles disabled, the checked one stays clickable', () => {
    assert.deepEqual(loadSettings().show(1000), { warn: true, over: false, uncheckedDisabled: [true, true], checkedDisabled: [false] });
  });

  test('1001: --over, not --warn; unchecked tiles disabled', () => {
    assert.deepEqual(loadSettings().show(1001), { warn: false, over: true, uncheckedDisabled: [true, true], checkedDisabled: [false] });
  });

  test('"No limit": no class and no disabled tile even above the limit', () => {
    const ui = loadSettings();
    ui.cfgState.ignoreLimit = true;
    assert.deepEqual(ui.show(5000), { warn: false, over: false, uncheckedDisabled: [false, false], checkedDisabled: [false] });
  });
});

describe('the Route budget warning in the visitor language', () => {
  // The line of src/server/routeBudget.js with three different numbers: 1009 in AllowedIPs, 998 in the lists, limit 1000.
  const MESSAGE = 'Route budget: 1009 IPv4 routes in AllowedIPs (998 in the source lists) is above the limit of 1000; phones and routers may handle a list this long unstably.';
  const strings = (lang) => JSON.parse(fs.readFileSync(path.join(LOCALES, `${lang}.json`), 'utf8'));
  const loadWarningText = (lang) => {
    const code = `${slice(readAppScript('result.js'), 'const warningText', 'const appendSummaryField')}\n;warningText`;
    return vm.runInNewContext(code, { t: (key, fallback) => strings(lang)[key] ?? fallback }, { filename: 'result.js' });
  };

  for (const lang of ['ru', 'en']) {
    test(`${lang}: the localised text with each number in its place, no English server text`, () => {
      const text = loadWarningText(lang)({ code: 'routes_over_budget', message: MESSAGE });
      const template = strings(lang).risk_routes_over_budget;
      assert.match(template, /\{after\}[\s\S]*\{before\}[\s\S]*\{limit\}/, 'the template names the three numbers');
      assert.equal(text, template.replace('{after}', '1009').replace('{before}', '998').replace('{limit}', '1000'));
      assert.doesNotMatch(text, /Route budget|\{(after|before|limit)\}/);
    });
  }

  test('a message of another shape falls back to the message itself', () => {
    assert.equal(loadWarningText('ru')({ code: 'routes_over_budget', message: 'Route budget: something else' }), 'Route budget: something else');
  });
});
