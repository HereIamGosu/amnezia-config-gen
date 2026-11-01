// e2e/catalog.e2e.js — каталог пресетов в генераторе (3.2.0, спека 3.2.0 §6): блоки категорий из каталога с
// заголовками на языке страницы, локализованные названия, цена и точность на плитке, быстрый выбор из семи,
// счётчик по routes4, недоступная плитка без данных, ссылка со старым ключом и снятым пресетом. Каталог (/api/iplist
// без пресетов) отдаёт настоящий обработчик со снапшотом из репозитория; предпросмотр — заглушка харнесса.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { e2eSuite } = require('./lib/harness');

const ROOT = path.resolve(__dirname, '..');
const locale = (lang) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'locales', `${lang}.json`), 'utf8'));
const FALLBACK = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'static', 'presets-fallback.json'), 'utf8'));
const CATEGORIES = ['video', 'messengers', 'social', 'torrent', 'media', 'gaming', 'ai', 'work', 'infra', 'other'];
const QUICK_PICK = ['youtube', 'telegram', 'discord', 'cloudflare', 'twitter', 'github', 'rutracker'];

const openRoutes = async (page) => {
  await page.click('#paramSummary');
  await page.waitFor(() => document.getElementById('settingsModal').classList.contains('is-open'));
  await page.click('#routeModeSplit');
};

const routesView = () => ({
  categories: Array.from(document.querySelectorAll('#routeCategories .cfg-tiles--routes')).map((d) => d.dataset.category),
  titles: Array.from(document.querySelectorAll('#routeCategories h3')).map((h) => h.textContent.trim()),
  checked: Array.from(document.querySelectorAll('#routeCategories input:checked')).map((i) => i.value),
  tile: (id) => id,
});

const tileOf = (id) => {
  const input = document.querySelector(`#routeCategories input[value="${id}"]`);
  const label = input.closest('label');
  return {
    name: label.querySelector('.cfg-tile__name').textContent,
    price: (label.querySelector('.cfg-tile__price') || {}).textContent || '',
    disabled: input.disabled,
    nodata: label.classList.contains('cfg-tile--nodata'),
    title: label.title,
  };
};

e2eSuite('preset catalogue in the generator', (openPage) => {
  for (const [url, lang] of [['/', 'ru'], ['/en', 'en']]) {
    test(`${url}: categories from the catalogue, names and prices in ${lang}, quick pick of seven, counter by routes4`, async () => {
      const s = locale(lang);
      const page = await openPage({ width: 1440, height: 900 });
      await page.goto(url);
      await openRoutes(page);
      const view = await page.evaluate(routesView);
      assert.deepEqual(view.categories, CATEGORIES);
      assert.deepEqual(view.titles, CATEGORIES.map((c) => s[`section_${c}`]));

      const google = await page.evaluate(tileOf, 'google');
      assert.equal(google.name, s.preset_google);
      assert.match(google.price, lang === 'ru' ? /^≈ \d+ маршрут(а|ов)? · точно$/ : /^≈ \d+ routes? · exact$/);
      const youtube = await page.evaluate(tileOf, 'youtube');
      assert.match(youtube.price, new RegExp(`· ${s.tile_price_live}$`), 'a transitional preset: the price of the last build');

      await page.click('#presetRfPopular');
      await page.waitFor((n) => document.querySelectorAll('#routeCategories input:checked').length === n, { args: [QUICK_PICK.length] });
      assert.deepEqual((await page.evaluate(routesView)).checked.sort(), [...QUICK_PICK].sort());
      // The harness stub of /api/iplist?presets= answers routes4 = 24 per preset.
      await page.waitFor((n) => document.getElementById('cidrCounter').textContent.includes(`${n} / 1000`),
        { args: [QUICK_PICK.length * 24], message: 'the counter shows routes4' });
      await page.assertClean(url);
    });
  }

  test('a preset without data in the catalogue: an unavailable tile that no button selects', async () => {
    const page = await openPage({ width: 1440, height: 900 });
    const presets = FALLBACK.presets.map((p) => (p.id === 'github' ? { ...p, routes4: 0, noData: 'no_ipv4_addresses' } : p));
    page.route((u) => u.pathname === '/api/iplist' && !u.searchParams.has('presets'),
      () => ({ json: { ...FALLBACK, success: true, presets } }));
    await page.goto('/');
    await openRoutes(page);
    const tile = await page.evaluate(tileOf, 'github');
    assert.deepEqual([tile.disabled, tile.nodata, tile.price], [true, true, 'нет данных']);
    assert.match(tile.title, /В каталоге нет адресов этого пресета/);
    await page.click('#presetRfPopular');
    await page.waitFor(() => document.querySelectorAll('#routeCategories input:checked').length === 6);
    assert.equal((await page.evaluate(routesView)).checked.includes('github'), false);
    await page.click('#presetClear');
    await page.waitFor(() => document.querySelectorAll('#routeCategories input:checked').length === 0);
    assert.equal((await page.evaluate(tileOf, 'github')).disabled, true, 'still unavailable after «Снять всё»');
    await page.assertClean();
  });

  for (const [url, note] of [['/?routes=rutracker_local,vk,telegram', /снятые с каталога: vk/], ['/en?routes=rutracker_local,vk,telegram', /taken out of the catalogue: vk/]]) {
    test(`a link with an old key and a retired preset: ${url}`, async () => {
      const page = await openPage({ width: 1440, height: 900 });
      await page.goto(url);
      await page.click('#paramSummary');
      await page.waitFor(() => document.getElementById('settingsModal').classList.contains('is-open'));
      const state = await page.evaluate(() => ({
        checked: Array.from(document.querySelectorAll('#routeCategories input:checked')).map((i) => i.value).sort(),
        split: document.getElementById('routeModeSplit').classList.contains('route-mode-btn--active'),
        note: document.getElementById('routesLinkNote').hidden ? null : document.getElementById('routesLinkNote').textContent,
      }));
      assert.deepEqual(state.checked, ['rutracker', 'telegram'], 'rutracker_local → rutracker, vk dropped');
      assert.equal(state.split, true);
      assert.match(state.note, note);
      await page.assertClean(url);
    });
  }
});
