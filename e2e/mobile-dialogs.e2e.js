// e2e/mobile-dialogs.e2e.js — размеры iPhone 14 Pro: каждое окно каждой страницы открывается так, что крестик
// целиком на экране и закрывает окно, тап по затемнению над листом тоже закрывает; ни окно, ни страница не
// прокручиваются вбок. 852 px — высота экрана без панелей Safari, 660 px — видимая область с панелями
// (в Safari 100vh больше неё: окна по vh выталкивали шапку с крестиком за край экрана).
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

const VIEWPORTS = [[393, 852], [393, 660]];

const HISTORY = JSON.stringify([1, 2, 3].map((n) => ({
  ts: Date.now() - n * 3_600_000, mode: n === 1 ? 'awg31' : 'awg2', presets: [], dns: 'cloudflare',
  b64: Buffer.from(`[Interface]\nPrivateKey = kE2eFakeKey${n}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nAddress = 172.16.0.2/32\n`).toString('base64'),
  filename: `AmneziaWarp_${n}.conf`, routeMode: 'full', port: 4500, endpoint: 'auto', mobile: false, router: false,
})));

const isOpen = (id) => document.getElementById(id).classList.contains('is-open');
const isClosed = (id) => !document.getElementById(id).classList.contains('is-open');

const geometry = (id) => {
  const modal = document.getElementById(id);
  const dialog = modal.querySelector('.modal__dialog') || modal.firstElementChild;
  const close = modal.querySelector('.modal__close') || modal.querySelector('[data-close-modal]');
  const d = dialog.getBoundingClientRect();
  const c = close ? close.getBoundingClientRect() : null;
  const body = modal.querySelector('.modal__body');
  return {
    vw: innerWidth,
    vh: innerHeight,
    dialog: { top: Math.round(d.top), bottom: Math.round(d.bottom) },
    close: c && { top: Math.round(c.top), bottom: Math.round(c.bottom), left: Math.round(c.left), right: Math.round(c.right) },
    closeSelector: close && close.classList.contains('modal__close') ? '.modal__close' : '[data-close-modal]',
    wide: body ? body.scrollWidth > body.clientWidth + 1 : false,
    pageWide: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
};

/** Окно открыто: крестик на экране и закрывает окно; если над листом есть затемнение, тап по нему тоже закрывает. */
const checkDialog = async (page, id, open, label) => {
  await open();
  await page.waitFor(isOpen, { args: [id], message: `${label}: ${id} opens` });
  await page.sleep(300); // анимация листа
  const g = await page.evaluate(geometry, id);
  const where = `${label}: ${id} at ${g.vw}×${g.vh}`;
  assert.ok(g.close, `${where}: has a close button`);
  assert.ok(g.close.top >= 0 && g.close.bottom <= g.vh && g.close.left >= 0 && g.close.right <= g.vw,
    `${where}: close button off screen ${JSON.stringify(g.close)}`);
  assert.ok(g.dialog.top >= 0 && g.dialog.bottom <= g.vh + 1, `${where}: dialog outside the screen ${JSON.stringify(g.dialog)}`);
  assert.equal(g.wide, false, `${where}: content wider than the dialog`);
  assert.equal(g.pageWide, false, `${where}: page scrolls horizontally`);
  await page.tap(`#${id} ${g.closeSelector}`);
  await page.waitFor(isClosed, { args: [id], message: `${where}: the close button closes it` });
  if (g.dialog.top > 24) {
    await open();
    await page.waitFor(isOpen, { args: [id] });
    await page.sleep(300);
    await page.tapAt(Math.round(g.vw / 2), Math.round(g.dialog.top / 2));
    await page.waitFor(isClosed, { args: [id], message: `${where}: tapping the backdrop closes it` });
  }
};

const viaShell = (page, id) => () => page.evaluate((modalId) => window.UiShell.openModal(modalId), id);
const viaClick = (page, selector) => () => page.evaluate((sel) => document.querySelector(sel).click(), selector);

/** Шапка телефона: значок GitHub виден, пункта «GitHub» в меню нет. */
const checkHeader = async (page, label) => {
  const header = await page.evaluate(() => {
    const icon = document.querySelector('.site-header .header-icon-link');
    const r = icon && icon.getBoundingClientRect();
    return {
      icon: Boolean(r && r.width > 0 && r.left >= 0 && r.right <= innerWidth),
      navGithub: [...document.querySelectorAll('.site-nav a')].some((a) => /github\.com/.test(a.href)),
    };
  });
  assert.equal(header.icon, true, `${label}: the GitHub icon is in the header`);
  assert.equal(header.navGithub, false, `${label}: no GitHub item in the menu`);
};

e2eSuite('mobile dialogs (iPhone 14 Pro sizes)', (openPage) => {
  for (const [width, height] of VIEWPORTS) {
    for (const lang of ['/', '/en']) {
      test(`${lang} at ${width}×${height}: every dialog fits, closes by its button and by the backdrop`, async () => {
        writeLabPublic(LAB_DIR);
        try {
          const page = await openPage({ width, height, mobile: true });
          await page.goto(lang);
          await page.evaluate((value) => localStorage.setItem('awg_history', value), HISTORY);
          await page.goto(lang);
          await checkHeader(page, lang);
          assert.equal(await page.evaluate(() => document.getElementById('stepParams').classList.contains('is-collapsed')), false,
            'step 2 is expanded');

          page.route((u) => u.pathname === '/api/warp', (u) => ({ delayMs: 100, json: fixtures.warpSuccess({ mode: u.searchParams.get('mode') }) }));
          await page.tap('#generateButton');
          await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success', { message: 'result' });

          await checkDialog(page, 'settingsModal', () => page.tap('#paramSummary'), lang);
          await checkDialog(page, 'statusModal', viaClick(page, '#statusModalBtn'), lang);
          await checkDialog(page, 'historyModal', viaClick(page, '#historyModalBtn'), lang);
          await checkDialog(page, 'configPreviewModal', viaClick(page, '[data-result-action="preview"]'), lang);
          await checkDialog(page, 'labQuickModal', viaClick(page, '#statusLabBtn'), lang);
          for (const id of ['resultInfoModal', 'instructionModal', 'modal', 'faqModal', 'privacyModal', 'disclaimerModal', 'communityModal']) {
            await checkDialog(page, id, viaShell(page, id), lang);
          }
          // «Сообщество» на телефоне открывает окно, а не Telegram
          await checkDialog(page, 'communityModal', () => page.tap('#community .info-card__head'), `${lang} community card`);
          const links = await page.evaluate(() => [...document.querySelectorAll('#communityModal a')].map((a) => new URL(a.href).hostname));
          assert.ok(links.includes('t.me') && links.includes('github.com') && links.includes('discord.gg'), links.join(' '));
          await page.assertClean(`${lang} ${width}×${height}`);
        } finally {
          clearLab();
        }
      });
    }

    for (const lab of ['/lab?fixture=healthy', '/en/lab?fixture=healthy']) {
      test(`${lab} at ${width}×${height}: every dialog fits, closes by its button and by the backdrop`, async () => {
        const page = await openPage({ width, height, mobile: true });
        await page.goto(lab, { app: false });
        await page.evaluate((value) => localStorage.setItem('awg_history', value), HISTORY);
        await page.goto(lab, { app: false });
        await page.waitFor(() => document.getElementById('labMain').dataset.labState === 'ok', { message: 'Lab ready' });
        await checkHeader(page, lab);

        for (const id of ['faqModal', 'privacyModal', 'disclaimerModal']) await checkDialog(page, id, viaShell(page, id), lab);
        await checkDialog(page, 'labInfoModal', viaClick(page, '[data-open-modal="labInfoModal"]'), lab);
        await checkDialog(page, 'labEventsModal', viaClick(page, '#labEventsBtn'), lab);
        await checkDialog(page, 'historyModal', viaClick(page, '#historyModalBtn'), lab);
        await checkDialog(page, 'labEndpointModal', viaClick(page, '#labCards .lab-ep-btn'), lab);

        // История endpoint'а открывается поверх подробностей; закрытие возвращает к подробностям
        await page.evaluate(() => document.querySelector('#labCards .lab-ep-btn').click());
        await page.waitFor(isOpen, { args: ['labEndpointModal'] });
        await page.waitFor(() => document.getElementById('labEpHistoryBtn') && !document.getElementById('labEpHistoryBtn').disabled,
          { message: 'history button ready' });
        await page.tap('#labEpHistoryBtn');
        await page.waitFor(isOpen, { args: ['labHistoryModal'] });
        await page.sleep(300);
        const g = await page.evaluate(geometry, 'labHistoryModal');
        assert.ok(g.close.top >= 0 && g.close.bottom <= g.vh, `${lab}: history close button off screen ${JSON.stringify(g.close)}`);
        await page.tap('#labHistoryModal .modal__close');
        await page.waitFor(isClosed, { args: ['labHistoryModal'] });
        assert.equal(await page.evaluate(isOpen, 'labEndpointModal'), true, 'back to the endpoint details');
        await page.tap('#labEndpointModal .modal__close');
        await page.waitFor(isClosed, { args: ['labEndpointModal'] });
        await page.assertClean(`${lab} ${width}×${height}`);
      });
    }
  }

  test('status page and 404 at 393 px: header with the GitHub icon, no horizontal scroll', async () => {
    for (const p of ['/status.html', '/no-such-page']) {
      const page = await openPage({ width: 393, height: 852, mobile: true });
      if (p !== '/status.html') page.allowErrors(/404/);
      await page.goto(p, { app: false });
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      assert.equal(wide, false, `${p}: page scrolls horizontally`);
      await page.assertClean(p);
    }
  });
});
