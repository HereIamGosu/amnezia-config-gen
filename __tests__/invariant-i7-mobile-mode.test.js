const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildLegacyConf, __internals } = require('./helpers/build-config');

describe('Invariant I7: mobile=1 overrides', () => {
  test('applyMobileModeOverrides sets Jc=3, Jmin=64, Jmax=128', () => {
    const obf = { Jc: 99, Jmin: 999, Jmax: 9999, S1: 0, S2: 0, S3: 0, S4: 0, H1: '1', H2: '2', H3: '3', H4: '4' };
    const out = __internals.applyMobileModeOverrides(obf);
    assert.equal(out.Jc, 3);
    assert.equal(out.Jmin, 64);
    assert.equal(out.Jmax, 128);
    assert.equal(out.S1, 0); // S/H untouched
  });

  test('Mobile constants are exactly Jc=3, Jmin=64, Jmax=128 (locked in code)', () => {
    assert.equal(__internals.MOBILE_JC, 3);
    assert.equal(__internals.MOBILE_JMIN, 64);
    assert.equal(__internals.MOBILE_JMAX, 128);
  });

  test('Legacy config with mobileJunk uses Jc=3, Jmin=64, Jmax=128 and IPv4-only Address', () => {
    const mobileJunk = {
      Jc: __internals.MOBILE_JC,
      Jmin: __internals.MOBILE_JMIN,
      Jmax: __internals.MOBILE_JMAX,
    };
    const conf = buildLegacyConf({ mobileJunk });
    assert.match(conf, /^Jc = 3$/m);
    assert.match(conf, /^Jmin = 64$/m);
    assert.match(conf, /^Jmax = 128$/m);

    const interfaceBlock = conf.split(/\n\[Peer\]/)[0];
    const addressLine = interfaceBlock.split('\n').find((l) => l.startsWith('Address ='));
    assert.ok(addressLine, 'Address line must exist');
    assert.doesNotMatch(addressLine, /:/, 'Mobile mode must strip IPv6 from Address (no colons)');
  });
});
