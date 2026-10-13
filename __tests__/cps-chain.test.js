// __tests__/cps-chain.test.js — общий разбор CPS-цепочек (public/static/cps-chain.js): правила тегов, уровни
// совместимости, лимиты, канонический вид, разбор I1–I5 из .conf; сверка с независимым тестовым парсером и с
// тем, что генерирует сам сервер (импорт из истории не должен отвергать собственные конфиги).
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const CpsChain = require('../public/static/cps-chain');
const { parseCompatChain } = require('./helpers/cps-chain');
const { generateI2I5 } = require('../src/server/cpsExtraPackets');
const { generateCpsPayload } = require('../src/server/cpsGenerator');
const { CPS_PROTOCOLS } = require('../src/server/cps/protocols');

const codes = (text, compat) => CpsChain.parse(text, compat).errors.map((e) => e.code);

test('valid chains: bytes, segments and canonical form', () => {
  const p = CpsChain.parse('<b 0xC0FFEE><t><r 10><rd 3><rc 2>', 'modern');
  assert.equal(p.ok, true);
  assert.deepEqual(p.segments, [
    { tag: 'b', hex: 'c0ffee' }, { tag: 't' }, { tag: 'r', n: 10 }, { tag: 'rd', n: 3 }, { tag: 'rc', n: 2 },
  ]);
  assert.equal(p.bytes, 3 + 4 + 10 + 3 + 2);
  assert.equal(p.fixedBytes, 3);
  assert.equal(p.runtimeBytes, 19);
  assert.equal(p.needsModern, true);
  assert.equal(p.canonical, '<b 0xc0ffee><t><r 10><rd 3><rc 2>');
  // Пробелы вокруг и между тегами допустимы (master obf.go режет по Fields), в каноническом виде их нет
  assert.equal(CpsChain.parse('  < r   16 >\n<b 0x00>  ').canonical, '<r 16><b 0x00>');
});

test('compatibility: <rd>/<rc> only for modern clients', () => {
  assert.deepEqual(codes('<rd 5>', 'all'), ['modern_only']);
  assert.deepEqual(codes('<rc 5>', 'all'), ['modern_only']);
  assert.deepEqual(codes('<rd 5><rc 5>', 'modern'), []);
  assert.deepEqual(codes('<b 0x01><r 5><t>', 'all'), []);
  assert.deepEqual(codes('<rd 5>', 'unknown-level'), ['modern_only'], 'unknown level falls back to all');
});

test('errors: syntax, tags, parameters and limits', () => {
  const cases = [
    ['<b 0x01>junk', 'outside_text'],
    ['<r 10', 'unclosed'],
    ['<>', 'empty_tag'],
    ['<R 10>', 'tag_case'],
    ['<zz 1>', 'unknown_tag'],
    ['<d>', 'not_applicable'],
    ['<ds>', 'not_applicable'],
    ['<dz 2>', 'not_applicable'],
    ['<c>', 'not_applicable'],
    ['<wt 10>', 'not_applicable'],
    ['<b 0x1>', 'b_hex'],
    ['<b 01>', 'b_hex'],
    ['<b 0X01>', 'b_hex'],
    ['<b 0xzz>', 'b_hex'],
    ['<b>', 'b_hex'],
    ['<r 0>', 'n_range'],
    ['<r 1001>', 'n_range'],
    ['<r -1>', 'n_range'],
    ['<r 1.5>', 'n_range'],
    ['<r>', 'n_range'],
    ['<t 4>', 't_param'],
    ['<t><r 1><t>', 't_twice'],
    ['<r 1000><r 473>', 'too_large'],
    [`<b 0x${'00'.repeat(2100)}>`, 'too_long_text'],
  ];
  for (const [text, code] of cases) {
    assert.ok(codes(text, 'modern').includes(code), `${text.slice(0, 30)} → ${code} (got ${codes(text, 'modern')})`);
    assert.equal(CpsChain.parse(text, 'modern').ok, false);
  }
  assert.equal(CpsChain.parse('<r 1000><r 472>', 'modern').ok, true, '1472 bytes is the ceiling');
});

