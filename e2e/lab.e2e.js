// e2e/lab.e2e.js — страница Endpoint Lab: без API честно пишет «данные недоступны», на localhost-фикстурах
// показывает состояния, список, подробности с кнопкой «Назад», карточки на телефоне; строки сети — только текст.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { e2eSuite } = require('./lib/harness');

const labState = () => document.getElementById('labMain').dataset.labState;

e2eSuite('Endpoint Lab page', (openPage) => {
  test('without Lab data: /api/lab answers 503, honest "not available" state, no fake numbers', async () => {
    // Empty public directory = what Vercel, forks and a server without the Lab mount see.
    const labDir = process.env.E2E_LAB_DIR;
    if (labDir) for (const name of fs.readdirSync(labDir)) fs.rmSync(path.join(labDir, name), { recursive: true, force: true });
    const page = await openPage();
    page.allowErrors(/status of 503/);
    await page.goto('/lab', { app: false });
    await page.waitFor(() => document.getElementById('labMain').dataset.labState === 'not-connected', { message: 'not-connected state' });
    const info = await page.evaluate(() => ({
      title: document.getElementById('labStatusTitle').textContent,
      active: document.querySelector('[data-metric="active"] [data-value]').textContent,
      rows: document.querySelectorAll('#labTableBody tr').length,
      badge: !!document.querySelector('.lab-dev-badge'),
    }));
    assert.match(info.title, /пока недоступны/);
    assert.equal(info.active, '—', 'no invented counts in production mode');
    assert.equal(info.rows, 0);
    assert.equal(info.badge, false);
    assert.deepEqual([...new Set(page.apiCalls.map((c) => new URL(c.url).pathname))], ['/api/lab'], 'only the Lab API, read-only');
    assert.ok(page.apiCalls.every((c) => c.method === 'GET'));
    await page.assertClean('/lab');
  });

  test('healthy fixture: summary, table, sorting keeps rows stable, details open with Back support', async () => {
    const page = await openPage({ width: 1440, height: 900 });
    await page.goto('/lab?fixture=healthy', { app: false });
    await page.waitFor(() => document.querySelectorAll('#labTableBody tr.lab-tr').length > 0, { message: 'rows rendered' });
    assert.equal(await page.evaluate(labState), 'ok');
    const first = await page.evaluate(() => ({
      active: document.querySelector('[data-metric="active"] [data-value]').textContent,
      final: document.getElementById('labQualityFinal').textContent,
      count: document.getElementById('labEndpointsCount').textContent,
    }));
    assert.equal(first.active, '24');
    assert.equal(first.final, '98%');
    // 24 ACTIVE + 44 VERIFIED + 1 SUSPECT: QUARANTINE and DEAD are counts only, never listed
    assert.match(first.count, /25 из 69/);

    await page.click('#labTable th[data-sort="reliability"] .lab-th-btn');
    const sorted = await page.evaluate(() => ({
      aria: document.querySelector('#labTable th[data-sort="reliability"]').getAttribute('aria-sort'),
      top: document.querySelector('#labTableBody tr .lab-rel').textContent,
    }));
    assert.equal(sorted.aria, 'descending');
    assert.equal(sorted.top, '99,8%');

    await page.click('#labTableBody tr:nth-child(1) .lab-ep-btn');
    await page.waitFor(() => document.getElementById('labEndpointModal').classList.contains('is-open')
      && document.querySelector('#labEpBody .lab-checks'), { message: 'details open' });
    assert.match(await page.evaluate(() => location.search), /endpoint=/);
    await page.evaluate(() => history.back());
    await page.waitFor(() => !document.getElementById('labEndpointModal').classList.contains('is-open'), { message: 'Back closes details' });
    assert.doesNotMatch(await page.evaluate(() => location.search), /endpoint=/);

    await page.click('#labTableBody tr:nth-child(2) .lab-ep-btn');
    await page.waitFor(() => document.getElementById('labEndpointModal').classList.contains('is-open'), { message: 'details reopen' });
    await page.press('Escape');
    await page.waitFor(() => !document.getElementById('labEndpointModal').classList.contains('is-open') && !/endpoint=/.test(location.search), { message: 'Esc closes and cleans the URL' });
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('lab-ep-btn')), true, 'focus returns to the row');
    await page.assertClean('/lab healthy');
  });

  test('states: degraded, unavailable, stale, empty, error, malformed are distinct', async () => {
    const page = await openPage();
    const expect = { degraded: 'degraded', unavailable: 'unavailable', stale: 'stale', empty: 'empty', error: 'error', malformed: 'malformed' };
    for (const [fixture, state] of Object.entries(expect)) {
      await page.goto(`/lab?fixture=${fixture}`, { app: false });
      await page.waitFor((s) => document.getElementById('labMain').dataset.labState === s, { args: [state], message: `${fixture} → ${state}` });
      const title = await page.evaluate(() => document.getElementById('labStatusTitle').textContent);
      assert.ok(title.length > 5 && !title.startsWith('lab_'), `${fixture}: translated title`);
    }
    await page.assertClean('states');
  });

  test('network strings render as text; invalid rows are dropped', async () => {
    const page = await openPage();
    await page.goto('/lab?fixture=mixed&endpoint=188.114.96.200:2408', { app: false });
    await page.waitFor(() => document.querySelector('#labEpBody .lab-last-error'), { message: 'details with last error' });
    const info = await page.evaluate(() => ({
      xss: window.__labXss || 0,
      imgs: document.querySelectorAll('#labEpBody img, #labTableBody img').length,
      error: document.querySelector('#labEpBody .lab-last-error').textContent,
      ids: Array.from(document.querySelectorAll('#labTableBody .lab-ep-btn')).map((b) => b.textContent),
    }));
    assert.equal(info.xss, 0);
    assert.equal(info.imgs, 0);
    assert.match(info.error, /<img src=x/);
    assert.ok(!info.ids.some((id) => id.includes('999.') || id.includes('<')), 'invalid IPs are not listed');
    await page.assertClean('mixed');
  });

  test('phone: cards instead of the table, no horizontal scroll', async () => {
    const page = await openPage({ width: 390, height: 844, mobile: true });
    await page.goto('/lab?fixture=healthy', { app: false });
    await page.waitFor(() => document.querySelectorAll('#labCards .lab-card').length > 0, { message: 'cards rendered' });
    const info = await page.evaluate(() => ({
      tableHidden: document.getElementById('labTableWrap').hidden,
      cards: document.querySelectorAll('#labCards .lab-card').length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    assert.equal(info.tableHidden, true);
    assert.equal(info.cards, 10);
    assert.ok(info.overflow <= 0, `page scrolls horizontally by ${info.overflow}px`);
    await page.assertClean('/lab phone');
  });

  test('/en/lab: English texts and the language switch keeps the Lab page', async () => {
    const page = await openPage();
    await page.goto('/en/lab?fixture=healthy', { app: false });
    await page.waitFor(() => document.getElementById('labStatusTitle').textContent === 'Lab is operational', { message: 'English state' });
    assert.equal(await page.evaluate(() => document.querySelector('.site-nav__link--active').getAttribute('href')), '/en/lab');
    await page.click('.lang-btn[data-lang="ru"]');
    await page.waitFor(() => location.pathname === '/lab' && document.documentElement.lang === 'ru', { message: 'switched to /lab' });
    assert.equal(await page.evaluate(() => localStorage.getItem('lang')), 'ru');
    await page.assertClean('/en/lab');
  });

  test('header FAQ opens the dialog on the generator, closing it returns to the Lab; no Instructions item', async () => {
    const dialogOpen = (id) => document.getElementById(id).classList.contains('is-open');
    for (const [from, key, modal, home] of [
      ['/lab?fixture=healthy', 'nav_faq', 'faqModal', '/'],
      ['/en/lab?fixture=healthy', 'nav_faq', 'faqModal', '/en'],
    ]) {
      const page = await openPage({ width: 1440, height: 900 });
      await page.goto(from, { app: false });
      await page.waitFor(() => document.getElementById('labMain').dataset.labState === 'ok', { message: 'Lab page ready' });
      assert.equal(await page.evaluate(() => document.querySelectorAll('.site-nav a[href*="#instructions"]').length), 0, 'no Instructions item');
      await page.click(`.site-nav a[data-i18n="${key}"]`);
      await page.waitFor((p, id) => location.pathname === p && !!document.getElementById(id)
        && document.getElementById(id).classList.contains('is-open'), { args: [home, modal], message: `${modal} open on ${home}` });
      await page.press('Escape');
      await page.waitFor((p) => location.pathname + location.search === p && document.readyState === 'complete',
        { args: [from], message: `back on ${from}` });
      await page.waitFor(() => document.getElementById('labMain').dataset.labState === 'ok', { message: 'Lab page shown again' });
      await page.assertClean(`${from} → ${key} → back`);
    }

    // Opened directly (no Lab page before it): closing the dialog stays on the generator.
    const direct = await openPage();
    await direct.goto('/#faq');
    await direct.waitFor(dialogOpen, { args: ['faqModal'] });
    await direct.press('Escape');
    await direct.waitFor((id) => !document.getElementById(id).classList.contains('is-open'), { args: ['faqModal'] });
    await direct.sleep(600);
    assert.equal(await direct.evaluate(() => location.pathname), '/', 'no navigation without a Lab referrer');
    await direct.assertClean('/#faq');
  });
});
