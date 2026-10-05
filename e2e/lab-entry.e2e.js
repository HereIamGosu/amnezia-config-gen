// e2e/lab-entry.e2e.js — строка «Endpoint Lab» в карточке «Статус системы» главной. Без файлов Lab к /api/lab нет
// ни одного запроса (иначе 503 в консоли), окно говорит «не подключён»; с файлами — число свежих ACTIVE и окно.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { e2eSuite } = require('./lib/harness');
const { writeLabPublic, readFixture } = require('../__tests__/helpers/lab-public');

const LAB_DIR = process.env.E2E_LAB_DIR;
const clearLab = () => {
  if (LAB_DIR) for (const name of fs.readdirSync(LAB_DIR)) fs.rmSync(path.join(LAB_DIR, name), { recursive: true, force: true });
};
const labApiCalls = (page) => page.apiCalls.filter((c) => new URL(c.url).pathname === '/api/lab').length;

e2eSuite('Endpoint Lab entry on the generator page', (openPage) => {
  test('no Lab files: "unavailable", no /api/lab request even after a click, overall state untouched', async () => {
    clearLab();
    const page = await openPage({ width: 1440, height: 900 });
    await page.goto('/');
    await page.waitFor(() => document.getElementById('statusLabState').textContent === 'Недоступен', { message: 'Lab row resolved' });
    assert.match(await page.evaluate(() => document.getElementById('statusOverallText').textContent), /Всё работает/);
    await page.click('#statusLabBtn');
    await page.waitFor(() => {
      const modal = document.getElementById('labQuickModal');
      return modal && modal.dataset.state === 'not-connected' && modal.getAttribute('aria-hidden') === 'false';
    }, { message: 'quick view says the Lab is not connected' });
    assert.equal(labApiCalls(page), 0, 'no request that would answer 503');
    await page.assertClean('/ without Lab files');
  });

  test('Lab files published: fresh ACTIVE count and age in the row, quick view with the same data', async () => {
    writeLabPublic(LAB_DIR);
    try {
      const overview = readFixture('web-overview.json');
      const active = overview.endpoints.filter((e) => e.state === 'ACTIVE').length;
      const page = await openPage({ width: 1440, height: 900 });
      await page.goto('/');
      await page.waitFor(() => /ACTIVE$/.test(document.getElementById('statusLabState').textContent), { message: 'Lab row from /api/lab' });
      const row = await page.evaluate(() => ({
        value: document.getElementById('statusLabState').textContent,
        age: document.getElementById('statusLabSub').textContent,
        quick: document.getElementById('statusLabBtn').dataset.labQuick,
        css: !!document.querySelector('link[href="/lab/lab.css"]'),
      }));
      assert.equal(row.value, `${active} ACTIVE`);
      assert.match(row.age, /назад|только что/);
      assert.equal(row.quick, '', 'the Lab is published: the quick view loads data');
      assert.equal(row.css, false, 'lab.css only on the first open');

      await page.click('#statusLabBtn');
      await page.waitFor(() => {
        const modal = document.getElementById('labQuickModal');
        return modal && modal.dataset.state === 'ok' && modal.querySelector('.lab-quick__value');
      }, { message: 'quick view with Lab data' });
      const quick = await page.evaluate(() => ({
        active: document.querySelector('#labQuickModal .lab-quick__value').textContent,
        link: document.querySelector('#labQuickModal .lab-quick__cta').getAttribute('href'),
        css: !!document.querySelector('link[href="/lab/lab.css"]'),
        container: getComputedStyle(document.documentElement).getPropertyValue('--container').trim(),
      }));
      assert.equal(quick.active, String(active));
      assert.equal(quick.link, '/lab');
      assert.equal(quick.css, true);
      assert.equal(quick.container, '1240px', 'lab.css does not change the generator layout');
      assert.ok(labApiCalls(page) >= 1);
      await page.assertClean('/ with Lab files');
    } finally {
      clearLab();
    }
  });
});
