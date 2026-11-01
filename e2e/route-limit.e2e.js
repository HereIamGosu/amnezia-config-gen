// e2e/route-limit.e2e.js — граница лимита маршрутов (3.1.9): ровно 1000 — жёлтый счётчик и выключенные невыбранные
// плитки, выше 1000 — красный счётчик; предупреждение «Route budget:» из /api/warp показывается на языке страницы с
// тремя числами. Проверяет то, что отдаёт сервер, в том числе минифицированную сборку (E2E_PUBLIC_DIR).
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { e2eSuite, fixtures } = require('./lib/harness');

/**
 * Заглушка предпросмотра /api/iplist?presets=…: число маршрутов конфига (routes4, 3.2.0) задаёт тест; сырой count4
 * намеренно другой — счётчик обязан показывать routes4.
 */
const stubIplist = (page, state) => page.route(
  (u) => u.pathname === '/api/iplist' && u.searchParams.has('presets'),
  (u) => ({ json: { ...fixtures.iplistCount(u.href), routes4: state.count4, count: state.count4 + 9, count4: state.count4 + 9 } }),
);

const counterState = () => {
  const el = document.getElementById('cidrCounter');
  const unchecked = Array.from(document.querySelectorAll('.cfg-tiles--routes input[type="checkbox"]')).filter((i) => !i.checked);
  return {
    text: el.textContent.replace(/\s+/g, ' ').trim(),
    warn: el.classList.contains('cidr-counter--warn'),
    over: el.classList.contains('cidr-counter--over'),
    uncheckedDisabled: unchecked.map((i) => i.disabled),
  };
};

const waitCounter = (page, count4) => page.waitFor(
  (n) => document.getElementById('cidrCounter').textContent.includes(`${n} / 1000`),
  { args: [count4], message: `counter shows ${count4} / 1000` },
);

const uncheck = async (page, id) => {
  await page.click(`.cfg-tiles--routes label:has(input[value="${id}"])`);
  await page.waitFor((v) => !document.querySelector(`.cfg-tiles--routes input[value="${v}"]`).checked, { args: [id] });
};

e2eSuite('route limit (3.1.9)', (openPage) => {
  test('999 warns, exactly 1000 still warns and stops new tiles, 1001 is over', async () => {
    const page = await openPage({ width: 1440, height: 900 });
    const state = { count4: 999 };
    stubIplist(page, state);
    await page.goto('/?routes=youtube,discord,telegram');
    await page.click('#paramSummary');
    await page.waitFor(() => document.getElementById('settingsModal').classList.contains('is-open'));

    await waitCounter(page, 999);
    let s = await page.evaluate(counterState);
    assert.equal(s.warn, true, s.text);
    assert.equal(s.over, false);
    assert.ok(s.uncheckedDisabled.length > 0 && s.uncheckedDisabled.every((d) => !d), 'tiles enabled below the limit');

    state.count4 = 1000;
    await uncheck(page, 'telegram');
    await waitCounter(page, 1000);
    s = await page.evaluate(counterState);
    assert.equal(s.warn, true, 'exactly the limit is a warning');
    assert.equal(s.over, false, 'exactly the limit is not over');
    assert.ok(s.uncheckedDisabled.every((d) => d), 'unchecked tiles disabled at the limit');

    state.count4 = 1001;
    await uncheck(page, 'discord');
    await waitCounter(page, 1001);
    s = await page.evaluate(counterState);
    assert.equal(s.warn, false);
    assert.equal(s.over, true, 'above the limit is over');
    assert.ok(s.uncheckedDisabled.every((d) => d));
    await page.assertClean();
  });

  for (const [path, expected] of [['/', /В AllowedIPs 1009 IPv4-маршрутов \(в исходных списках 1000\)/], ['/en', /AllowedIPs has 1009 IPv4 routes \(1000 in the source lists\)/]]) {
    test(`${path}: the Route budget warning is shown in the page language with its numbers`, async () => {
      const page = await openPage({ width: 1440, height: 900 });
      await page.goto(`${path}?routes=discord`);
      page.route((u) => u.pathname === '/api/warp', () => ({
        delayMs: 300,
        json: {
          ...fixtures.warpSuccess(),
          routeMode: 'split',
          warning: 'Route budget: 1009 IPv4 routes in AllowedIPs (1000 in the source lists) is above the limit of 1000; phones and routers may handle a list this long unstably.',
        },
      }));
      await page.click('#generateButton');
      await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success', { message: 'success view' });
      const risks = await page.evaluate(() => document.getElementById('resultRiskLabels').textContent);
      assert.match(risks, expected);
      assert.doesNotMatch(risks, /Route budget:/, 'no raw English server text');
      await page.assertClean();
    });
  }
});
