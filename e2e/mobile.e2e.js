// e2e/mobile.e2e.js — телефонная ширина: нет горизонтальной прокрутки, меню открывает окна и закрывается.
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { e2eSuite, fixtures } = require('./lib/harness');

/** Горизонтальное переполнение страницы и открытых окон; список виновников — для сообщения. */
const overflow = () => {
  const root = document.documentElement;
  const vw = root.clientWidth;
  const culprits = [];
  document.querySelectorAll('body *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || r.right <= vw + 1 || getComputedStyle(el).position === 'fixed') return;
    // Элементы внутри контейнера со своей прокруткой/обрезкой не растягивают страницу
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox !== 'visible') return;
    }
    culprits.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String(el.className).split(' ')[0]} → ${Math.round(r.right)}`);
  });
  const dialogs = Array.from(document.querySelectorAll('.modal.is-open .modal__body'))
    .filter((body) => body.scrollWidth > body.clientWidth + 1)
    .map((body) => `${body.closest('.modal').id}: ${body.scrollWidth} > ${body.clientWidth}`);
  return { page: root.scrollWidth - vw, culprits: culprits.slice(0, 5), dialogs };
};

const assertNoOverflow = async (page, label) => {
  const o = await page.evaluate(overflow);
  assert.ok(o.page <= 0, `${label}: page scrolls horizontally by ${o.page}px: ${o.culprits.join('; ')}`);
  assert.deepEqual(o.culprits, [], `${label}: elements stick out past the right edge`);
  assert.deepEqual(o.dialogs, [], `${label}: dialog content wider than the dialog`);
};

const isOpen = (id) => document.getElementById(id).classList.contains('is-open');
const menuOpen = () => document.getElementById('siteHeader').classList.contains('is-menu-open');

e2eSuite('mobile layout', (openPage) => {
  for (const width of [320, 390]) {
    for (const path of ['/', '/en']) {
      test(`${path} at ${width}px: no horizontal overflow on the page, in dialogs and with a result`, async () => {
        const page = await openPage({ width, height: 844, mobile: true });
        await page.goto(path);
        await assertNoOverflow(page, 'initial');

        await page.tap('#stepParams [data-step-toggle]');
        await page.waitFor(() => !document.getElementById('stepParams').classList.contains('is-collapsed'));
        await page.tap('#paramSummary');
        await page.waitFor(isOpen, { args: ['settingsModal'] });
        for (const tab of ['tab-routes', 'tab-dnscps', 'tab-extra']) {
          await page.tap(`#${tab}`);
          await assertNoOverflow(page, `settings ${tab}`);
        }
        await page.press('Escape');
        await page.waitFor(() => !document.getElementById('settingsModal').classList.contains('is-open'));

        page.route((u) => u.pathname === '/api/warp', () => ({ delayMs: 200, json: fixtures.warpSuccess({ count: 3 }) }));
        await page.tap('#generateButton');
        await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success');
        await assertNoOverflow(page, 'with result');
        await page.tap('#historyModalBtn').catch(async () => {
          // На узком экране «История» живёт в меню
          await page.tap('#menuToggle');
          await page.waitFor(menuOpen);
          await page.tap('#historyModalBtn');
        });
        await page.waitFor(isOpen, { args: ['historyModal'] });
        await assertNoOverflow(page, 'history dialog');
        await page.assertClean(`${path} ${width}px`);
      });
    }
  }

  test('390px: the menu opens dialogs and closes itself', async () => {
    const page = await openPage({ width: 390, height: 844, mobile: true });
    await page.goto('/');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('menuToggle')).display !== 'none'), true, 'burger visible');

    for (const [link, modal] of [
      ['.site-nav a[data-open-modal="faqModal"]', 'faqModal'],
      ['.site-nav a[data-open-modal="instructionModal"]', 'instructionModal'],
      ['.site-nav [data-status-link]', 'statusModal'],
      ['#historyModalBtn', 'historyModal'],
    ]) {
      await page.tap('#menuToggle');
      await page.waitFor(menuOpen, { message: 'menu opened' });
      assert.equal(await page.evaluate(() => document.getElementById('menuToggle').getAttribute('aria-expanded')), 'true');
      await page.tap(link);
      await page.waitFor(isOpen, { args: [modal], message: `${modal} opened from the menu` });
      assert.equal(await page.evaluate(menuOpen), false, `menu closed after choosing ${modal}`);
      await page.tap(`#${modal} .modal__close`);
      await page.waitFor((id) => !document.getElementById(id).classList.contains('is-open'), { args: [modal] });
    }

    // Escape и касание вне меню тоже закрывают его
    await page.tap('#menuToggle');
    await page.waitFor(menuOpen);
    await page.press('Escape');
    await page.waitFor(() => !document.getElementById('siteHeader').classList.contains('is-menu-open'), { message: 'Escape closes the menu' });
    await page.tap('#menuToggle');
    await page.waitFor(menuOpen);
    const outside = await page.evaluate(() => {
      const header = document.getElementById('siteHeader').getBoundingClientRect();
      const nav = document.getElementById('siteNav').getBoundingClientRect();
      return { x: Math.round(window.innerWidth / 2), y: Math.round(Math.max(header.bottom, nav.bottom) + 20), max: window.innerHeight };
    });
    assert.ok(outside.y < outside.max, 'the open menu leaves part of the page visible');
    await page.tapAt(outside.x, outside.y);
    await page.waitFor(() => !document.getElementById('siteHeader').classList.contains('is-menu-open'), { message: 'outside tap closes the menu' });
    assert.equal(page.navigations.length, 1, 'no page navigation');
    await page.assertClean();
  });
});
