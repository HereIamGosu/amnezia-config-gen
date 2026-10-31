// __tests__/cps-custom-chains.test.js — свои CPS-цепочки i1..i5 в /api/warp: query и тело POST, проверка тем же
// разбором, что и в редакторе, уровни совместимости, замена авто-шаблонов по полям, I9 (без I1 нет I2–I5),
// Legacy без I2–I5, ошибки 400 без содержимого цепочки и без утечки в лог.
'use strict';

const assert = require('node:assert/strict');
const { describe, test, mock } = require('node:test');
const { generate } = require('./helpers/warp-harness');
const { parseCompatChain } = require('./helpers/cps-chain');

const iLines = (conf) => Object.fromEntries(conf.split('\n')
  .map((l) => /^(I[1-5]) = (.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));

const quiet = () => mock.method(console, 'error', () => {});

describe('custom CPS chains in /api/warp', () => {
  test('i1..i5 in the query land in the config in canonical form', async () => {
    const r = await generate({ mode: 'awg2', i1: '<b 0xC0FFEE><r 16>', i2: '  <r 10> <b 0xAB> ', i3: '<t><r 8>' });
    assert.equal(r.status, 200);
    const fields = iLines(r.configs[0]);
    assert.equal(fields.I1, '<b 0xc0ffee><r 16>');
    assert.equal(fields.I2, '<r 10><b 0xab>');
    assert.equal(fields.I3, '<t><r 8>');
    assert.equal(fields.I4, undefined, 'without cps5 a field without a chain is not emitted');
    assert.equal(fields.I5, undefined);
    assert.equal(r.body.cpsRequested, 'custom');
    assert.deepEqual(r.body.appliedExtras.customCps, ['I1', 'I2', 'I3'], 'own fields are reported');
  });

  test('POST body works the same and takes precedence over the query', async () => {
    const r = await generate({ mode: 'awg3', i2: '<r 99>' }, {
      method: 'POST',
      body: { mode: 'awg3', i2: '<r 12><t>', i3: '<rc 6>', cpsCompat: 'modern' },
    });
    assert.equal(r.status, 200);
    const fields = iLines(r.configs[0]);
    assert.equal(fields.I2, '<r 12><t>');
    assert.equal(fields.I3, '<rc 6>');
  });

  test('cps5 + own chains: own fields replace the template, the rest stay automatic', async () => {
    const r = await generate({ mode: 'awg2', cps5: '1', i3: '<r 33>' });
    const fields = iLines(r.configs[0]);
    assert.equal(fields.I3, '<r 33>');
    for (const f of ['I2', 'I4', 'I5']) {
      assert.ok(fields[f], `${f} from the template`);
      assert.doesNotThrow(() => parseCompatChain(fields[f]), f);
    }
    assert.equal(r.body.appliedExtras.cps5, true);
    // I1 by protocol keeps its evidence status; only the own I3 is reported as custom
    assert.deepEqual(r.body.appliedExtras.customCps, ['I3']);
    assert.notEqual(r.body.cpsStability, 'custom');
  });

  test('compatibility: default modern accepts <rd>/<rc>, all rejects them with 400 and the field', async () => {
    const ok = await generate({ mode: 'awg2', i2: '<rd 5>' });
    assert.equal(ok.status, 200);
    assert.equal(iLines(ok.configs[0]).I2, '<rd 5>');

    const errSpy = quiet();
    try {
      const bad = await generate({ mode: 'awg2', i2: '<rd 5>', cpsCompat: 'all' });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error, 'cps_chain_invalid');
      assert.equal(bad.body.field, 'I2');
      assert.match(bad.body.message, /^Поле I2: теги <rd> и <rc>/);
      assert.equal(bad.apiCalls, 0, 'rejected before any WARP registration');

      const level = await generate({ mode: 'awg2', cpsCompat: 'newest' });
      assert.equal(level.status, 400);
      assert.equal(level.body.error, 'cps_compat_invalid');
    } finally {
      errSpy.mock.restore();
    }
  });

  test('invalid chains: 400 with the field, the chain itself is not echoed or logged', async () => {
    const secretish = 'deadbeefcafebabe';
    const cases = [
      ['i1', `<b 0x${secretish}`],
      ['i2', `<b 0x${secretish}><t><t>`],
      ['i3', `text <b 0x${secretish}>`],
      ['i4', '<d>'],
      ['i5', `<r 2000><b 0x${secretish}>`],
    ];
    for (const [key, value] of cases) {
      const logged = [];
      const errSpy = mock.method(console, 'error', (...args) => logged.push(args.map(String).join(' ')));
      try {
        const r = await generate({ mode: 'awg2', [key]: value });
        assert.equal(r.status, 400, key);
        assert.equal(r.body.field, key.toUpperCase());
        assert.ok(!JSON.stringify(r.body).includes(secretish), `${key}: response does not echo the chain`);
        assert.ok(!logged.some((l) => l.includes(secretish)), `${key}: log does not contain the chain`);
      } finally {
        errSpy.mock.restore();
      }
    }
  });

  test('a gap in I1–I5 is rejected before registration (amneziawg-go before 0.2.16 rejects it)', async () => {
    const errSpy = quiet();
    try {
      for (const [query, field] of [
        [{ mode: 'awg2', i3: '<r 5>' }, 'I3'],
        [{ mode: 'awg3', i2: '<r 1>', i4: '<r 2>' }, 'I4'],
        [{ mode: 'awg31', i2: '<r 1>', i3: '<r 1>', i5: '<r 2>' }, 'I5'],
      ]) {
        const r = await generate(query);
        assert.equal(r.status, 400, JSON.stringify(query));
        assert.equal(r.body.error, 'cps_chain_gap');
        assert.equal(r.body.field, field);
        assert.equal(r.apiCalls, 0, 'no WARP registration');
      }
    } finally {
      errSpy.mock.restore();
    }
    // cps5 fills the gaps with template packets; Legacy has no I2–I5 at all
    assert.equal((await generate({ mode: 'awg2', cps5: '1', i4: '<r 5>' })).status, 200);
    assert.equal((await generate({ mode: 'legacy', i3: '<r 5>' })).status, 200);
  });

  test('I9: Legacy never emits I2–I5; I1 from a custom chain still applies there', async () => {
    const r = await generate({ mode: 'legacy', i1: '<b 0x0102><r 8>', i2: '<r 10>', cps5: '1' });
    assert.equal(r.status, 200);
    const fields = iLines(r.configs[0]);
    assert.equal(fields.I1, '<b 0x0102><r 8>');
    assert.deepEqual(Object.keys(fields), ['I1']);
    assert.deepEqual(r.body.appliedExtras.customCps, ['I1'], 'Legacy drops own I2, reports only I1');
  });

  test('without own chains the output is unchanged: same keys and order as before the editor', async () => {
    const plain = await generate({ mode: 'awg2', cps5: '1' });
    assert.deepEqual(plain.body.appliedExtras.customCps, []);
    const fields = iLines(plain.configs[0]);
    assert.deepEqual(Object.keys(fields), ['I1', 'I2', 'I3', 'I4', 'I5']);
  });
});
