const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { generateI2I5 } = require('../src/server/cpsExtraPackets');
const { buildAwg2WarpConf, buildLegacyConf } = require('./helpers/build-config');
const { parseCompatChain, chainShape } = require('./helpers/cps-chain');

const FIELDS = ['I2', 'I3', 'I4', 'I5'];

describe('Invariant I9: cps5 generates well-formed runtime I2..I5', () => {
  test('every field parses as a b/r/t chain within the v0.2.13 limits', () => {
    for (let i = 0; i < 300; i += 1) {
      const out = generateI2I5();
      assert.deepEqual(Object.keys(out), FIELDS);
      for (const k of FIELDS) {
        const { tags, fixedBytes, runtimeBytes } = parseCompatChain(out[k]);
        for (const t of tags) assert.ok(['b', 'r', 't'].includes(t.name) && (t.name !== 'r' || Number(t.param) <= 1000));
        const total = fixedBytes + runtimeBytes;
        assert.ok(total >= 32 && total <= 200, `${k}: ${total} bytes out of [32,200]`);
        assert.ok(runtimeBytes >= 4 * fixedBytes, `${k}: runtime part ${runtimeBytes} B vs fixed ${fixedBytes} B`);
      }
    }
  });

  test('no <rc>/<rd>/<c>/<wt>: v0.2.13 clients reject the whole config on an unknown tag', () => {
    for (let i = 0; i < 100; i += 1) {
      for (const v of Object.values(generateI2I5())) assert.doesNotMatch(v, /<(rc|rd|c|wt|d|ds|dz)\b/);
    }
  });

  test('I2..I5 have four different tag shapes, stable across calls', () => {
    const shapes = FIELDS.map((k) => chainShape(generateI2I5()[k]));
    assert.equal(new Set(shapes).size, 4, shapes.join(' | '));
    for (let i = 0; i < 50; i += 1) {
      const out = generateI2I5();
      assert.deepEqual(FIELDS.map((k) => chainShape(out[k])), shapes);
    }
  });

  test('AWG 2.0 WARP config with extraCps emits I1..I5 lines with the generated chains', () => {
    const extraCps = generateI2I5();
    const conf = buildAwg2WarpConf({ extraCps });
    assert.match(conf, /^I1 = /m);
    for (const k of FIELDS) {
      const line = conf.split('\n').find((l) => l.startsWith(`${k} = `));
      assert.equal(line, `${k} = ${extraCps[k]}`);
      parseCompatChain(line.slice(k.length + 3));
    }
  });

  test('Legacy config never emits I2..I5 even when extraCps is non-null (silent ignore)', () => {
    const conf = buildLegacyConf({ extraCps: generateI2I5() });
    assert.doesNotMatch(conf, /^I[2-5] = /m);
  });

  test('AWG 2.0 config with empty I1 never emits I2..I5', () => {
    const conf = buildAwg2WarpConf({ i1: '', extraCps: generateI2I5() });
    assert.doesNotMatch(conf, /^I1 = /m);
    assert.doesNotMatch(conf, /^I[2-5] = /m);
  });

  test('AWG 2.0 config without extraCps emits I1 only', () => {
    const conf = buildAwg2WarpConf();
    assert.match(conf, /^I1 = /m);
    assert.doesNotMatch(conf, /^I[2-5] = /m);
  });
});
