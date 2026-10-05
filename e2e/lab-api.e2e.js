// e2e/lab-api.e2e.js — /lab on real /api/lab data (no ?fixture): the files the Lab exporter writes are put into
// the server's Endpoint Lab public directory (E2E_LAB_DIR), the page fetches them through api/lab.js.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { e2eSuite } = require('./lib/harness');
const { writeLabPublic, readFixture } = require('../__tests__/helpers/lab-public');

const LAB_DIR = process.env.E2E_LAB_DIR;
const labState = () => document.getElementById('labMain').dataset.labState;
const rowCount = () => document.querySelectorAll('#labTableBody tr.lab-tr').length;

e2eSuite('Endpoint Lab on real /api/lab data', (openPage) => {
  test('full export: status, counts, freshness, chart, events, table and details come from the API', async () => {
    writeLabPublic(LAB_DIR);
    const page = await openPage({ width: 1440, height: 900 });
    await page.goto('/lab', { app: false });
    await page.waitFor(() => document.querySelectorAll('#labTableBody tr.lab-tr').length > 0, { message: 'rows from /api/lab' });
    const overview = readFixture('web-overview.json');
    const info = await page.evaluate(() => ({
      state: document.getElementById('labMain').dataset.labState,
      fixture: window.LabPage.getState().fixture,
      badge: !!document.querySelector('.lab-dev-badge'),
      active: document.querySelector('[data-metric="active"] [data-value]').textContent,
      fresh: document.getElementById('labFreshWindow').textContent,
      final: document.getElementById('labQualityFinal').textContent,
      basis: document.getElementById('labQualityBasis').hidden ? null : document.getElementById('labQualityBasis').textContent,
      chart: !!document.querySelector('#labChartFrame svg'),
      events: document.querySelectorAll('#labActivityList .lab-event').length,
      rows: document.querySelectorAll('#labTableBody tr.lab-tr').length,
      coverageNote: !document.getElementById('labCoverageNote').hidden,
    }));
    assert.equal(info.state, 'ok');
    assert.equal(info.fixture, null, 'no fixture: real API data');
    assert.equal(info.badge, false);
    assert.equal(info.active, String(overview.counts.active));
    assert.match(info.fresh, /7 мин/);
    // first + retry over every deep check, handshake failures included (the sample has 10 of 90)
    const s = overview.sessions;
    assert.ok(s.failed > 0, 'the sample includes failed checks');
    assert.equal(info.final, await page.evaluate((v) => window.LabCore.formatPercent(v, 'ru'), Math.min(1, s.firstSession + s.retryRescued)));
    assert.equal(info.basis, `${overview.sessions.samples} проверок за 15 минут до обновления`, 'the base of the shares');
    assert.equal(info.chart, true);
    assert.ok(info.events > 0);
    assert.equal(info.rows, overview.endpoints.length);
    assert.equal(info.coverageNote, false, 'full coverage: no "ACTIVE only" note');
    assert.ok(page.apiCalls.some((c) => new URL(c.url).pathname === '/api/lab'));

    await page.click('#labTableBody tr:nth-child(1) .lab-ep-btn');
    await page.waitFor(() => document.querySelector('#labEpBody .lab-checks') && document.querySelector('#labEpBody .lab-timeline__track'),
      { message: 'details from /api/lab?endpoint=' });
    const detail = await page.evaluate(() => ({
      checks: document.querySelectorAll('#labEpBody .lab-checks__row--ok').length,
      lastError: document.querySelector('#labEpBody .lab-last-error').textContent,
    }));
    assert.equal(detail.checks, 3);
    assert.equal(detail.lastError, 'Нет');
    await page.click('#labEpHistoryBtn');
    await page.waitFor(() => document.querySelectorAll('#labHistChart .lab-hist__seg').length > 0, { message: 'history buckets' });
    await page.click('#labHistRange [data-range="24h"]');
    await page.waitFor(() => document.querySelector('#labHistRange [data-range="24h"]').getAttribute('aria-pressed') === 'true'
      && document.querySelectorAll('#labHistChart .lab-hist__seg').length > 0, { message: '24h range from the API' });
    const urls = page.apiCalls.map((c) => c.url);
    assert.ok(urls.some((u) => /\/api\/lab\?endpoint=.*&range=24h$/.test(u)));
    assert.ok(page.apiCalls.every((c) => c.method === 'GET'));
    await page.assertClean('/lab real data');
  });

  test('compatibility mode: real ACTIVE list with an honest "ACTIVE only" note and minimal details', async () => {
    writeLabPublic(LAB_DIR, { mode: 'compat' });
    const page = await openPage();
    await page.goto('/lab', { app: false });
    await page.waitFor(() => document.querySelectorAll('#labTableBody tr.lab-tr').length > 0, { message: 'compat rows' });
    const info = await page.evaluate(() => ({
      state: document.getElementById('labMain').dataset.labState,
      note: document.getElementById('labCoverageNote').hidden ? null : document.getElementById('labCoverageNote').textContent.trim(),
      states: [...new Set(Array.from(document.querySelectorAll('#labTableBody .lab-chip__text')).map((n) => n.textContent))],
      chart: document.getElementById('labChartFrame').textContent.trim(),
      activity: document.getElementById('labActivityEmpty').textContent,
    }));
    assert.equal(info.state, 'ok');
    assert.match(info.note, /только пул ACTIVE/);
    assert.equal(await page.evaluate(() => document.getElementById('labQualityFinal').textContent), '—', 'compat publishes no session shares');
    assert.equal(await page.evaluate(() => document.querySelector('[data-metric="verified"] [data-value]').textContent), '—', 'no operational counts');
    assert.deepEqual(info.states, ['ACTIVE']);
    assert.match(info.chart, /пока недоступна/, 'no invented history');
    assert.match(info.activity, /недоступен/, 'no invented events');
    await page.click('#labTableBody tr:nth-child(1) .lab-ep-btn');
    await page.waitFor(() => document.querySelector('#labEpBody .lab-last-error'), { message: 'compat details' });
    const d = await page.evaluate(() => ({
      lastError: document.querySelector('#labEpBody .lab-last-error').textContent,
      timeline: document.querySelector('#labEpBody .lab-timeline').textContent,
    }));
    assert.equal(d.lastError, 'Нет данных', 'unknown is not "no errors"');
    assert.match(d.timeline, /пока недоступна/);
    await page.assertClean('/lab compat');
  });

  test('stale export keeps the old data and shows STALE; broken export shows the format error', async () => {
    writeLabPublic(LAB_DIR, { ageMs: 40 * 60e3 });
    const page = await openPage();
    await page.goto('/lab', { app: false });
    await page.waitFor(() => document.getElementById('labMain').dataset.labState === 'stale', { message: 'stale' });
    assert.equal(await page.evaluate(rowCount), readFixture('web-overview.json').endpoints.length, 'data stays visible');

    fs.writeFileSync(path.join(LAB_DIR, 'web-overview.json'), '{"schemaVersion":1,');
    page.allowErrors(/status of 503/);
    await page.goto('/lab', { app: false });
    await page.waitFor(() => document.getElementById('labMain').dataset.labState === 'malformed', { message: 'malformed' });
    await page.assertClean('/lab stale + malformed');
  });

  test('details of an endpoint that left the public list: "no longer available"', async () => {
    writeLabPublic(LAB_DIR, { mode: 'compat' });
    const page = await openPage();
    page.allowErrors(/status of 404/);
    await page.goto('/lab?endpoint=162.159.193.20:2408', { app: false });
    await page.waitFor(() => /больше недоступны/.test(document.getElementById('labEpBody').textContent), { message: 'gone' });
    await page.assertClean('/lab gone');
  });

  test('/en/lab and phone width on real data', async () => {
    writeLabPublic(LAB_DIR);
    const page = await openPage({ width: 390, height: 844, mobile: true });
    await page.goto('/en/lab', { app: false });
    await page.waitFor(() => document.querySelectorAll('#labCards .lab-card').length > 0
      && document.getElementById('labStatusTitle').textContent === 'Lab is operational', { message: 'english cards' });
    const info = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tableHidden: document.getElementById('labTableWrap').hidden,
    }));
    assert.ok(info.overflow <= 0, `horizontal scroll ${info.overflow}px`);
    assert.equal(info.tableHidden, true);
    assert.equal(await page.evaluate(labState), 'ok');
    await page.assertClean('/en/lab phone');
  });
});
