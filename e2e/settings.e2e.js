// e2e/settings.e2e.js — профиль, сводка шага 2, окно настроек и ссылка с настройками.
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { e2eSuite } = require('./lib/harness');

const chipTexts = (page) => page.evaluate(() => Object.fromEntries(
  ['chipRouting', 'chipDns', 'chipEndpoint', 'chipPort', 'chipIpv6', 'chipDevice']
    .map((id) => [id, document.getElementById(id).textContent.trim()]),
));

/** Строка состояния и выделенные (изменённые) пункты сводки. */
const summaryState = (page) => page.evaluate(() => ({
  text: document.getElementById('paramSummaryState').textContent.trim(),
  changed: Array.from(document.querySelectorAll('.param-summary__item--changed')).map((el) => el.dataset.param),
}));

const settingsOpen = () => document.getElementById('settingsModal').classList.contains('is-open');

e2eSuite('profile, step-2 summary and settings dialog', (openPage) => {
  test('profile choice is remembered; the summary starts from the real defaults', async () => {
    const page = await openPage();
    await page.goto('/');
    assert.equal(await page.evaluate(() => document.querySelector('[name="awgProfile"]:checked').value), 'awg2', 'AWG 2.0 by default');
    assert.deepEqual(await chipTexts(page), {
      chipRouting: 'Полный туннель',
      chipDns: 'Cloudflare',
      chipEndpoint: 'Автовыбор',
      chipPort: '4500',
      chipIpv6: 'Выключен',
      chipDevice: 'Универсальный',
    });
    assert.deepEqual(await summaryState(page), { text: 'Все параметры по умолчанию', changed: [] });

    await page.click('label.profile-card:has(#profileAwg3)');
    assert.equal(await page.evaluate(() => document.getElementById('profileAwg3').checked), true);
    assert.equal(await page.evaluate(() => localStorage.getItem('awg_profile')), 'awg3');
    await page.goto('/');
    assert.equal(await page.evaluate(() => document.querySelector('[name="awgProfile"]:checked').value), 'awg3', 'restored after reload');
    await page.assertClean();
  });

  test('settings changes are reflected by the summary and named in its state line', async () => {
    const page = await openPage();
    await page.goto('/');

    // Маршруты: выборочный режим и два направления
    await page.click('#paramSummary');
    await page.waitFor(settingsOpen);
    await page.click('#routeModeSplit');
    await page.click('#routeTilesSocial .cfg-tile:has(input[value="youtube"])');
    await page.click('#routeTilesSocial .cfg-tile:has(input[value="discord"])');
    // DNS
    await page.click('#tab-dnscps');
    await page.click('#dnsTiles .cfg-tile:has(input[value="adguard"])');
    // Дополнительно: порт, endpoint (нативный список выбора — через change), смартфон
    await page.click('#tab-extra');
    await page.evaluate(() => {
      for (const [id, value] of [['warpPortSelect', '2408'], ['warpEndpointSelect', '162.159.192.1']]) {
        const sel = document.getElementById(id);
        sel.value = value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await page.click('#ipv6Toggle');
    assert.equal((await chipTexts(page)).chipIpv6, 'Включён');
    await page.click('#mobileModeToggle');
    const ipv6 = await page.evaluate(() => {
      const el = document.getElementById('ipv6Toggle');
      return { checked: el.checked, disabled: el.disabled };
    });
    assert.deepEqual(ipv6, { checked: false, disabled: true }, 'mobile mode switches IPv6 off and locks it (I7)');
    await page.press('Escape');
    await page.waitFor(() => !document.getElementById('settingsModal').classList.contains('is-open'));

    assert.deepEqual(await chipTexts(page), {
      chipRouting: 'Выборочная · 2',
      chipDns: 'AdGuard',
      chipEndpoint: '162.159.192.1',
      chipPort: '2408',
      chipIpv6: 'Выключен',
      chipDevice: 'Смартфон',
    });
    assert.deepEqual(await summaryState(page), {
      text: 'Изменено: Маршрутизация, DNS, Endpoint, Порт WARP, Устройство',
      changed: ['routing', 'dns', 'endpoint', 'port', 'device'],
    });
    await page.assertClean();
  });

  test('the summary is the only entry: any spot opens settings on the first tab, Escape returns focus', async () => {
    const page = await openPage();
    await page.goto('/');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#stepParamsBody button').length), 1,
      'one button in step 2');
    // Клик по значению внутри карточки — это тот же вход, что и «Изменить параметры»
    for (const target of ['#chipPort', '#paramSummaryEdit']) {
      await page.click(target);
      await page.waitFor(settingsOpen, { message: `settings open from ${target}` });
      const tab = await page.evaluate(() => document.querySelector('#settingsModal [role="tab"][aria-selected="true"]').id);
      assert.equal(tab, 'tab-routes', `${target} opens the first tab`);
      await page.click('#tab-extra');
      await page.press('Escape');
      await page.waitFor(() => !document.getElementById('settingsModal').classList.contains('is-open'));
      assert.equal(await page.evaluate(() => document.activeElement.id), 'paramSummary', 'focus returns to the summary');
    }
    const name = await page.evaluate(() => {
      const btn = document.getElementById('paramSummary');
      return document.getElementById(btn.getAttribute('aria-labelledby')).textContent.trim();
    });
    assert.equal(name, 'Изменить параметры', 'short accessible name; values come as the description');
    await page.assertClean();
  });

  test('switching settings tabs keeps the dialog height', async () => {
    for (const [width, height] of [[1280, 900], [390, 844]]) {
      const page = await openPage({ width, height, mobile: width < 500 });
      await page.goto('/');
      await page.evaluate(() => {
        const toggle = document.querySelector('#stepParams [data-step-toggle]');
        if (toggle.getAttribute('aria-expanded') === 'false') toggle.click();
      });
      await page.click('#paramSummary');
      await page.waitFor(settingsOpen);
      const heights = {};
      for (const tab of ['tab-dnscps', 'tab-extra', 'tab-routes', 'tab-extra']) {
        await page.click(`#${tab}`);
        heights[tab] = await page.evaluate(() => document.querySelector('#settingsModal .modal__dialog').offsetHeight);
      }
      const values = Object.values(heights);
      assert.ok(Math.max(...values) - Math.min(...values) <= 1, `dialog height stable at ${width}px: ${JSON.stringify(heights)}`);
      await page.assertClean(`${width}px`);
    }
  });

  test('settings link ?profile=…&routes=… presets the UI, and the copy button rebuilds it', async () => {
    const page = await openPage();
    await page.goto('/?profile=awg3&routes=youtube,discord,unknown-e2e&dns=adguard&port=2408&endpoint=162.159.192.1&device=mobile&ipv6=1&count=2');
    const state = await page.evaluate(() => ({
      profile: document.querySelector('[name="awgProfile"]:checked').value,
      routes: Array.from(document.querySelectorAll('.cfg-tiles--routes input:checked')).map((i) => i.value).sort(),
      dns: document.querySelector('input[name="dns-preset"]:checked').value,
      count: document.querySelector('[name="configCount"]:checked').value,
      ipv6: { checked: document.getElementById('ipv6Toggle').checked, disabled: document.getElementById('ipv6Toggle').disabled },
      remembered: localStorage.getItem('awg_profile'),
    }));
    assert.deepEqual(state, {
      profile: 'awg3',
      routes: ['discord', 'youtube'],
      dns: 'adguard',
      count: '2',
      ipv6: { checked: false, disabled: true },
      remembered: null,
    }, 'unknown route dropped, mobile forbids IPv6, link does not overwrite the remembered profile');
    assert.deepEqual(await chipTexts(page), {
      chipRouting: 'Выборочная · 2',
      chipDns: 'AdGuard',
      chipEndpoint: '162.159.192.1',
      chipPort: '2408',
      chipIpv6: 'Выключен',
      chipDevice: 'Смартфон',
    });
    assert.deepEqual(await summaryState(page), {
      text: 'Изменено: Маршрутизация, DNS, Endpoint, Порт WARP, Устройство, Число конфигов',
      changed: ['routing', 'dns', 'endpoint', 'port', 'device'],
    }, 'a change outside the summary (number of configs) is still named');

    await page.click('#paramSummary');
    await page.waitFor(settingsOpen);
    await page.click('#settingsShareLink');
    const copied = await page.waitFor(() => window.__e2e.clipboard[0], { message: 'settings link copied' });
    const url = new URL(copied);
    assert.equal(url.origin + url.pathname, `${page.baseUrl}/`);
    assert.equal(url.searchParams.get('profile'), 'awg3');
    assert.deepEqual(url.searchParams.get('routes').split(',').sort(), ['discord', 'youtube']);
    assert.equal(url.searchParams.get('dns'), 'adguard');
    assert.equal(url.searchParams.get('device'), 'mobile');
    assert.equal(url.searchParams.get('port'), '2408');
    assert.equal(url.searchParams.get('count'), '2');
    assert.equal(url.searchParams.get('ipv6'), null, 'IPv6 never travels with the mobile device');
    await page.assertClean();
  });

  test('invalid settings-link values are ignored on /en', async () => {
    const page = await openPage();
    await page.goto('/en?profile=awg9&port=1234&dns=nope&endpoint=1.2.3.4&routes=nope&count=7');
    const state = await page.evaluate(() => ({
      profile: document.querySelector('[name="awgProfile"]:checked').value,
      routes: document.querySelectorAll('.cfg-tiles--routes input:checked').length,
      count: document.querySelector('[name="configCount"]:checked').value,
      port: document.getElementById('chipPort').textContent.trim(),
      routing: document.getElementById('chipRouting').textContent.trim(),
    }));
    assert.deepEqual(state, { profile: 'awg2', routes: 0, count: '1', port: '4500', routing: 'Full tunnel' });
    await page.assertClean();
  });
});
