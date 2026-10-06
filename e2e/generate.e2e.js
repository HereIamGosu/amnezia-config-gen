// e2e/generate.e2e.js — генерация с заглушкой /api/warp: результат, маска ключа, варианты, vpn://,
// ошибка и восстановление, стабильность раскладки после ответа.
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { e2eSuite, fixtures } = require('./lib/harness');

/** Заглушка /api/warp: отдаёт ответ с задержкой (как настоящая регистрация WARP) и запоминает запросы. */
const stubWarp = (page, respond, delayMs = 800) => {
  const requests = [];
  page.route((u) => u.pathname === '/api/warp', (u) => {
    requests.push(u);
    return { delayMs, ...respond(u) };
  });
  return requests;
};

const view = () => {
  const panel = document.getElementById('resultPanel');
  return panel.hidden ? 'hidden' : panel.dataset.view;
};

const codeText = () => document.getElementById('resultCode').textContent;

/** Сдвиги макета после момента since (мс performance.now), без вызванных вводом. */
const shiftsSince = async (page, since) => {
  const shifts = (await page.layoutShifts()).filter((s) => s.time >= since);
  const counted = shifts.filter((s) => !s.hadRecentInput);
  return {
    cls: counted.reduce((sum, s) => sum + s.value, 0),
    counted,
    input: shifts.filter((s) => s.hadRecentInput),
  };
};