test('error texts exist for every code, in the module and in both dictionaries', () => {
  const ru = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public/locales/ru.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public/locales/en.json'), 'utf8'));
  for (const code of Object.keys(CpsChain.MESSAGES_RU)) {
    assert.equal(ru[`cps_err_${code}`], CpsChain.MESSAGES_RU[code], `ru cps_err_${code} equals the module text`);
    assert.ok(en[`cps_err_${code}`], `en cps_err_${code}`);
  }
  assert.equal(CpsChain.describeError({ code: 'unknown_tag', tag: 'zz' }), 'неизвестный тег: <zz>');
});

test('the shared parser agrees with the independent test parser on b/r/t chains', () => {
  // Общая область двух парсеров: есть runtime-тег (его требует помощник) и не больше 1472 байт (предел общего)
  const rnd = (n) => Math.floor(Math.random() * n);
  let rejected = 0;
  for (let i = 0; i < 3000; i += 1) {
    const parts = [`<r ${rnd(300)}>`];
    for (let k = 0; k < rnd(4); k += 1) {
      const kind = rnd(4);
      if (kind === 0) parts.push(`<b 0x${'ab'.repeat(1 + rnd(8))}>`);
      else if (kind === 1) parts.push(`<r ${1 + rnd(300)}>`);
      else if (kind === 2) parts.push('<t>');
      else parts.push(`<b 0x${'a'.repeat(1 + 2 * rnd(2))}>`);
    }
    const text = parts.join('');
    let helperOk = true;
    try { parseCompatChain(text); } catch { helperOk = false; }
    const parsed = CpsChain.parse(text, 'all');
    assert.equal(parsed.ok, helperOk, `${text}: shared ${JSON.stringify(parsed.errors)} vs helper ${helperOk}`);
    if (!helperOk) rejected += 1;
  }
  assert.ok(rejected > 100, `the generator also produces invalid chains (${rejected})`);
});

test('everything the server generates for I1–I5 passes the shared parser (history and import)', async () => {
  for (let i = 0; i < 200; i += 1) {
    for (const [field, value] of Object.entries(generateI2I5())) {
      const p = CpsChain.parse(value, 'all');
      assert.ok(p.ok, `${field} ${value}: ${JSON.stringify(p.errors)}`);
      assert.equal(p.canonical, value, `${field}: already canonical`);
    }
  }
  const checked = {};
  for (const protocol of Object.keys(CPS_PROTOCOLS).filter((id) => CPS_PROTOCOLS[id].status !== 'unsupported')) {
    for (let i = 0; i < 20; i += 1) {
      const generated = await generateCpsPayload(protocol);
      const p = CpsChain.parse(generated.value, 'all');
      assert.ok(p.ok, `${protocol}: ${JSON.stringify(p.errors)}`);
      checked[protocol] = (checked[protocol] || 0) + 1;
    }
  }
  assert.ok(Object.keys(checked).length >= 6, `every protocol checked: ${JSON.stringify(checked)}`);
});

test('findGap: I1–I5 must be consecutive for amneziawg-go before 0.2.16', () => {
  assert.equal(CpsChain.findGap({ I1: true, I2: true, I3: true }), null);
  assert.equal(CpsChain.findGap({ I1: true }), null);
  assert.deepEqual(CpsChain.findGap({ I1: true, I2: false, I3: true }), { field: 'I3', missing: 'I2' });
  assert.deepEqual(CpsChain.findGap({ I1: true, I2: true, I3: false, I4: false, I5: true }), { field: 'I5', missing: 'I4' });
  assert.match(CpsChain.describeGap({ field: 'I3', missing: 'I2' }), /до 0.2.16/);
  const ru = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public/locales/ru.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public/locales/en.json'), 'utf8'));
  for (const dict of [ru, en]) assert.match(dict.cps_err_gap, /{field}.*{missing}/);
});

test('extractFromConf takes I1–I5 from [Interface] only', () => {
  const conf = [
    '[Interface]', 'PrivateKey = x', 'I1 = <b 0x01>', 'I3 = <r 5>', 'I5=<t>',
    '', '[Peer]', 'I2 = <b 0x02>',
  ].join('\r\n');
  assert.deepEqual(CpsChain.extractFromConf(conf), { I1: '<b 0x01>', I3: '<r 5>', I5: '<t>' });
  assert.deepEqual(CpsChain.extractFromConf('I2 = <r 7>'), { I2: '<r 7>' }, 'bare lines without a section');
  assert.deepEqual(CpsChain.extractFromConf(''), {});
});
