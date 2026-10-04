// e2e/dialogs.e2e.js — окна поверх окон: история → просмотр, FAQ, статус без ухода со страницы.
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { e2eSuite, fixtures } = require('./lib/harness');

const isOpen = (id) => document.getElementById(id).classList.contains('is-open');

/** Какое окно сверху в центре его диалога (elementFromPoint), и открытые окна по порядку z-index. */
const topmostAt = (id) => {
  const dialog = document.querySelector(`#${id} .modal__dialog`);
  const r = dialog.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 120));
  const owner = hit && hit.closest('.modal');
  return owner ? owner.id : null;
};

const seedHistory = (page) => page.evaluate((conf) => {
  localStorage.setItem('awg_history', JSON.stringify([{
    ts: Date.now() - 60_000,
    mode: 'awg2',
    presets: [],
    dns: 'cloudflare',
    b64: btoa(conf),
    filename: 'AmneziaWarp.conf',
    routeMode: 'full',
    port: 4500,
    endpoint: 'auto',
    mobile: false,
    router: false,
  }]));
}, fixtures.buildConf());

e2eSuite('stacked dialogs', (openPage) => {
  test('History → eye opens the preview on top; Escape returns to History with focus on the eye', async () => {
    const page = await openPage();
    await page.goto('/');
    await seedHistory(page);
    await page.goto('/');
    assert.equal(await page.evaluate(() => document.getElementById('historyCount').textContent), '1');

    await page.click('#historyModalBtn');
    await page.waitFor(isOpen, { args: ['historyModal'] });
    const eye = '#historyList .history-item__actions button:first-child';
    await page.click(eye);
    await page.waitFor(isOpen, { args: ['configPreviewModal'] });

    assert.equal(await page.evaluate(topmostAt, 'configPreviewModal'), 'configPreviewModal', 'preview is on top of History');
    const z = await page.evaluate(() => [
      Number(getComputedStyle(document.getElementById('historyModal')).zIndex),
      Number(getComputedStyle(document.getElementById('configPreviewModal')).zIndex),
    ]);
    assert.ok(z[1] > z[0], `preview z-index ${z[1]} above history ${z[0]}`);
    const preview = await page.evaluate(() => ({
      text: document.getElementById('configPreviewCode').textContent,
      masks: document.querySelectorAll('#configPreviewCode .c-mask').length,
    }));
    assert.equal(preview.masks, 1, 'PrivateKey masked');
    assert.ok(!preview.text.includes(fixtures.FAKE_PRIVATE_KEY), 'private key not on screen');
    assert.match(preview.text, /\[Peer\]/);

    // «Копировать» отдаёт полный конфиг, хотя на экране ключ скрыт
    await page.click('#copyConfigBtnModal');
    const copied = await page.waitFor(() => window.__e2e.clipboard[0]);
    assert.ok(copied.includes(fixtures.FAKE_PRIVATE_KEY), 'copy gives the full config');

    await page.press('Escape');
    await page.waitFor(() => !document.getElementById('configPreviewModal').classList.contains('is-open'));
    assert.equal(await page.evaluate(isOpen, 'historyModal'), true, 'History is still open');
    assert.equal(await page.evaluate(topmostAt, 'historyModal'), 'historyModal');
    assert.ok(await page.evaluate((sel) => document.activeElement === document.querySelector(sel), eye), 'focus back on the eye button');

    await page.press('Escape');
    await page.waitFor(() => !document.getElementById('historyModal').classList.contains('is-open'));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'historyModalBtn', 'focus back on the header button');
    await page.assertClean();
  });

  test('FAQ opens from the header and from /#faq without leaving the page', async () => {
    const page = await openPage();
    await page.goto('/');
    const navigations = page.navigations.length;
    await page.click('.site-nav a[data-open-modal="faqModal"]');
    await page.waitFor(isOpen, { args: ['faqModal'] });
    assert.equal(await page.evaluate(topmostAt, 'faqModal'), 'faqModal');
    assert.ok(await page.evaluate(() => document.querySelectorAll('#faqModal .faq__item').length >= 10), 'FAQ items rendered');
    assert.equal(page.navigations.length, navigations, 'no navigation');
    await page.press('Escape');
    await page.waitFor(() => !document.getElementById('faqModal').classList.contains('is-open'));

    const direct = await openPage();
    await direct.goto('/#faq');
    await direct.waitFor(isOpen, { args: ['faqModal'] });
    assert.equal(await direct.evaluate(topmostAt, 'faqModal'), 'faqModal', '/#faq opens the FAQ dialog');
    await page.assertClean('header');
    await direct.assertClean('/#faq');
  });

  test('status links in the header and inside the FAQ open the status dialog, no navigation', async () => {
    const page = await openPage();
    await page.goto('/');
    const before = { navigations: page.navigations.length, url: await page.evaluate(() => location.href) };

    await page.click('.site-nav [data-status-link]');
    await page.waitFor(isOpen, { args: ['statusModal'] });
    await page.waitFor(() => document.querySelectorAll('#statusModalContent .status-card').length === 4,
      { message: 'four status cards in the dialog' });
    assert.equal(await page.evaluate(topmostAt, 'statusModal'), 'statusModal');
    await page.press('Escape');
    await page.waitFor(() => !document.getElementById('statusModal').classList.contains('is-open'));

    await page.click('.site-nav a[data-open-modal="faqModal"]');
    await page.waitFor(isOpen, { args: ['faqModal'] });
    await page.click('#faqModal .faq__item:has([data-status-link]) summary');
    await page.click('#faqModal [data-status-link]');
    await page.waitFor(isOpen, { args: ['statusModal'] });
    assert.equal(await page.evaluate(topmostAt, 'statusModal'), 'statusModal', 'status dialog stacks over the FAQ');
    await page.press('Escape');
    await page.waitFor(() => !document.getElementById('statusModal').classList.contains('is-open'));
    assert.equal(await page.evaluate(isOpen, 'faqModal'), true, 'back in the FAQ');

    assert.equal(page.navigations.length, before.navigations, 'no navigation to status.html');
    assert.equal(await page.evaluate(() => location.href), before.url);
    await page.assertClean();
  });
});
