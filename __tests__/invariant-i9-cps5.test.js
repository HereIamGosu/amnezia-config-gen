const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { generateI2I5, generateExtraCpsPacket } = require('../api/cpsExtraPackets');
const { buildAwg2WarpConf, buildLegacyConf } = require('./helpers/build-config');

const HEX_RE = /^<b 0x([0-9a-f]+)>$/;

describe('Invariant I9: cps5 generates well-formed I2..I5', () => {
  test('generateExtraCpsPacket returns <b 0xHEX> with 16..64 bytes (32..128 hex chars)', () => {
    for (let i = 0; i < 100; i += 1) {
      const pkt = generateExtraCpsPacket();
      const m = HEX_RE.exec(pkt);
      assert.ok(m, `iteration ${i}: malformed packet ${pkt}`);
      const hexLen = m[1].length;
      assert.ok(hexLen >= 32 && hexLen <= 128, `iteration ${i}: hex length ${hexLen} out of [32,128]`);
      assert.equal(hexLen % 2, 0, 'hex length must be even');
    }
  });

  test('generateI2I5 returns object with I2..I5 keys, each well-formed', () => {
    const out = generateI2I5();
    for (const k of ['I2', 'I3', 'I4', 'I5']) {
      assert.ok(HEX_RE.test(out[k]), `${k} malformed: ${out[k]}`);
    }
  });

  test('AWG 2.0 WARP config with extraCps emits I1..I5 lines', () => {
    const extraCps = generateI2I5();
    const conf = buildAwg2WarpConf({ extraCps });
    assert.match(conf, /^I1 = /m);
    assert.match(conf, /^I2 = <b 0x[0-9a-f]+>$/m);
    assert.match(conf, /^I3 = <b 0x[0-9a-f]+>$/m);
    assert.match(conf, /^I4 = <b 0x[0-9a-f]+>$/m);
    assert.match(conf, /^I5 = <b 0x[0-9a-f]+>$/m);
  });

  test('Legacy config never emits I2..I5 even when extraCps is non-null (silent ignore)', () => {
    const extraCps = generateI2I5();
    const conf = buildLegacyConf({ extraCps });
    assert.doesNotMatch(conf, /^I2 = /m);
    assert.doesNotMatch(conf, /^I3 = /m);
    assert.doesNotMatch(conf, /^I4 = /m);
    assert.doesNotMatch(conf, /^I5 = /m);
  });
});
