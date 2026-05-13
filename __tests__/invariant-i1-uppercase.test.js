const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildAwg2WarpConf, buildLegacyConf } = require('./helpers/build-config');

describe('Invariant I1: I1 field is uppercase', () => {
  test('AWG 2.0 WARP config has uppercase "I1 = " not "i1 = "', () => {
    const conf = buildAwg2WarpConf();
    assert.match(conf, /^I1 = /m, 'expected uppercase I1 = ... at start of a line');
    assert.doesNotMatch(conf, /^i1 = /m);
  });

  test('Legacy config has uppercase "I1 = " not "i1 = "', () => {
    const conf = buildLegacyConf();
    assert.match(conf, /^I1 = /m);
    assert.doesNotMatch(conf, /^i1 = /m);
  });
});
