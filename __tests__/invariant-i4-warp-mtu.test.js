const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildAwg2WarpConf, __internals } = require('./helpers/build-config');

describe('Invariant I4: WARP AWG 2.0 forces MTU = 1280', () => {
  test('computeAwg2InterfaceMtu with stockWireGuardPeer:true ignores S4 and returns 1280', () => {
    for (const s4 of [0, 5, 16, 32]) {
      const mtu = __internals.computeAwg2InterfaceMtu(s4, { stockWireGuardPeer: true });
      assert.equal(mtu, 1280, `S4=${s4} must still yield MTU 1280 when stockWireGuardPeer=true`);
    }
    assert.equal(__internals.AWG2_MTU_STOCK_PEER, 1280);
  });

  test('rendered AWG 2.0 WARP config has MTU = 1280', () => {
    const conf = buildAwg2WarpConf();
    assert.match(conf, /^MTU = 1280$/m);
  });
});
