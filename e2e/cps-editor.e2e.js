// e2e/cps-editor.e2e.js — редактор CPS-цепочек I1–I5 во вкладке «Дополнительно»: блоки и текст, совместимость,
// генерация POST-запросом со своими цепочками (без них — прежний GET), остановка на ошибке, ссылка на настройки,
// импорт из .conf и из истории, раскладка на телефоне.
'use strict';

// Функции в page.evaluate исполняются в странице: cfgState и setCpsChains — глобальные имена её скриптов.
/* global cfgState, setCpsChains */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { e2eSuite, fixtures } = require('./lib/harness');

const settingsOpen = () => document.getElementById('settingsModal').classList.contains('is-open');
const field = (name) => `[data-cps-field="${name}"]`;

const openExtra = async (page) => {
  await page.click('#paramSummary');
  await page.waitFor(settingsOpen);
  await page.click('#tab-extra');
};

/** Заглушка /api/warp, которая запоминает метод и тело запроса. */
const stubWarp = (page) => {
  const requests = [];
  page.route((u) => u.pathname === '/api/warp', (u, request) => {
    requests.push({ method: request.method, query: u.searchParams, body: request.postData ? JSON.parse(request.postData) : null });
    return { json: fixtures.warpSuccess() };
  });
  return requests;
};

const fieldState = (page, name) => page.evaluate((sel) => {
  const card = document.querySelector(sel);
  return {
    status: card.querySelector('.cps-field__status').textContent.trim(),
    custom: card.querySelector('input.switch').checked,
    blocks: Array.from(card.querySelectorAll('.cps-block')).map((b) => b.className.replace('cps-block cps-block--', '')),
    errors: Array.from(card.querySelectorAll('.cps-field__error')).map((e) => e.textContent.trim()),
    invalid: card.classList.contains('cps-field--invalid'),
  };
}, field(name));

const chain = (page, name) => page.evaluate((n) => cfgState.cpsChains[n], name);

