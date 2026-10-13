// e2e/cps-editor.e2e.js — пакеты перед handshake (I1–I5) во вкладке «Дополнительно»: готовые варианты в один
// клик, ручной редактор с защитой от ошибок (пропуски заполняются сами, ввод не даёт сломать цепочку, вопросы
// перед заменой), генерация POST-запросом со своими цепочками (без них — прежний GET), ссылка на настройки,
// импорт из .conf и из истории, заметка для Legacy, раскладка на телефоне.
'use strict';

// Функции в page.evaluate исполняются в странице: cfgState и setCpsChains — глобальные имена её скриптов.
/* global cfgState, setCpsChains */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { e2eSuite, fixtures } = require('./lib/harness');

const settingsOpen = () => document.getElementById('settingsModal').classList.contains('is-open');
const confirmOpen = () => document.getElementById('cpsConfirmModal').classList.contains('is-open');
const field = (name) => `[data-cps-field="${name}"]`;

const openExtra = async (page) => {
  // После генерации страница плавно прокручивается к результату: кликаем, когда сводка перестала двигаться
  await page.waitFor(() => new Promise((resolve) => {
    const el = document.getElementById('paramSummary');
    const before = el.getBoundingClientRect().top;
    setTimeout(() => resolve(Math.abs(el.getBoundingClientRect().top - before) < 0.5), 150);
  }), { message: 'step-2 summary is not moving' });
  await page.click('#paramSummary');
  await page.waitFor(settingsOpen);
  await page.click('#tab-extra');
};

const closeSettings = (page) => page.click('#settingsModal [data-close-modal].btn');

const choosePreset = (page, value) => page.click(`.cps-preset:has(input[value="${value}"])`);

/** Заглушка /api/warp, которая запоминает метод, query и тело запроса. */
const stubWarp = (page) => {
  const requests = [];
  page.route((u) => u.pathname === '/api/warp', (u, request) => {
    requests.push({ method: request.method, query: u.searchParams, body: request.postData ? JSON.parse(request.postData) : null });
    return { json: fixtures.warpSuccess() };
  });
  return requests;
};

const generate = async (page) => {
  await page.click('#generateButton');
  await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success'
    && document.getElementById('generateButton').disabled === false);
};

const chains = (page) => page.evaluate(() => ({ ...cfgState.cpsChains }));

const fieldState = (page, name) => page.evaluate((sel) => {
  const card = document.querySelector(sel);
  return {
    status: card.querySelector('.cps-field__status').textContent.trim(),
    custom: card.querySelector('input.switch').checked,
    errors: Array.from(card.querySelectorAll('.cps-field__error')).map((e) => e.textContent.trim()),
    warnings: Array.from(card.querySelectorAll('.cps-field__warning')).map((e) => e.textContent.trim()),
    invalid: card.classList.contains('cps-field--invalid'),
  };
}, field(name));

const typeInto = (page, selector, value, { blur = false } = {}) => page.evaluate((sel, v, b) => {
  const input = document.querySelector(sel);
  input.focus();
  input.value = v;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  if (b) input.blur();
}, selector, value, blur);

