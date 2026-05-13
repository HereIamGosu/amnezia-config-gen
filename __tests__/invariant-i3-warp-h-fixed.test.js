const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildAwg2WarpConf, __internals } = require('./helpers/build-config');

describe('Invariant I3: WARP AWG 2.0 fixes H1..H4 = 1..4', () => {
  test('buildAwg2WarpSafeObfuscation returns H1..H4 = "1".."4"', () => {
    const obf = __internals.buildAwg2WarpSafeObfuscation();
    assert.equal(obf.H1, '1');
    assert.equal(obf.H2, '2');
    assert.equal(obf.H3, '3');
    assert.equal(obf.H4, '4');
  });

  test('rendered config has H1=1..H4=4 lines exactly', () => {
    const conf = buildAwg2WarpConf();
    assert.match(conf, /^H1 = 1$/m);
    assert.match(conf, /^H2 = 2$/m);
    assert.match(conf, /^H3 = 3$/m);
    assert.match(conf, /^H4 = 4$/m);
  });
});
