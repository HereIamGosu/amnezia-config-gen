const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildAwg2WarpConf, __internals } = require('./helpers/build-config');

describe('Invariant I2: WARP AWG 2.0 forces S1=S2=S3=S4=0', () => {
  test('buildAwg2WarpSafeObfuscation always returns S=0 (50 iterations)', () => {
    for (let i = 0; i < 50; i += 1) {
      const obf = __internals.buildAwg2WarpSafeObfuscation();
      assert.equal(obf.S1, 0, `iteration ${i}: S1 must be 0`);
      assert.equal(obf.S2, 0, `iteration ${i}: S2 must be 0`);
      assert.equal(obf.S3, 0, `iteration ${i}: S3 must be 0`);
      assert.equal(obf.S4, 0, `iteration ${i}: S4 must be 0`);
    }
  });

  test('rendered AWG 2.0 WARP config contains S1=0..S4=0 lines', () => {
    const conf = buildAwg2WarpConf();
    assert.match(conf, /^S1 = 0$/m);
    assert.match(conf, /^S2 = 0$/m);
    assert.match(conf, /^S3 = 0$/m);
    assert.match(conf, /^S4 = 0$/m);
  });
});
