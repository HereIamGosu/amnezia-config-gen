// __tests__/route-catalog-ui.test.js
// The preset catalogue in the UI (3.2.0, spec 3.2.0 §6), run as code (vm) where it matters: every preset and category
// has its name in both locales, the price line of a tile («≈ N маршрутов · точно», «по последнему замеру» for a live
// preset, «нет данных»), the plural forms, the server warnings about the preset set in the page language. The
// functions are cut out of settings.js as they ship.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, test } = require('node:test');
const { readAppScript } = require('./helpers/frontend-scripts');
const { ROUTE_PRESETS, PRESET_CATEGORY_ORDER } = require('../src/server/routePresets');

const ROOT = path.resolve(__dirname, '..');
const strings = (lang) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'locales', `${lang}.json`), 'utf8'));
const fallback = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'static', 'presets-fallback.json'), 'utf8'));
const settings = readAppScript('settings.js');
const slice = (from, to) => {
  const start = settings.indexOf(from);
  const end = settings.indexOf(to, start);
  assert.ok(start > 0 && end > start, `${from} … ${to}`);
  return settings.slice(start, end);
};

/** The tile and warning helpers of settings.js in a context with the locale of `lang` and the shipped catalogue. */
const load = (lang) => {
  const code = `${slice('/** The name of a preset in the page language', 'const refreshPresetStats')}
    ;({ presetName, presetWarningsText, pluralForm, routesPhrase, tilePriceText })`;
  return vm.runInNewContext(code, {
    t: (key, fb) => strings(lang)[key] ?? fb,
    _i18n: { locale: lang },
    cfgState: { presets: fallback.presets },
  });
};

describe('names and categories in both locales', () => {
  for (const lang of ['ru', 'en']) {
    test(`${lang}: preset_<key> for every preset, section_<key> for every category, no section_more`, () => {
      const s = strings(lang);
      for (const key of Object.keys(ROUTE_PRESETS)) assert.ok(s[`preset_${key}`], `${lang}: preset_${key}`);
      for (const category of PRESET_CATEGORY_ORDER) assert.ok(s[`section_${category}`], `${lang}: section_${category}`);
      assert.equal(s.section_more, undefined);
    });
  }

  test('the English page no longer shows Russian preset names', () => {
    const { presetName } = load('en');
    assert.equal(presetName('google'), 'Google: Search, Gmail, Play');
    assert.equal(presetName('torrent_more'), 'Other trackers');
    for (const key of Object.keys(ROUTE_PRESETS)) assert.doesNotMatch(presetName(key), /[А-Яа-яЁё]/, key);
  });

  test('the shipped fallback catalogue carries categories, aliases, retired keys and prices', () => {
    assert.deepEqual(fallback.categories, [...PRESET_CATEGORY_ORDER]);
    assert.ok(fallback.presets.every((p) => PRESET_CATEGORY_ORDER.includes(p.category)));
    assert.ok(fallback.presets.every((p) => Number.isInteger(p.routes4) && ['catalog', 'live'].includes(p.source)));
    assert.deepEqual(fallback.groupRfPopular, ['youtube', 'telegram', 'discord', 'cloudflare', 'twitter', 'github', 'rutracker']);
  });
});

describe('the price line of a tile', () => {
  test('ru plural forms: 1 маршрут, 2–4 маршрута, 5–20 маршрутов, 21 маршрут, 111 маршрутов', () => {
    const { routesPhrase } = load('ru');
    assert.deepEqual([1, 2, 4, 5, 11, 12, 14, 20, 21, 22, 25, 101, 111, 112].map(routesPhrase), [
      '≈ 1 маршрут', '≈ 2 маршрута', '≈ 4 маршрута', '≈ 5 маршрутов', '≈ 11 маршрутов', '≈ 12 маршрутов', '≈ 14 маршрутов',
      '≈ 20 маршрутов', '≈ 21 маршрут', '≈ 22 маршрута', '≈ 25 маршрутов', '≈ 101 маршрут', '≈ 111 маршрутов', '≈ 112 маршрутов',
    ]);
    assert.deepEqual([1, 2, 8].map(load('en').routesPhrase), ['≈ 1 route', '≈ 2 routes', '≈ 8 routes']);
  });

  test('catalogue, live and no-data presets', () => {
    const ru = load('ru');
    assert.equal(ru.tilePriceText({ routes4: 8, precision: 'exact', source: 'catalog' }), '≈ 8 маршрутов · точно');
    assert.equal(ru.tilePriceText({ routes4: 621, precision: 'wide', source: 'live' }), '≈ 621 маршрут · широко · по последнему замеру');
    assert.equal(ru.tilePriceText({ routes4: 0, precision: 'exact', noData: 'asn_not_announced' }), 'нет данных');
    assert.equal(ru.tilePriceText({ id: 'x' }), '', 'an old catalogue without prices: no line');
    const en = load('en');
    assert.equal(en.tilePriceText({ routes4: 230, precision: 'approx', source: 'catalog' }), '≈ 230 routes · approximate');
  });

  test('the tile of the shipped catalogue: github exact in the catalogue, youtube live', () => {
    const ru = load('ru');
    const github = fallback.presets.find((p) => p.id === 'github');
    assert.match(ru.tilePriceText(github), /^≈ \d+ маршрут(а|ов)? · точно$/);
    const youtube = fallback.presets.find((p) => p.id === 'youtube');
    assert.match(ru.tilePriceText(youtube), / · по последнему замеру$/);
  });
});

describe('server warnings about the preset set', () => {
  for (const lang of ['ru', 'en']) {
    test(`${lang}: retired, without data, reserve, empty after the cut — the presets named in the page language`, () => {
      const { presetWarningsText } = load(lang);
      const s = strings(lang);
      // Values from the vm context have foreign prototypes: compared as plain data.
      const out = JSON.parse(JSON.stringify(presetWarningsText([
        'Presets retired: vk, ok', 'Presets without data: google', 'Route source fallback: discord, youtube',
        'Empty after endpoint cut', 'Something new',
      ])));
      assert.deepEqual(out, [
        s.preset_warn_retired.replace('{keys}', 'vk, ok'),
        s.preset_warn_nodata.replace('{keys}', s.preset_google),
        s.preset_warn_fallback.replace('{keys}', 'Discord, YouTube'),
        s.preset_warn_empty_cut,
        'Something new',
      ]);
      assert.equal(presetWarningsText(undefined).length, 0);
    });
  }
});
