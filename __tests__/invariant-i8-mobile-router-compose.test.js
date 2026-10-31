const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { __internals } = require('./helpers/build-config');

describe('Invariant I8: mobile->router compose; router caps win on overlap', () => {
  test('applyRouterModeCaps clamps Jc to ROUTER_JC_MAX', () => {
    const obf = { Jc: 25, Jmin: 64, Jmax: 1024 };
    const out = __internals.applyRouterModeCaps(obf);
    assert.equal(out.Jc, __internals.ROUTER_JC_MAX);
    assert.ok(out.Jc <= 2);
  });

  test('mobile then router: Jc=3 (mobile) -> Jc=2 (router cap), Jmin/Jmax inside router bounds', () => {
    const baseObf = {
      Jc: 10, Jmin: 200, Jmax: 800,
      S1: 0, S2: 0, S3: 0, S4: 0,
      H1: '1', H2: '2', H3: '3', H4: '4',
    };
    const afterMobile = __internals.applyMobileModeOverrides(baseObf);
    assert.equal(afterMobile.Jc, 3);
    assert.equal(afterMobile.Jmin, 64);
    assert.equal(afterMobile.Jmax, 128);

    const afterRouter = __internals.applyRouterModeCaps(afterMobile);
    assert.equal(afterRouter.Jc, 2, 'router cap (max 2) wins over mobile (3)');
    // Router Jmin range is [40, 64]; mobile 64 is inside, so it stays at 64.
    assert.equal(afterRouter.Jmin, 64);
    // Router Jmax cap is 128; mobile 128 stays at 128.
    assert.equal(afterRouter.Jmax, 128);
  });

  test('router caps keep Jmax at least Jmin + 64 and never above 128', () => {
    for (const [jmin, jmax] of [[23, 911], [64, 128], [200, 900], [800, 1024], [40, 41], [100, 120]]) {
      const out = __internals.applyRouterModeCaps({ Jc: 10, Jmin: jmin, Jmax: jmax });
      assert.ok(out.Jmin >= __internals.ROUTER_JMIN_MIN && out.Jmin <= __internals.ROUTER_JMIN_MAX, `Jmin ${out.Jmin}`);
      assert.ok(out.Jmax <= __internals.ROUTER_JMAX_MAX && out.Jmax - out.Jmin >= 64, `${jmin}/${jmax} -> ${out.Jmin}/${out.Jmax}`);
    }
  });
});
