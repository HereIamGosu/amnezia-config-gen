// e2e/pages.e2e.js — страницы открываются без ошибок консоли, нарушений CSP и запросов наружу.
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { e2eSuite } = require('./lib/harness');

e2eSuite('pages load cleanly', (openPage) => {
  for (const [path, lang, title] of [['/', 'ru', /Amnezia WG/], ['/en', 'en', /AmneziaWG Config Generator/]]) {
    test(`${path}: app ready, ${lang} texts, zero console errors and CSP violations`, async () => {
      const page = await openPage();
      await page.goto(path);
      const info = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        title: document.title,
        h1: document.querySelector('h1').textContent.trim(),
        tiles: document.querySelectorAll('.cfg-tiles input').length,
        generate: document.getElementById('generateButton').textContent.trim(),
        status: document.getElementById('statusOverallText').textContent.trim(),
      }));
      assert.equal(info.lang, lang);
      assert.match(info.title, title);
      assert.ok(info.h1.length > 10, 'h1 is rendered');
      assert.ok(info.tiles > 10, 'route and DNS tiles rendered from the catalogue');
      assert.match(info.generate, lang === 'ru' ? /Сгенерировать/ : /Generate/);
      // Карточка статуса получила данные (healthcheck — заглушка, /api/status — настоящий обработчик)
      assert.match(info.status, lang === 'ru' ? /Всё работает/ : /operational|All systems|working/i);
      const calls = page.apiCalls.map((c) => new URL(c.url).pathname);
      for (const api of ['/api/iplist', '/api/status', '/api/healthcheck']) assert.ok(calls.includes(api), `${api} requested`);
      await page.assertClean(path);
    });
  }

  test('status page renders live cards; 404 page has no errors besides its own status', async () => {
    const page = await openPage();
    await page.goto('/status.html', { app: false });
    await page.waitFor(() => document.getElementById('statusContent').className === ''
      && !document.getElementById('lastChecked').hidden, { message: 'status cards rendered' });
    await page.assertClean('/status.html');

    page.allowErrors(/status of 404/);
    await page.goto('/no-such-page-e2e', { app: false });
    assert.ok(await page.evaluate(() => /404/.test(document.body.innerText)), '404 page shown');
    await page.assertClean('404');
  });

  test('self-check: the harness does catch CSP violations and console errors', async () => {
    const page = await openPage();
    await page.goto('/');
    await page.evaluate(() => {
      const s = document.createElement('script');
      s.textContent = 'window.__inlineRan = true;';
      document.body.appendChild(s);
      // eslint-disable-next-line no-console
      console.error('e2e self-check error');
    });
    await page.waitFor(() => window.__e2e.csp.length > 0, { message: 'securitypolicyviolation fired' });
    assert.equal(await page.evaluate(() => window.__inlineRan === true), false, 'inline script must be blocked by CSP');
    assert.ok(page.errors.some((e) => e.includes('e2e self-check error')), 'console.error captured');
    await assert.rejects(page.assertClean('self-check'));
  });
});
