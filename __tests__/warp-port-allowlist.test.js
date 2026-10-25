// __tests__/warp-port-allowlist.test.js
// H3: `warpPort` goes through the same allowlist as `port` (PRD FR-42, NFR-08). A port outside PORT_ALLOWLIST is
// refused with the same 400 body as an unlisted `port`, before any WARP registration; allowed ports behave as before.

'use strict';

const assert = require('node:assert/strict');
const { test, describe } = require('node:test');
const { generate, endpointOf } = require('./helpers/warp-harness');

const ALLOWED = [2408, 500, 4500, 1701, 880, 8854];

const assertRefused = (r, raw) => {
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.success, false);
  assert.equal(r.body.error, `Port ${raw} is not allowed. Use one of: ${ALLOWED.join(', ')}`);
  assert.deepEqual(r.body.allowedPorts, ALLOWED);
  assert.equal(r.apiCalls, 0, 'a refused port must not register a WARP device');
};

describe('warpPort allowlist', () => {
  for (const port of ALLOWED) {
    test(`allowed warpPort=${port} sets the Endpoint port`, async () => {
      const r = await generate({ mode: 'awg2', warpPort: String(port) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(endpointOf(r.configs[0]), `engage.cloudflareclient.com:${port}`);
    });
  }

  test('no port keeps the default 4500; empty warpPort is "not given"', async () => {
    for (const query of [{ mode: 'awg2' }, { mode: 'awg2', warpPort: '' }]) {
      const r = await generate(query);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(endpointOf(r.configs[0]), 'engage.cloudflareclient.com:4500');
    }
  });

  test('unlisted warpPort with an allowed port is refused (bypass reproduction)', async () => {
    assertRefused(await generate({ mode: 'awg2', port: '4500', warpPort: '12345' }), '12345');
  });

  test('unlisted warpPort without port is refused', async () => {
    assertRefused(await generate({ mode: 'awg2', warpPort: '12345' }), '12345');
  });

  test('allowed warpPort with unlisted port is refused by the port check', async () => {
    assertRefused(await generate({ mode: 'awg2', port: '9999', warpPort: '2408' }), '9999');
  });

  test('port and warpPort both allowed but different: warpPort wins, as before', async () => {
    const r = await generate({ mode: 'awg2', port: '4500', warpPort: '500' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(endpointOf(r.configs[0]), 'engage.cloudflareclient.com:500');
  });

  test('both unlisted and different: refused', async () => {
    assertRefused(await generate({ mode: 'awg2', port: '9999', warpPort: '12345' }), '9999');
  });

  for (const raw of ['0', '65535', '65536', '-1', 'abc', '4500.5x', '1e3']) {
    test(`boundary/non-numeric warpPort=${raw} is refused or equals an allowed port`, async () => {
      const r = await generate({ mode: 'awg2', warpPort: raw });
      // parseInt semantics are shared with `port`: "4500.5x" reads as 4500 there too.
      if (raw === '4500.5x') {
        assert.equal(r.status, 200);
        assert.equal(endpointOf(r.configs[0]), 'engage.cloudflareclient.com:4500');
      } else {
        assertRefused(r, raw);
      }
    });
  }

  test('POST body warpPort is checked the same way', async () => {
    assertRefused(await generate({ mode: 'awg2' }, { method: 'POST', body: { warpPort: 12345 } }), '12345');
    assertRefused(await generate({ mode: 'awg2' }, { method: 'POST', body: { warpPort: 0 } }), '0');
    const ok = await generate({ mode: 'awg2' }, { method: 'POST', body: { warpPort: 1701 } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(endpointOf(ok.configs[0]), 'engage.cloudflareclient.com:1701');
  });

  test('refusal happens before Lab Auto selection and before registration', async () => {
    const r = await generate({ mode: 'awg2', endpointMode: 'lab', warpPort: '12345' });
    assertRefused(r, '12345');
  });
});