e2eSuite('CPS chain editor', (openPage) => {
  test('auto by default; blocks, compatibility and errors for one field', async () => {
    const page = await openPage();
    await page.goto('/');
    await openExtra(page);

    for (const name of ['I1', 'I2', 'I3', 'I4', 'I5']) {
      const s = await fieldState(page, name);
      assert.equal(s.custom, false, `${name} auto`);
    }
    assert.equal((await fieldState(page, 'I1')).status, 'Авто: протокол CPS Auto');
    assert.equal((await fieldState(page, 'I2')).status, 'Не отправляется');

    // Своя цепочка I2: появляется пример из блоков, только b/r/t при «Все клиенты»
    await page.click(`${field('I2')} .cps-field__switch`);
    let s = await fieldState(page, 'I2');
    assert.equal(s.custom, true);
    assert.ok(s.blocks.length >= 2 && s.blocks.every((b) => ['b', 'r', 't'].includes(b)), JSON.stringify(s.blocks));
    assert.match(s.status, /^Своя · \d+ Б$/);
    assert.ok(await chain(page, 'I2'));
    const disabled = await page.evaluate((sel) => Array.from(document.querySelectorAll(`${sel} .cps-palette__btn`))
      .filter((b) => b.disabled).map((b) => b.textContent.trim()), field('I2'));
    assert.ok(disabled.includes('+ Случайные цифры') && disabled.includes('+ Случайные буквы'), JSON.stringify(disabled));

    // «Новые клиенты» открывает <rd>; возврат к «Все клиенты» даёт ошибку и кнопку исправления
    await page.click('[data-cps-compat="modern"]');
    await page.click(`${field('I2')} .cps-palette__btn:nth-child(3)`);
    s = await fieldState(page, 'I2');
    assert.equal(s.blocks[s.blocks.length - 1], 'rd');
    assert.match(await chain(page, 'I2'), /<rd 8>$/);
    await page.click('[data-cps-compat="all"]');
    s = await fieldState(page, 'I2');
    assert.equal(s.invalid, true);
    assert.match(s.errors[0], /<rd> и <rc>/);
    await page.click(`${field('I2')} .cps-field__fix`);
    assert.equal(await page.evaluate(() => cfgState.cpsCompat), 'modern');
    assert.equal((await fieldState(page, 'I2')).invalid, false);

    // Удаление блока и текстовый вид
    await page.click(`${field('I2')} .cps-block:last-child .cps-block__btn--remove`);
    assert.doesNotMatch(await chain(page, 'I2'), /<rd/);
    await page.click(`${field('I2')} .cps-field__views .route-mode-btn:nth-child(2)`);
    await page.evaluate((sel) => {
      const area = document.querySelector(`${sel} .cps-field__text`);
      area.value = '<b 0x1>';
      area.dispatchEvent(new Event('input', { bubbles: true }));
    }, field('I2'));
    s = await fieldState(page, 'I2');
    assert.equal(s.invalid, true);
    assert.match(s.errors.join(' '), /<b> ждёт байты/);

    // Сводка шага 2 называет свои цепочки
    assert.match(await page.evaluate(() => document.getElementById('paramSummaryState').textContent), /Свои цепочки I2/);
    await page.assertClean();
  });

  test('generation: POST with own chains, GET without them, no request while a chain is invalid', async () => {
    const page = await openPage();
    const requests = stubWarp(page);
    await page.goto('/');

    // Без своих цепочек — прежний GET без тела
    await page.click('#generateButton');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].body, null);

    // Своя I3 текстом
    await openExtra(page);
    await page.click(`${field('I3')} .cps-field__switch`);
    await page.click(`${field('I3')} .cps-field__views .route-mode-btn:nth-child(2)`);
    await page.evaluate((sel) => {
      const area = document.querySelector(`${sel} .cps-field__text`);
      area.value = ' <r 40> <b 0xAB> ';
      area.dispatchEvent(new Event('input', { bubbles: true }));
    }, field('I3'));
    // I3 без I2 и без «Усиленной маскировки» — пропуск: ошибка на поле и в строке статуса, запроса нет
    assert.match((await fieldState(page, 'I3')).errors.join(' '), /задано I3, а I2 — нет/);
    await page.click('#settingsModal [data-close-modal].btn');
    const beforeGap = requests.length;
    await page.click('#generateButton');
    const gapStatus = await page.waitFor(() => {
      const el = document.getElementById('status');
      return !el.classList.contains('visually-hidden') && el.textContent;
    });
    assert.match(gapStatus, /I3: задано I3, а I2 — нет/);
    assert.equal(requests.length, beforeGap, 'no /api/warp request with a gap');

    // Своя I2 закрывает пропуск
    await openExtra(page);
    await page.click(`${field('I2')} .cps-field__switch`);
    assert.deepEqual((await fieldState(page, 'I3')).errors, []);
    await page.click('#settingsModal [data-close-modal].btn');
    await page.click('#generateButton');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success' && document.getElementById('generateButton').disabled === false
      && document.getElementById('status').classList.contains('visually-hidden'));
    const sent = requests[requests.length - 1];
    assert.equal(sent.method, 'POST');
    assert.deepEqual(Object.keys(sent.body).sort(), ['cpsCompat', 'i2', 'i3']);
    assert.equal(sent.body.i3, '<r 40><b 0xab>');
    assert.equal(sent.body.cpsCompat, 'all');
    assert.equal(sent.query.get('mode'), 'awg2', 'other parameters stay in the query');
    assert.equal(sent.query.has('i3'), false, 'the chain is not in the address');

    // Ошибка в цепочке: запроса нет, причина в строке статуса
    await openExtra(page);
    await page.evaluate((sel) => {
      const area = document.querySelector(`${sel} .cps-field__text`);
      area.value = '<r 0>';
      area.dispatchEvent(new Event('input', { bubbles: true }));
    }, field('I3'));
    await page.click('#settingsModal [data-close-modal].btn');
    const before = requests.length;
    await page.click('#generateButton');
    const status = await page.waitFor(() => {
      const el = document.getElementById('status');
      return !el.classList.contains('visually-hidden') && el.textContent;
    });
    assert.match(status, /I3: длина должна быть целым числом от 1 до 1000/);
    assert.equal(requests.length, before, 'no /api/warp request');
    await page.assertClean();
  });

  test('settings link carries the chains; history and .conf import load them back', async () => {
    const page = await openPage();
    stubWarp(page);
    await page.goto('/');
    await openExtra(page);
    await page.click('[data-cps-compat="modern"]');
    await page.click(`${field('I4')} .cps-field__switch`);
    await page.click(`${field('I4')} .cps-field__views .route-mode-btn:nth-child(2)`);
    await page.evaluate((sel) => {
      const area = document.querySelector(`${sel} .cps-field__text`);
      area.value = '<t><rc 12><r 30>';
      area.dispatchEvent(new Event('input', { bubbles: true }));
    }, field('I4'));
    await page.click('#settingsShareLink');
    const copied = await page.waitFor(() => window.__e2e.clipboard[0], { message: 'settings link copied' });
    const url = new URL(copied);
    assert.equal(url.searchParams.get('i4'), '<t><rc 12><r 30>');
    assert.equal(url.searchParams.get('compat'), 'modern');

    // Новая страница по ссылке восстанавливает цепочку и совместимость
    const other = await openPage();
    await other.goto(`/${url.search}`);
    assert.equal(await chain(other, 'I4'), '<t><rc 12><r 30>');
    assert.equal(await other.evaluate(() => cfgState.cpsCompat), 'modern');
    assert.match(await other.evaluate(() => document.getElementById('paramSummaryState').textContent), /Свои цепочки I4/);
    await other.assertClean('linked page');

    // Импорт строк I1–I5 из текста .conf
    await page.evaluate(() => { document.querySelector('.cps-editor__import').open = true; });
    await page.evaluate(() => {
      const area = document.getElementById('cpsImportText');
      area.value = '[Interface]\nPrivateKey = x\nI1 = <b 0x0a0b><r 16>\nI5 = <r 64>\n[Peer]\nI2 = <r 1>';
    });
    await page.click('#cpsImportBtn');
    assert.deepEqual(await page.evaluate(() => ({ ...cfgState.cpsChains })), {
      I1: '<b 0x0a0b><r 16>', I2: '', I3: '', I4: '', I5: '<r 64>',
    });

    // История: генерация, затем «Взять I1–I5 этого конфига» из записи
    await page.click('#settingsModal [data-close-modal].btn');
    await page.evaluate(() => setCpsChains({}));
    await page.click('#generateButton');
    await page.waitFor(() => document.getElementById('resultPanel').dataset.view === 'success');
    await page.click('#historyModalBtn');
    await page.waitFor(() => document.getElementById('historyModal').classList.contains('is-open'));
    await page.click('#historyList .history-item:first-child .history-item__use-chains');
    const i1 = await chain(page, 'I1');
    assert.match(i1, /^<b 0xc100000001088a1b2c3d4e5f6a7b00000044d0>$/);
    await page.assertClean();
  });

  test('phone: the editor fits the screen without horizontal scroll', async () => {
    const page = await openPage({ width: 390, height: 844, mobile: true });
    await page.goto('/');
    await page.tap('#paramSummary');
    await page.waitFor(settingsOpen);
    await page.tap('#tab-extra');
    await page.evaluate(() => document.querySelector('[data-cps-field="I2"] input.switch').click());
    await page.evaluate(() => document.querySelector('[data-cps-compat="modern"]').click());
    const sizes = await page.evaluate(() => {
      const body = document.querySelector('#settingsModal .modal__body');
      const card = document.querySelector('[data-cps-field="I2"]').getBoundingClientRect();
      return { scroll: body.scrollWidth, client: body.clientWidth, cardRight: card.right, vw: window.innerWidth };
    });
    assert.ok(sizes.scroll <= sizes.client, JSON.stringify(sizes));
    assert.ok(sizes.cardRight <= sizes.vw, JSON.stringify(sizes));
    await page.assertClean();
  });
});
