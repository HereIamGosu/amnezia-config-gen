const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildAwg2WarpConf } = require('./helpers/build-config');

describe('Invariant I5: AWG 2.0 [Interface] field order', () => {
  test('field positions are PrivateKey < Address < DNS < MTU < Jc < Jmin < Jmax < S1..S4 < H1..H4 < I1', () => {
    const conf = buildAwg2WarpConf();
    const interfaceBlock = conf.split(/\n\[Peer\]/)[0];
    assert.ok(interfaceBlock.startsWith('[Interface]'), '[Interface] must come first');

    const fields = [
      'PrivateKey',
      'Address',
      'DNS',
      'MTU',
      'Jc',
      'Jmin',
      'Jmax',
      'S1',
      'S2',
      'S3',
      'S4',
      'H1',
      'H2',
      'H3',
      'H4',
      'I1',
    ];

    let prev = -1;
    for (const f of fields) {
      const idx = interfaceBlock.indexOf(`\n${f} =`);
      assert.notEqual(idx, -1, `field "${f} = ..." must appear in [Interface]`);
      assert.ok(idx > prev, `field ${f} must come after the previous field (got ${idx}, prev ${prev})`);
      prev = idx;
    }
  });
});
