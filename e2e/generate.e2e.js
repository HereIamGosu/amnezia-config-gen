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

  for (const [pathname, expected] of [['/', /работает только по IPv4/], ['/en', /works over IPv4 only/]]) {
    test(`${pathname}: a registration without IPv6 shows the warning in the page language, not the server text`, async () => {
      const page = await openPage();
      await page.goto(pathname);
      const warning = 'WARP registration returned no IPv6 address for config(s) 1: the config is IPv4-only.';
      stubWarp(page, () => ({ json: { ...fixtures.warpSuccess(), warning } }), 200);
      await page.click('#generateButton');
      await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success');
      const risks = await page.evaluate(() => document.getElementById('resultRiskLabels').textContent);
      assert.match(risks, expected);
      assert.doesNotMatch(risks, /WARP registration returned/);
      await page.assertClean();
    });
  }

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

  // Считает загрузки через <a download>: их запускает downloadFile (common.js)
  const countDownloads = () => {
    window.__downloads = [];
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      if (this.download) window.__downloads.push(this.download);
      return original.call(this);
    };
  };
  const autoNote = () => {
    const el = document.getElementById('resultAutoNote');
    return { hidden: el.hidden, text: el.textContent.trim() };
  };

  test('iPhone: no auto-download, the note names the buttons, «Скачать .conf» still downloads', async () => {
    const page = await openPage({ width: 390, height: 844, mobile: true });
    await page.send('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
    });
    await page.goto('/');
    stubWarp(page, (u) => ({ json: fixtures.warpSuccess({ mode: u.searchParams.get('mode') }) }));
    await page.evaluate(countDownloads);

    await page.tap('#generateButton');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success', { message: 'success view' });
    assert.deepEqual(await page.evaluate(() => window.__downloads), [], 'no automatic download on iOS');
    const note = await page.evaluate(autoNote);
    assert.equal(note.hidden, false);
    assert.match(note.text, /«Скачать \.conf».*«Скопировать vpn:\/\/»/);

    await page.tap('#resultDownload');
    const downloads = await page.evaluate(() => window.__downloads);
    assert.equal(downloads.length, 1, 'the download button gives the file');
    assert.match(downloads[0], /\.conf$/);
    await page.assertClean('iPhone');
  });

  test('iPhone + AWG 3.0: the note names only «Скачать .conf», the vpn:// button stays disabled', async () => {
    const page = await openPage({ width: 390, height: 844, mobile: true });
    await page.send('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
    });
    await page.goto('/');
    stubWarp(page, () => ({ json: fixtures.warpSuccess({ mode: 'awg3' }) }));
    await page.evaluate(countDownloads);

    await page.tap('label.profile-card:has(#profileAwg3)');
    await page.tap('#generateButton');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success', { message: 'success view' });
    assert.deepEqual(await page.evaluate(() => window.__downloads), []);
    const note = await page.evaluate(autoNote);
    assert.equal(note.hidden, false);
    assert.match(note.text, /«Скачать \.conf»/);
    assert.doesNotMatch(note.text, /vpn:\/\//);
    assert.equal(await page.evaluate(() => document.getElementById('resultCopyLink').getAttribute('aria-disabled')), 'true');
    await page.assertClean('iPhone AWG 3.0');
  });

  test('desktop: one automatic download and the note with the file name', async () => {
    const page = await openPage();
    await page.goto('/');
    stubWarp(page, (u) => ({ json: fixtures.warpSuccess({ mode: u.searchParams.get('mode') }) }));
    await page.evaluate(countDownloads);

    await page.click('#generateButton');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success', { message: 'success view' });
    const downloads = await page.evaluate(() => window.__downloads);
    assert.equal(downloads.length, 1, 'auto-download stays on desktop');
    const note = await page.evaluate(autoNote);
    assert.equal(note.hidden, false);
    assert.ok(note.text.includes(downloads[0]), 'the note names the downloaded file');
    await page.assertClean('desktop');
  });

  // ── «Подключилось?» (ACT-2) и «Поделиться» (REF-1), result-feedback.js ──

  const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

  /** Состояние блока: стадия, видимая ячейка, панели ответа. */
  const connectState = () => {
    const box = document.getElementById('connectCheck');
    const visibleSlot = [...box.querySelectorAll('[data-slot]')]
      .filter((el) => getComputedStyle(el).visibility === 'visible')
      .map((el) => el.dataset.slot);
    return {
      stage: box.dataset.stage,
      slots: visibleSlot,
      share: !document.getElementById('connectSharePanel').hidden,
      steps: !document.getElementById('connectStepsPanel').hidden,
    };
  };

  /** Цели, ушедшие в очередь ym (на localhost tag.js не грузится, очередь остаётся в window.ym.a). */
  const goals = () => Array.from((window.ym && window.ym.a) || [], (args) => Array.from(args))
    .filter((args) => args[1] === 'reachGoal')
    .map((args) => ({ name: args[2], params: args[3] }));

  /** Вкладка уходит в фон и возвращается (человек открыл клиент VPN и вернулся). */
  const leaveAndReturn = () => {
    const flip = (state) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    flip('hidden');
    flip('visible');
  };

  /** Ссылки на t.me не открываем: внешний переход из теста недопустим, клик и события — настоящие. */
  const blockTelegramNavigation = () => {
    document.addEventListener('click', (ev) => {
      const link = ev.target.closest && ev.target.closest('a[href^="https://t.me/"]');
      if (link) {
        ev.preventDefault();
        window.__telegramHref = link.href;
      }
    });
  };

  test('desktop: no question right after the auto-download; asked on return to the tab; «Да» → share without the config', async () => {
    const page = await openPage({ width: 1280, height: 900 });
    await page.goto('/');
    stubWarp(page, (u) => ({ json: fixtures.warpSuccess({ mode: u.searchParams.get('mode') }) }), 200);
    await page.evaluate(blockTelegramNavigation);

    await page.click('#generateButton');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success');
    await page.sleep(300);
    assert.deepEqual(await page.evaluate(connectState), { stage: 'idle', slots: ['next'], share: false, steps: false },
      'not asked right after the generation, the «Дальше» hint stays');

    // Вопрос появляется без клика: проверяем, что ячейка не сдвигает раскладку
    const since = await page.evaluate(() => performance.now());
    await page.evaluate(leaveAndReturn);
    await page.waitFor(() => document.getElementById('connectCheck').dataset.stage === 'ask', { message: 'asked on return' });
    await page.sleep(300);
    const { cls, counted } = await shiftsSince(page, since);
    assert.ok(cls < 0.001, `the question appears without a layout shift: ${cls} ${JSON.stringify(counted)}`);
    assert.deepEqual((await page.evaluate(connectState)).slots, ['ask']);
    assert.equal(await page.evaluate(() => document.getElementById('connectAskTitle').textContent.trim()), 'Подключилось?');

    await page.click('#connectYes');
    await page.waitFor(() => !document.getElementById('connectSharePanel').hidden, { message: 'share panel' });
    assert.deepEqual(await page.evaluate(connectState), { stage: 'yes', slots: ['yes'], share: true, steps: false });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'connectShareTitle', 'focus moves to the new block');
    assert.equal(await page.evaluate(() => document.getElementById('shareNative').hidden), true, 'no native share on a desktop pointer');

    const href = await page.evaluate(() => document.getElementById('shareTelegram').href);
    const tg = new URL(href);
    assert.equal(tg.origin + tg.pathname, 'https://t.me/share/url');
    assert.equal(tg.searchParams.get('url'), 'https://awgconfig.com/?utm_source=share&utm_medium=telegram');
    const fixture = fixtures.warpSuccess();
    for (const secret of ['vpn://', 'PrivateKey', fixtures.FAKE_PRIVATE_KEY, fixture.vpnLink.slice(6, 40)]) {
      assert.ok(!decodeURIComponent(href).includes(secret), `the Telegram link does not carry ${secret.slice(0, 12)}`);
    }

    await page.click('#shareTelegram');
    assert.equal(await page.waitFor(() => window.__telegramHref), href, 'the click goes to t.me/share');
    await page.click('#shareCopy');
    const copied = await page.waitFor(() => window.__e2e.clipboard.slice(-1)[0]);
    assert.equal(copied, 'https://awgconfig.com/?utm_source=share&utm_medium=copy');

    // Повторный ответ невозможен: кнопки скрыты, а программный клик отсекается
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('connectNo')).visibility), 'hidden');
    await page.evaluate(() => document.getElementById('connectNo').click());
    assert.equal((await page.evaluate(connectState)).stage, 'yes');

    const sent = await page.evaluate(goals);
    const works = sent.filter((g) => g.name === 'connection_works');
    assert.equal(works.length, 1, 'one answer event');
    assert.deepEqual(Object.keys(works[0].params).sort(), [
      'cps_mode', 'cps_requested', 'cps_resolved', 'cps_stability', 'endpoint_mode', 'endpoint_source', 'mobile_profile',
      'mode', 'router_profile',
    ]);
    assert.equal(works[0].params.mode, 'awg2');
    assert.equal(sent.filter((g) => g.name === 'connection_fails').length, 0);
    assert.deepEqual(sent.filter((g) => g.name === 'share_clicked').map((g) => g.params),
      [{ share_channel: 'telegram' }, { share_channel: 'copy' }]);

    // Новая генерация — новый вопрос
    await page.click('#generateButton');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success'
      && document.getElementById('connectCheck').dataset.stage === 'idle', { message: 'reset for a new result' });
    assert.deepEqual(await page.evaluate(connectState), { stage: 'idle', slots: ['next'], share: false, steps: false });
    await page.assertClean('connection yes');
  });

  test('«Нет»: steps only set a parameter, no /api/warp request; FAQ q5 and Telegram', async () => {
    const page = await openPage({ width: 1280, height: 900 });
    await page.goto('/');
    const requests = stubWarp(page, (u) => ({ json: fixtures.warpSuccess({ mode: u.searchParams.get('mode') }) }), 200);
    await page.evaluate(blockTelegramNavigation);
    // Конфиг через Lab Auto: шаг endpoint предложит hostname
    await page.evaluate(() => {
      const select = document.getElementById('warpEndpointSelect');
      select.value = 'lab';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await page.click('#generateButton');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].searchParams.get('endpointMode'), 'lab');

    await page.click('#resultCopyLink');
    await page.waitFor(() => document.getElementById('connectCheck').dataset.stage === 'ask', { message: 'asked after the vpn:// copy' });
    await page.click('#connectNo');
    await page.waitFor(() => !document.getElementById('connectStepsPanel').hidden, { message: 'steps panel' });
    assert.deepEqual(await page.evaluate(connectState), { stage: 'no', slots: ['no'], share: false, steps: true });

    const steps = () => [...document.querySelectorAll('#connectStepsPanel .connect-step')]
      .filter((li) => !li.hidden)
      .map((li) => ({ id: li.id, title: li.querySelector('.connect-step__title').textContent.trim(), button: li.querySelector('.btn').textContent.trim() }));
    assert.deepEqual(await page.evaluate(steps), [
      { id: 'connectStepEndpoint', title: 'Другой endpoint: Hostname', button: 'Выбрать Hostname' },
      { id: 'connectStepProfile', title: 'Другой профиль: AWG 1.5', button: 'Выбрать AWG 1.5' },
      { id: 'connectStepFaq', title: 'Порт, мобильный профиль, DNS и маршруты', button: 'Открыть ответ' },
      { id: 'connectStepTelegram', title: 'Спросить в Telegram-канале', button: 'Открыть Telegram' },
    ]);

    await page.click('#connectStepEndpointBtn');
    await page.waitFor(() => document.getElementById('chipEndpoint').textContent.trim() === 'Hostname', { message: 'endpoint set' });
    assert.equal(await page.evaluate(() => document.getElementById('warpEndpointSelect').value), 'hostname');
    await page.waitFor(() => document.activeElement && document.activeElement.id === 'generateButton', { message: 'focus on generate' });
    assert.equal(await page.evaluate(() => document.getElementById('connectStepEndpointBtn').disabled), true);

    await page.click('#connectStepProfileBtn');
    await page.waitFor(() => document.querySelector('[name="awgProfile"]:checked').value === 'legacy', { message: 'profile set' });
    assert.equal(await page.evaluate(() => localStorage.getItem('awg_profile')), 'legacy', 'remembered like a card click');

    await page.click('#connectStepFaqBtn');
    await page.waitFor(() => document.getElementById('faqModal').getAttribute('aria-hidden') === 'false', { message: 'FAQ open' });
    assert.equal(await page.evaluate(() => document.querySelector('#faqModal [data-i18n="faq_q5"]').closest('details').open), true, 'q5 expanded');
    await page.press('Escape');
    await page.waitFor(() => document.getElementById('faqModal').getAttribute('aria-hidden') === 'true');

    await page.click('#connectStepTelegramBtn');
    assert.equal(await page.waitFor(() => window.__telegramHref), 'https://t.me/amnezia_config');

    await page.sleep(500);
    assert.equal(requests.length, 1, 'no generation started by the steps');
    assert.equal(page.apiCalls.filter((c) => c.url.includes('/api/warp')).length, 1);
    assert.equal((await page.evaluate(() => document.getElementById('resultPanel').dataset.view)), 'success');

    const sent = await page.evaluate(goals);
    const fails = sent.filter((g) => g.name === 'connection_fails');
    assert.equal(fails.length, 1);
    assert.equal(fails[0].params.endpoint_mode, 'lab');
    assert.deepEqual(sent.filter((g) => g.name === 'connection_next_step').map((g) => g.params.next_step),
      ['endpoint', 'profile', 'faq', 'telegram']);
    assert.equal(sent.filter((g) => g.name === 'telegram_channel_cta_click').length, 1, 'the channel goal counts too');
    await page.assertClean('connection no');
  });

  test('closing without an answer: no event, and the same result is not asked again', async () => {
    const page = await openPage();
    await page.goto('/');
    stubWarp(page, () => ({ json: fixtures.warpSuccess() }), 200);
    await page.click('#generateButton');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success');
    await page.click('#resultMoreBtn');
    await page.click('[data-result-action="preview"]');
    await page.waitFor(() => document.getElementById('connectCheck').dataset.stage === 'ask', { message: 'asked after the preview' });
    await page.press('Escape');
    await page.click('#connectClose');
    assert.deepEqual(await page.evaluate(connectState), { stage: 'closed', slots: ['next'], share: false, steps: false });
    await page.click('#resultDownload');
    await page.evaluate(leaveAndReturn);
    await page.sleep(200);
    assert.equal((await page.evaluate(connectState)).stage, 'closed', 'not asked again for this result');
    const names = (await page.evaluate(goals)).map((g) => g.name);
    assert.ok(!names.some((n) => n.startsWith('connection_')), names.join(' '));
    await page.assertClean('connection closed');
  });

  test('RU → EN after «Нет»: the answer survives, texts are English, no second event', async () => {
    const page = await openPage();
    await page.goto('/');
    stubWarp(page, () => ({ json: fixtures.warpSuccess() }), 200);
    await page.click('#generateButton');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success');
    await page.click('#resultDownload');
    await page.waitFor(() => document.getElementById('connectCheck').dataset.stage === 'ask');
    await page.click('#connectNo');
    await page.waitFor(() => !document.getElementById('connectStepsPanel').hidden);

    await page.click('.lang-btn[data-lang="en"]');
    await page.waitFor(() => location.pathname === '/en' && document.readyState === 'complete'
      && document.getElementById('resultPanel').dataset.view === 'success', { message: 'result restored on /en' });
    await page.waitForNetworkIdle();
    await page.waitFor(() => document.getElementById('connectStepsTitle').textContent.trim() === 'What to try', { message: 'English steps' });
    const state = await page.evaluate(() => ({
      stage: document.getElementById('connectCheck').dataset.stage,
      done: document.querySelector('[data-slot="no"]').textContent.trim(),
      profile: document.getElementById('connectStepProfileBtn').textContent.trim(),
      profileText: document.getElementById('connectStepProfileText').textContent.trim(),
      steps: !document.getElementById('connectStepsPanel').hidden,
    }));
    assert.equal(state.stage, 'no');
    assert.equal(state.steps, true);
    assert.match(state.done, /did not connect/);
    assert.equal(state.profile, 'Choose AWG 1.5');
    assert.match(state.profileText, /AWG 2\.0 parameters/);
    const names = (await page.evaluate(goals)).map((g) => g.name);
    assert.ok(!names.some((n) => n.startsWith('connection_')), `no answer event on /en: ${names.join(' ')}`);
    await page.assertClean('RU → EN');
  });

  test('without result-feedback.js (blocked or failed) the result still shows and the actions work', async () => {
    const page = await openPage();
    page.route((u) => u.pathname === '/static/result-feedback.js', () => ({ status: 404, body: 'blocked (e2e)' }));
    page.allowErrors(/result-feedback\.js|status of 404/);
    await page.goto('/');
    stubWarp(page, () => ({ json: fixtures.warpSuccess() }), 200);
    await page.click('#generateButton');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success', { message: 'success view without the module' });
    await page.click('#resultDownload');
    await page.click('#resultCopyLink');
    assert.equal((await page.clipboard()).length, 1, 'vpn:// copied');
    assert.equal(await page.evaluate(() => document.getElementById('connectCheck').dataset.stage), 'idle', 'no question, no error');
    await page.assertClean('no feedback module');
  });

  test('iPhone: the result stays, the question follows «Скачать .conf», «Да» offers the native share with utm', async () => {
    const page = await openPage({ width: 390, height: 844, mobile: true });
    await page.send('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA, platform: 'iPhone' });
    await page.goto('/en');
    stubWarp(page, (u) => ({ json: fixtures.warpSuccess({ mode: u.searchParams.get('mode') }) }));
    await page.evaluate(() => {
      window.__shared = [];
      navigator.share = (data) => { window.__shared.push(data); return Promise.resolve(); };
    });

    await page.tap('#generateButton');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success');
    assert.equal((await page.evaluate(connectState)).stage, 'idle');
    await page.tap('#resultDownload');
    await page.waitFor(() => document.getElementById('connectCheck').dataset.stage === 'ask', { message: 'asked after the download tap' });
    assert.equal(await page.evaluate(() => document.getElementById('connectAskTitle').textContent.trim()), 'Did it connect?');
    await page.tap('#connectYes');
    await page.waitFor(() => !document.getElementById('connectSharePanel').hidden);
    assert.equal(await page.evaluate(() => document.getElementById('shareNative').hidden), false, 'native share on a phone');
    await page.tap('#shareNative');
    const shared = await page.waitFor(() => window.__shared[0]);
    assert.equal(shared.url, 'https://awgconfig.com/en?utm_source=share&utm_medium=native');
    assert.ok(!JSON.stringify(shared).includes('vpn://'), 'nothing of the config is shared');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal scroll');
    const sent = await page.evaluate(goals);
    assert.deepEqual(sent.filter((g) => g.name === 'share_clicked').map((g) => g.params), [{ share_channel: 'native' }]);
    await page.assertClean('iPhone share');
  });
});