e2eSuite('CPS packets: presets and the guarded editor', (openPage) => {
  test('presets in one click: Standard (GET), Enhanced (cps5), More randomness (own I2–I5 with rd/rc)', async () => {
    const page = await openPage();
    const requests = stubWarp(page);
    await page.goto('/');
    await openExtra(page);
    assert.equal(await page.evaluate(() => document.querySelector('[name="cpsPreset"]:checked').value), 'standard');
    assert.equal(await page.evaluate(() => document.getElementById('cpsManual').hidden), true, 'editor hidden outside manual');
    await closeSettings(page);

    await generate(page);
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].query.has('cps5'), false);

    await openExtra(page);
    await choosePreset(page, 'enhanced');
    await closeSettings(page);
    await generate(page);
    assert.equal(requests[1].method, 'GET');
    assert.equal(requests[1].query.get('cps5'), '1');
    assert.match(await page.evaluate(() => document.getElementById('paramSummaryState').textContent), /I2–I5/);

    await openExtra(page);
    await choosePreset(page, 'random');
    const first = await chains(page);
    assert.equal(first.I1, '', 'I1 stays with the CPS protocol');
    for (const f of ['I2', 'I3', 'I4', 'I5']) assert.ok(first[f], `${f} filled`);
    assert.ok(Object.values(first).some((c) => /<r[dc] /.test(c)), 'digits/letters used');
    await page.click('#cpsPresetReroll');
    assert.notDeepEqual(await chains(page), first, 'shuffle gives new chains');
    await closeSettings(page);
    await generate(page);
    const sent = requests[2];
    assert.equal(sent.method, 'POST');
    assert.equal(sent.body.cpsCompat, 'modern');
    assert.deepEqual(Object.keys(sent.body).sort(), ['cpsCompat', 'i2', 'i3', 'i4', 'i5']);
    assert.equal(sent.query.has('cps5'), false);
    assert.equal(sent.query.get('mode'), 'awg2', 'other parameters stay in the query');
    assert.ok(!['i1', 'i2', 'i3', 'i4', 'i5'].some((k) => sent.query.has(k)), 'chains are not in the address');

    // Своих цепочек нет в «Стандарте»: переход на него спрашивает, «Отмена» оставляет вариант и цепочки
    await openExtra(page);
    const kept = await chains(page);
    await choosePreset(page, 'standard');
    await page.waitFor(confirmOpen);
    await page.click('#cpsConfirmModal .modal__footer [data-close-modal]');
    assert.equal(await page.evaluate(() => document.querySelector('[name="cpsPreset"]:checked').value), 'random');
    assert.deepEqual(await chains(page), kept);
    await choosePreset(page, 'standard');
    await page.waitFor(confirmOpen);
    await page.click('#cpsConfirmOk');
    assert.deepEqual(await chains(page), { I1: '', I2: '', I3: '', I4: '', I5: '' });
    await page.assertClean();
  });

  test('manual: gaps fill themselves, turning a field off asks first, input cannot break the chain', async () => {
    const page = await openPage();
    await page.goto('/');
    await openExtra(page);
    await choosePreset(page, 'manual');
    assert.equal(await page.evaluate(() => document.getElementById('cpsManual').hidden), false);

    // Своя I3 без I2: I2 заполняется сама, ошибки пропуска нет
    await page.click(`${field('I3')} .cps-field__switch`);
    const c = await chains(page);
    assert.ok(c.I2 && c.I3, JSON.stringify(c));
    assert.equal((await fieldState(page, 'I3')).invalid, false);

    // Выключение I2 при своей I3 — вопрос; «Отмена» ничего не меняет, «Выключить все» снимает обе
    await page.click(`${field('I2')} .cps-field__switch`);
    await page.waitFor(confirmOpen);
    await page.click('#cpsConfirmModal .modal__footer [data-close-modal]');
    await page.waitFor(() => !document.getElementById('cpsConfirmModal').classList.contains('is-open'));
    assert.ok((await chains(page)).I2, 'cancel keeps I2');
    assert.equal((await fieldState(page, 'I2')).custom, true);
    await page.click(`${field('I2')} .cps-field__switch`);
    await page.waitFor(confirmOpen);
    await page.click('#cpsConfirmOk');
    assert.deepEqual(await chains(page), { I1: '', I2: '', I3: '', I4: '', I5: '' });

    // hex: только hex-цифры, нечётная длина при выходе получает ведущий ноль
    await page.click(`${field('I2')} .cps-field__switch`);
    await page.click(`${field('I2')} .cps-palette__btn[data-tag="b"]`);
    const hexSel = `${field('I2')} .cps-block:last-child .cps-block__input--hex`;
    await typeInto(page, hexSel, 'zzABc', { blur: true });
    assert.equal(await page.evaluate((s) => document.querySelector(s).value, hexSel), '0abc');
    assert.match((await chains(page)).I2, /<b 0x0abc>$/);

    // Длина: 5000 подтягивается к пределу при выходе
    await page.click(`${field('I2')} .cps-palette__btn[data-tag="r"]`);
    const nSel = `${field('I2')} .cps-block:last-child .cps-block__input--n`;
    await typeInto(page, nSel, '5000', { blur: true });
    const n = Number(await page.evaluate((s) => document.querySelector(s).value, nSel));
    assert.ok(n >= 1 && n <= 1000, `clamped length ${n}`);
    assert.equal((await fieldState(page, 'I2')).errors.length, 0);

    // Два блока по 1000: второй упирается в свободное место, пакет не больше 1472 байт
    await page.evaluate((sel) => document.querySelectorAll(`${sel} .cps-field__views .route-mode-btn`)[1].click(), field('I2'));
    await typeInto(page, `${field('I2')} .cps-field__text`, '<r 32><r 32>');
    await page.evaluate((sel) => document.querySelectorAll(`${sel} .cps-field__views .route-mode-btn`)[0].click(), field('I2'));
    await typeInto(page, `${field('I2')} .cps-block:nth-child(1) .cps-block__input--n`, '1000', { blur: true });
    await typeInto(page, `${field('I2')} .cps-block:nth-child(2) .cps-block__input--n`, '1000', { blur: true });
    const two = await page.evaluate((sel) => Array.from(document.querySelectorAll(`${sel} .cps-block__input--n`)).map((i) => Number(i.value)), field('I2'));
    assert.deepEqual(two, [1000, 472], 'second block limited by the free space');
    assert.equal((await fieldState(page, 'I2')).errors.length, 0);

    // Пакет на пределе 1472 байт: блоки больше не добавить
    await page.evaluate((sel) => {
      const views = document.querySelectorAll(`${sel} .cps-field__views .route-mode-btn`);
      views[1].click();
    }, field('I2'));
    await typeInto(page, `${field('I2')} .cps-field__text`, '<r 1000><r 472>');
    await page.evaluate((sel) => document.querySelectorAll(`${sel} .cps-field__views .route-mode-btn`)[0].click(), field('I2'));
    const disabled = await page.evaluate((sel) => Array.from(document.querySelectorAll(`${sel} .cps-palette__btn`)).every((b) => b.disabled), field('I2'));
    assert.equal(disabled, true, 'palette disabled when the packet is full');

    // Своя I1: предупреждение, что она заменяет протокол
    await page.click(`${field('I1')} .cps-field__switch`);
    assert.match((await fieldState(page, 'I1')).warnings.join(' '), /заменяет протокол CPS/);
    await page.assertClean();
  });

  test('"All clients" with digits/letters asks and replaces them; cancel keeps "Newer clients"', async () => {
    const page = await openPage();
    await page.goto('/');
    await openExtra(page);
    await choosePreset(page, 'random');
    await choosePreset(page, 'manual');
    assert.equal(await page.evaluate(() => cfgState.cpsCompat), 'modern');

    await page.click('[data-cps-compat="all"]');
    await page.waitFor(confirmOpen);
    assert.match(await page.evaluate(() => document.getElementById('cpsConfirmText').textContent), /I2/);
    await page.click('#cpsConfirmModal .modal__footer [data-close-modal]');
    assert.equal(await page.evaluate(() => cfgState.cpsCompat), 'modern', 'cancel keeps newer clients');

    const lengths = (c) => Object.values(c).filter(Boolean).map((s) => (s.match(/<r[dc]? (\d+)>/g) || [])
      .reduce((sum, tag) => sum + Number(/\d+/.exec(tag)[0]), 0));
    const before = await chains(page);
    await page.click('[data-cps-compat="all"]');
    await page.waitFor(confirmOpen);
    await page.click('#cpsConfirmOk');
    const after = await chains(page);
    assert.equal(await page.evaluate(() => cfgState.cpsCompat), 'all');
    assert.ok(Object.values(after).every((s) => !/<r[dc] /.test(s)), JSON.stringify(after));
    assert.deepEqual(lengths(after), lengths(before), 'same lengths');
    for (const f of ['I2', 'I3', 'I4', 'I5']) assert.equal((await fieldState(page, f)).invalid, false, f);
    await page.assertClean();
  });

  test('settings link, .conf import and history: chains come back, replacing own chains asks first', async () => {
    const page = await openPage();
    stubWarp(page);
    await page.goto('/');
    await openExtra(page);
    await choosePreset(page, 'random');
    await page.click('#settingsShareLink');
    const copied = await page.waitFor(() => window.__e2e.clipboard[0], { message: 'settings link copied' });
    const url = new URL(copied);
    assert.equal(url.searchParams.get('compat'), 'modern');
    const linked = await chains(page);

    const other = await openPage();
    await other.goto(`/${url.search}`);
    assert.deepEqual(await chains(other), linked);
    assert.equal(await other.evaluate(() => cfgState.cpsPreset), 'manual');
    await other.assertClean('linked page');

    // Импорт поверх своих цепочек: сначала вопрос
    await choosePreset(page, 'manual');
    await page.evaluate(() => { document.querySelector('.cps-editor__import').open = true; });
    await page.evaluate(() => {
      document.getElementById('cpsImportText').value = '[Interface]\nI1 = <b 0x0a0b><r 16>\nI2 = <r 64>\n';
    });
    await page.click('#cpsImportBtn');
    await page.waitFor(confirmOpen);
    await page.click('#cpsConfirmOk');
    assert.deepEqual(await chains(page), { I1: '<b 0x0a0b><r 16>', I2: '<r 64>', I3: '', I4: '', I5: '' });

    // История: «Взять I1–I5 этого конфига» тоже спрашивает, если свои цепочки уже есть
    await closeSettings(page);
    await page.evaluate(() => setCpsChains({}));
    await generate(page);
    await page.evaluate(() => setCpsChains({ I1: '<r 8>' }));
    await page.click('#historyModalBtn');
    await page.waitFor(() => document.getElementById('historyModal').classList.contains('is-open'));
    await page.click('#historyList .history-item:first-child .history-item__use-chains');
    await page.waitFor(confirmOpen);
    await page.click('#cpsConfirmOk');
    assert.equal((await chains(page)).I1, '<b 0xc100000001088a1b2c3d4e5f6a7b00000044d0>');
    await page.assertClean();
  });

  test('an empty own chain stops generation with a clear reason; Legacy shows its note', async () => {
    const page = await openPage();
    const requests = stubWarp(page);
    await page.goto('/');
    await openExtra(page);
    await choosePreset(page, 'manual');
    await page.click(`${field('I2')} .cps-field__switch`);
    await page.evaluate((sel) => document.querySelectorAll(`${sel} .cps-field__views .route-mode-btn`)[1].click(), field('I2'));
    await typeInto(page, `${field('I2')} .cps-field__text`, '');
    assert.match((await fieldState(page, 'I2')).errors.join(' '), /цепочка пустая/);
    await closeSettings(page);
    await page.click('#generateButton');
    const status = await page.waitFor(() => {
      const el = document.getElementById('status');
      return !el.classList.contains('visually-hidden') && el.textContent;
    });
    assert.match(status, /I2: цепочка пустая/);
    assert.equal(requests.length, 0);

    // Неверная цепочка в текстовом виде тоже останавливает генерацию с понятной причиной
    await openExtra(page);
    await typeInto(page, `${field('I2')} .cps-field__text`, '<r 0>');
    await closeSettings(page);
    await page.click('#generateButton');
    const invalid = await page.waitFor(() => {
      const el = document.getElementById('status');
      return !el.classList.contains('visually-hidden') && /длина/.test(el.textContent) && el.textContent;
    });
    assert.match(invalid, /I2: длина должна быть целым числом от 1 до 1000/);
    assert.equal(requests.length, 0, 'no /api/warp request with an invalid chain');

    await page.click('label.profile-card:has(#profileLegacy)');
    await openExtra(page);
    assert.equal(await page.evaluate(() => document.getElementById('cpsLegacyNote').hidden), false);
    await page.assertClean();
  });

  test('phone: presets and the editor fit without horizontal scroll', async () => {
    const page = await openPage({ width: 390, height: 844, mobile: true });
    await page.goto('/');
    await page.tap('#paramSummary');
    await page.waitFor(settingsOpen);
    await page.tap('#tab-extra');
    await page.evaluate(() => document.querySelector('[name="cpsPreset"][value="random"]').click());
    await page.evaluate(() => document.querySelector('[name="cpsPreset"][value="manual"]').click());
    const sizes = await page.evaluate(() => {
      const body = document.querySelector('#settingsModal .modal__body');
      const right = Math.max(...Array.from(document.querySelectorAll('.cps-preset, .cps-field')).map((e) => e.getBoundingClientRect().right));
      return { scroll: body.scrollWidth, client: body.clientWidth, right, vw: window.innerWidth };
    });
    assert.ok(sizes.scroll <= sizes.client, JSON.stringify(sizes));
    assert.ok(sizes.right <= sizes.vw, JSON.stringify(sizes));
    await page.assertClean();
  });
});