e2eSuite('generation (stubbed /api/warp)', (openPage) => {
  test('success: result panel, masked PrivateKey, two variants, vpn:// tab and copy, history', async () => {
    const page = await openPage();
    await page.goto('/');
    const requests = stubWarp(page, (u) => ({ json: fixtures.warpSuccess({ mode: u.searchParams.get('mode'), count: 2 }) }));

    await page.click('#paramSummary');
    await page.click('#tab-extra');
    await page.click('label.radio-label:has(input[name="configCount"][value="2"])');
    await page.press('Escape');

    await page.click('#generateButton');
    await page.waitFor(view, { message: 'panel shown' });
    assert.equal(await page.evaluate(view), 'loading');
    assert.equal(await page.evaluate(() => document.getElementById('generateButton').disabled), true, 'button locked while loading');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success', { message: 'success view' });

    assert.equal(requests.length, 1);
    const q = requests[0].searchParams;
    assert.equal(q.get('mode'), 'awg2');
    assert.equal(q.get('count'), '2');
    assert.equal(q.get('link'), '1');
    assert.equal(q.get('routeMode'), 'full');

    const result = await page.evaluate(() => ({
      title: document.getElementById('resultTitle').textContent.trim(),
      subtitle: document.getElementById('resultSubtitle').textContent.trim(),
      variants: Array.from(document.querySelectorAll('#resultVariantButtons button')).map((b) => b.getAttribute('aria-pressed')),
      variantsHidden: document.getElementById('resultVariants').hidden,
      masks: document.querySelectorAll('#resultCode .c-mask').length,
      summary: document.querySelectorAll('#resultQuickSummary .summary-item').length,
      enabled: !document.getElementById('generateButton').disabled,
      history: document.getElementById('historyCount').textContent,
    }));
    assert.equal(result.title, 'Конфигурация готова!');
    assert.match(result.subtitle, /AWG 2\.0/);
    assert.equal(result.variantsHidden, false);
    assert.deepEqual(result.variants, ['true', 'false']);
    assert.equal(result.masks, 1, 'PrivateKey masked in the preview');
    assert.equal(result.summary, 8);
    assert.ok(result.enabled, 'button unlocked');
    assert.equal(result.history, '1', 'saved to history');
    let code = await page.evaluate(codeText);
    assert.ok(!code.includes(fixtures.FAKE_PRIVATE_KEY), 'private key not on screen');
    assert.match(code, /Address = 172\.16\.0\.2\/32/);
    assert.match(code, /^I1 = /m, 'uppercase I1 (invariant I1)');

    // Второй вариант
    await page.click('#resultVariantButtons button:nth-child(2)');
    await page.waitFor(() => document.querySelector('#resultVariantButtons button:nth-child(2)').getAttribute('aria-pressed') === 'true');
    code = await page.evaluate(codeText);
    assert.match(code, /Address = 172\.16\.0\.3\/32/, 'variant 2 shown');

    // vpn:// — на экране только начало, копируется полная ссылка выбранного варианта
    await page.click('#resultTabLink');
    await page.waitFor(() => document.getElementById('resultCode').textContent.startsWith('vpn://'));
    const linkView = await page.evaluate(() => ({
      text: document.getElementById('resultCode').textContent,
      masks: document.querySelectorAll('#resultCode .c-mask').length,
      note: document.getElementById('resultCodeNote').dataset.active,
    }));
    assert.equal(linkView.masks, 1);
    assert.ok(linkView.text.length < 60, 'only the beginning of vpn:// is shown');
    assert.equal(linkView.note, 'link');
    await page.click('#resultCopyLink');
    const copied = await page.waitFor(() => window.__e2e.clipboard[0]);
    const expected = fixtures.warpSuccess({ count: 2 }).configs[1].vpnLink;
    assert.equal(copied, expected, 'full vpn:// of variant 2 copied');
    await page.waitFor(() => { const t = document.getElementById('uiToast'); return t && !t.hidden; }, { message: 'toast' });
    await page.assertClean();
  });

  test('compatibility card: works / uncertain tiles with logos, collapsed "not directly" chips by reason', async () => {
    const page = await openPage({ width: 1440, height: 900 });
    await page.goto('/');
    stubWarp(page, (u) => ({ json: fixtures.warpSuccess({ mode: u.searchParams.get('mode') }) }), 200);
    const card = () => {
      const tiles = (id) => [...document.querySelectorAll(`#${id} .compat-app`)].map((li) => ({
        client: li.dataset.client,
        logo: li.querySelector('.compat-logo').className,
        mono: li.querySelector('.compat-logo').textContent,
        platforms: [...li.querySelectorAll('.compat-platform')].map((p) => p.textContent),
        formats: [...li.querySelectorAll('.compat-chip--format')].map((c) => c.textContent),
        notes: [...li.querySelectorAll('.compat-app__note')].map((n) => n.textContent),
      }));
      const other = document.getElementById('compatNotRecommended');
      return {
        hidden: document.getElementById('compatibilityCard').hidden,
        formats: [...document.querySelectorAll('#compatFormat .compat-chip')].map((c) => c.textContent),
        works: tiles('compatRecommendedList'),
        maybe: tiles('compatExperimentalList'),
        otherOpen: other.open,
        otherCount: document.getElementById('compatNotRecommendedCount').textContent,
        reasons: [...other.querySelectorAll('.compat-other__reason')].map((r) => r.textContent),
        chips: [...other.querySelectorAll('.compat-chip')].map((c) => `${c.querySelector('.compat-logo').textContent}:${c.dataset.client}`),
        notes: [...document.querySelectorAll('#compatWarnings .compat-card__note')].map((n) => n.textContent),
      };
    };

    await page.click('#generateButton');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success');
    const awg2 = await page.evaluate(card);
    assert.equal(awg2.hidden, false);
    assert.deepEqual(awg2.formats, ['.conf', 'vpn://']);
    assert.deepEqual(awg2.works.map((c) => c.client), ['amnezia_vpn', 'amneziawg_client']);
    assert.match(awg2.works[0].logo, /compat-logo--amnezia_vpn/, 'AmneziaVPN has its logo');
    assert.match(awg2.works[1].logo, /compat-logo--amneziawg_client/, 'AmneziaWG has its logo');
    assert.deepEqual(awg2.works[0].platforms, ['Windows', 'macOS', 'Linux', 'Android', 'iOS']);
    assert.deepEqual(awg2.works[0].formats, ['.conf', 'vpn://']);
    assert.deepEqual(awg2.works[0].notes, ['vpn:// — импорт в одно касание'], 'no AWG 3.1 note for AWG 2.0');
    assert.deepEqual(awg2.maybe.map((c) => [c.client, c.mono]), [['wg_tunnel', 'WT']], 'monogram without a logo');
    assert.match(awg2.maybe[0].notes[0], /^Зависит от версии клиента/);
    assert.equal(awg2.otherOpen, false, 'not directly supported starts collapsed');
    assert.equal(awg2.otherCount, '9');
    assert.deepEqual(awg2.reasons, ['Нет прямого экспорта', 'Только исследование']);
    assert.ok(awg2.chips.includes('SB:sing_box') && awg2.chips.includes('OC:openclash'), awg2.chips.join(' '));
    assert.equal(awg2.notes.length, 1, 'the client-version advice is not repeated below the tiles');
    assert.match(awg2.notes[0], /Cloudflare WARP peer/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal scroll');

    await page.click('#compatNotRecommended summary');
    assert.equal(await page.evaluate(() => document.getElementById('compatNotRecommended').open), true, 'expands on click');

    await page.click('label.profile-card:has(#profileAwg31)');
    await page.click('#generateButton');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success'
      && document.querySelectorAll('#compatRecommendedList .compat-app__note').length > 1);
    const awg31 = await page.evaluate(card);
    assert.ok(awg31.works.every((c) => c.notes.includes('Нужна версия клиента с поддержкой AWG 3.1')), 'AWG 3.x note on 3.x profiles');
    assert.equal(awg31.otherOpen, true, 'the expanded state survives a new result');
    await page.assertClean();
  });

  test('AWG 3.0: vpn:// is unavailable and the UI says why', async () => {
    const page = await openPage();
    await page.goto('/');
    stubWarp(page, () => ({ json: fixtures.warpSuccess({ mode: 'awg3' }) }), 300);
    await page.click('label.profile-card:has(#profileAwg3)');
    await page.click('#generateButton');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success');
    const state = await page.evaluate(() => ({
      tabDisabled: document.getElementById('resultTabLink').disabled,
      tabTitle: document.getElementById('resultTabLink').title,
      copyDisabled: document.getElementById('resultCopyLink').getAttribute('aria-disabled'),
      copyTitle: document.getElementById('resultCopyLink').title,
      warnTitle: document.getElementById('resultTitle').textContent.trim(),
    }));
    assert.equal(state.tabDisabled, true);
    assert.equal(state.copyDisabled, 'true');
    for (const title of [state.tabTitle, state.copyTitle]) assert.match(title, /vpn:\/\/ недоступна.*\.conf/);
    assert.match(state.warnTitle, /предупреждения/, 'the response warning is reflected in the title');
    await page.click('#resultCopyLink');
    const toast = await page.waitFor(() => { const t = document.getElementById('uiToast'); return t && !t.hidden && t.textContent; });
    assert.match(toast, /vpn:\/\/ недоступна/, 'clicking the disabled action explains itself');
    assert.deepEqual(await page.clipboard(), [], 'nothing copied');
    await page.assertClean();
  });

  test('error state, then recovery on retry', async () => {
    const page = await openPage();
    await page.goto('/');
    page.allowErrors(/Ошибка при генерации конфигурации/, /status of 502/);
    let fail = true;
    stubWarp(page, () => (fail
      ? { status: 502, json: fixtures.warpError('Cloudflare API временно недоступен (e2e).') }
      : { json: fixtures.warpSuccess() }), 600);

    await page.click('#generateButton');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'error', { message: 'error view' });
    const err = await page.evaluate(() => ({
      text: document.getElementById('resultErrorText').textContent,
      visible: !document.getElementById('resultError').hidden && document.getElementById('resultError').offsetHeight > 0,
      success: document.getElementById('resultSuccess').hidden,
      enabled: !document.getElementById('generateButton').disabled,
      history: document.getElementById('historyCount').textContent,
    }));
    assert.deepEqual(err, {
      text: 'Cloudflare API временно недоступен (e2e).',
      visible: true,
      success: true,
      enabled: true,
      history: '',
    });

    fail = false;
    await page.click('#generateButton');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success', { message: 'recovered' });
    assert.equal(await page.evaluate(() => document.getElementById('resultError').hidden), true);
    await page.assertClean();
  });

  test('RU → EN after generation keeps the result on screen', async () => {
    const page = await openPage();
    await page.goto('/');
    stubWarp(page, () => ({ json: fixtures.warpSuccess() }), 200);
    await page.click('#generateButton');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success');
    const panelTop = () => Math.round(document.getElementById('resultPanel').getBoundingClientRect().top);
    // Дождаться конца плавной прокрутки к результату
    let before = await page.evaluate(panelTop);
    for (let i = 0; i < 40; i += 1) {
      await page.sleep(150);
      const now = await page.evaluate(panelTop);
      if (now === before) break;
      before = now;
    }
    assert.ok(before >= 0 && before < 900, `result panel in view before the switch (top ${before})`);

    await page.click('.lang-btn[data-lang="en"]');
    await page.waitFor(() => location.pathname === '/en' && document.readyState === 'complete'
      && document.getElementById('resultPanel').dataset.view === 'success', { message: 'result restored on /en' });
    await page.waitForNetworkIdle();
    const state = await page.evaluate(() => ({
      title: document.getElementById('resultTitle').textContent.trim(),
      masks: document.querySelectorAll('#resultCode .c-mask').length,
      top: Math.round(document.getElementById('resultPanel').getBoundingClientRect().top),
    }));
    assert.match(state.title, /ready/i, 'English result title');
    assert.equal(state.masks, 1, 'key still masked after the language switch');
    assert.ok(Math.abs(state.top - before) <= 40, `result panel stays where it was: top ${before} → ${state.top}`);
    assert.equal(page.navigations.length, 2, 'one navigation: / → /en');
    await page.assertClean();
  });

  for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
    test(`layout stays put when the response arrives (${width}px)`, async (t) => {
      const page = await openPage({ width, height, mobile: width < 500 });
      await page.goto('/');
      page.allowErrors(/Ошибка при генерации конфигурации/, /status of 502/);
      let respond = () => ({ json: fixtures.warpSuccess() });
      // Ответ приходит позже окна hadRecentInput (500 мс): сдвиг от него засчитывается в CLS.
      stubWarp(page, (u) => respond(u), 1200);

      const runs = [['first result', null], ['repeat', null], ['error', () => ({ status: 502, json: fixtures.warpError() })], ['recovery', () => ({ json: fixtures.warpSuccess() })]];
      for (const [name, override] of runs) {
        if (override) respond = override;
        const since = await page.evaluate(() => performance.now());
        await page.click('#generateButton');
        await page.waitFor(() => document.getElementById('generateButton').disabled, { message: 'started' });
        await page.waitFor(() => !document.getElementById('generateButton').disabled, { timeout: 10_000, message: 'finished' });
        await page.sleep(600); // поздние сдвиги (картинки, шрифты, карточка совместимости)
        const { cls, counted, input } = await shiftsSince(page, since);
        t.diagnostic(`${width}px ${name}: CLS ${cls.toFixed(4)}; input-attributed ${input.map((s) => s.value.toFixed(3)).join(', ') || 'none'}`);
        assert.ok(cls <= 0.05, `${name} at ${width}px: layout shift ${cls.toFixed(4)} > 0.05 after the response: ${JSON.stringify(counted)}`);
        // Сдвиг, вызванный самим кликом (вставка панели), допустим, но ограничен
        const inputShift = input.reduce((sum, s) => sum + s.value, 0);
        assert.ok(inputShift <= 0.6, `${name} at ${width}px: click-caused shift ${inputShift.toFixed(3)} is out of bounds`);
      }
      await page.assertClean(`${width}px`);
    });
  }
});
