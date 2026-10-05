// e2e/lab-auto.e2e.js — «Endpoint Lab — авто» в генераторе (Phase D): явный выбор в настройках, пояснение с состоянием
// Lab, запрос endpointMode=lab, итог «проверен Endpoint Lab» и отказ без подмены на hostname. /api/warp — заглушка:
// тест не регистрирует устройство WARP; файлы Lab кладутся в каталог сервера (E2E_LAB_DIR), как в lab-entry.e2e.js.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { e2eSuite, fixtures } = require('./lib/harness');
const { writeLabPublic } = require('../__tests__/helpers/lab-public');

const LAB_DIR = process.env.E2E_LAB_DIR;
const clearLab = () => {
  if (LAB_DIR) for (const name of fs.readdirSync(LAB_DIR)) fs.rmSync(path.join(LAB_DIR, name), { recursive: true, force: true });
};

const stubWarp = (page, respond) => {
  const requests = [];
  page.route((u) => u.pathname === '/api/warp', (u) => {
    requests.push(u);
    return { delayMs: 300, ...respond(u) };
  });
  return requests;
};

/** Открывает настройки на вкладке «Дополнительно» и выбирает endpoint (нативный список — через change). */
const chooseEndpoint = async (page, value) => {
  if (!await page.evaluate(() => document.getElementById('settingsModal').classList.contains('is-open'))) {
    await page.click('.param-chip[data-settings-focus="warpEndpointSelect"]');
    await page.waitFor(() => document.getElementById('settingsModal').classList.contains('is-open'));
  }
  await page.evaluate((v) => {
    const sel = document.getElementById('warpEndpointSelect');
    sel.value = v;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
};

const closeSettings = async (page) => {
  await page.press('Escape');
  await page.waitFor(() => !document.getElementById('settingsModal').classList.contains('is-open'));
};

const note = () => {
  const el = document.getElementById('labAutoNote');
  return { hidden: el.hidden, state: document.getElementById('labAutoState').textContent.trim(),
    link: el.querySelector('a').getAttribute('href'), described: document.getElementById('warpEndpointSelect').getAttribute('aria-describedby') };
};

const LAB_ENDPOINTS = [{ ip: '162.159.192.18', port: 4500 }, { ip: '188.114.97.6', port: 4500 }];

e2eSuite('Lab Auto in the generator', (openPage) => {
  test('explicit choice: Lab state in the note, endpointMode=lab request, result verified by Endpoint Lab', async () => {
    writeLabPublic(LAB_DIR);
    try {
      const page = await openPage({ width: 1440, height: 900 });
      await page.goto('/');
      const requests = stubWarp(page, () => ({ json: fixtures.warpSuccess({ count: 2, lab: { endpoints: LAB_ENDPOINTS } }) }));

      await chooseEndpoint(page, 'hostname');
      assert.equal((await page.evaluate(note)).hidden, true, 'hostname: no Lab note');
      await chooseEndpoint(page, 'lab');
      await page.waitFor(() => /свежие проверенные/.test(document.getElementById('labAutoState').textContent), { message: 'Lab state in the note' });
      assert.deepEqual(await page.evaluate(note), { hidden: false, state: 'есть свежие проверенные endpoint\'ы', link: '/lab', described: 'labAutoNote' });
      await page.click('#tab-extra');
      await page.click('label.radio-label:has(input[name="configCount"][value="2"])');
      await closeSettings(page);
      assert.equal(await page.evaluate(() => document.getElementById('chipEndpoint').textContent), 'Endpoint Lab');

      await page.click('#generateButton');
      await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success', { message: 'success view' });
      assert.equal(requests.length, 1);
      const q = requests[0].searchParams;
      assert.equal(q.get('endpointMode'), 'lab');
      assert.equal(q.get('peerEndpoint'), null, 'Lab Auto never sends a manual endpoint');
      assert.equal(q.get('port'), '4500', 'the port goes as a preference');
      const summary = await page.evaluate(() => document.getElementById('resultSummaryFields').textContent);
      assert.match(summary, /Endpoint Lab — авто \/ проверен Endpoint Lab/);
      assert.match(await page.evaluate(() => document.getElementById('historyList').textContent), /endpoint Lab/);
      await page.assertClean();
    } finally {
      clearLab();
    }
  });

  test('Lab refusal: localized error, no hostname retry, the choice stays Lab Auto (RU and EN)', async () => {
    for (const [url, text] of [['/', /Данные Endpoint Lab устарели/], ['/en', /Endpoint Lab data is stale/]]) {
      const page = await openPage({ width: 1440, height: 900 });
      await page.goto(url);
      page.allowErrors(/status of 503/, /Ошибка при генерации конфигурации/);
      const requests = stubWarp(page, () => ({ status: 503, json: fixtures.warpLabError('lab_stale') }));
      await chooseEndpoint(page, 'lab');
      await closeSettings(page);
      await page.click('#generateButton');
      await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'error', { message: 'error view' });
      const shown = await page.evaluate(() => ({
        error: document.getElementById('resultErrorText').textContent,
        endpoint: document.getElementById('warpEndpointSelect').value,
        chip: document.getElementById('chipEndpoint').textContent,
        history: document.getElementById('historyCount').textContent,
      }));
      assert.match(shown.error, text);
      assert.doesNotMatch(shown.error, /e2e/, 'the UI shows its own translation, not the server text');
      assert.deepEqual([shown.endpoint, shown.chip, shown.history], ['lab', 'Endpoint Lab', '']);
      assert.equal(requests.length, 1, 'no automatic second request in hostname mode');
      await page.assertClean();
    }
  });

  test('port fallback and fewer endpoints are explained in the visitor language', async () => {
    const page = await openPage({ width: 1440, height: 900 });
    await page.goto('/');
    stubWarp(page, () => ({ json: fixtures.warpSuccess({
      lab: { endpoints: [{ ip: '162.159.192.18', port: 2408 }], requested: 3, requestedPort: 880 },
    }) }));
    await chooseEndpoint(page, 'lab');
    await page.evaluate(() => {
      const sel = document.getElementById('warpPortSelect');
      sel.value = '880';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await closeSettings(page);
    await page.click('#generateButton');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success', { message: 'success view' });
    const risks = await page.evaluate(() => document.getElementById('resultRiskLabels').textContent);
    assert.match(risks, /другой проверенный порт/);
    assert.match(risks, /меньше разных свежих endpoint/);
    assert.doesNotMatch(risks, /Endpoint Lab: /, 'no raw English server text');
    assert.match(await page.evaluate(() => document.getElementById('resultSummaryFields').textContent), /2408/, 'the port actually used');
    await page.assertClean();
  });
});
