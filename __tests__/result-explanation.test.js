const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  buildResultSummary,
  normalizeWarnings,
} = require('../public/static/result-explanation');

const FAKE_CONFIG = `[Interface]
PrivateKey = TEST_PRIVATE_KEY_SHOULD_NOT_LEAK
Address = 172.16.0.2/32
DNS = 1.1.1.1
MTU = 1280

[Peer]
PublicKey = TEST_PUBLIC_KEY
Endpoint = engage.cloudflareclient.com:2408
AllowedIPs = 0.0.0.0/0`;

describe('normalizeWarnings', () => {
  test('handles undefined and null', () => {
    assert.deepEqual(normalizeWarnings(undefined), []);
    assert.deepEqual(normalizeWarnings(null), []);
  });

  test('normalizes strings and arrays', () => {
    assert.deepEqual(normalizeWarnings('text'), [{
      level: 'warning',
      message: 'text',
      source: 'api',
    }]);
    assert.deepEqual(
      normalizeWarnings(['a', 'b']).map(({ message }) => message),
      ['a', 'b'],
    );
  });

  test('preserves messages and normalizes levels', () => {
    assert.deepEqual(normalizeWarnings({
      message: 'blocked',
      level: 'blocking',
      code: 'invalid_endpoint',
      source: 'validation',
    }), [{
      level: 'blocking',
      message: 'blocked',
      code: 'invalid_endpoint',
      source: 'validation',
    }]);
    assert.equal(normalizeWarnings({ message: 'unknown', level: 'urgent' })[0].level, 'warning');
  });
});

describe('buildResultSummary', () => {
  test('adds a partial-generation warning and uses actual config count', () => {
    const summary = buildResultSummary({
      success: true,
      mode: 'awg2',
      configs: [{ content: 'one' }, { content: 'two' }],
    }, {
      configCount: 3,
      warpEndpoint: 'hostname',
      port: 2408,
      routePresets: [],
      mobileMode: false,
      routerMode: false,
      includeIpv6: false,
      vpnLinkRequested: true,
    });

    assert.equal(summary.variants, 2);
    assert.ok(summary.warnings.some(({ code }) => code === 'partial_generation'));
  });

  test('does not copy config contents or secrets into the summary model', () => {
    const summary = buildResultSummary({
      success: true,
      mode: 'legacy',
      content: Buffer.from(FAKE_CONFIG).toString('base64'),
      warning: { message: 'Check the selected port.', level: 'info' },
    }, {
      configCount: 1,
      warpEndpoint: 'hostname',
      port: 2408,
      routePresets: [],
      mobileMode: true,
      routerMode: false,
      includeIpv6: true,
      vpnLinkRequested: true,
    });
    const serialized = JSON.stringify(summary);

    assert.equal(summary.ipv6, 'disabledByMobile');
    assert.doesNotMatch(serialized, /TEST_PRIVATE_KEY_SHOULD_NOT_LEAK/);
    assert.doesNotMatch(serialized, /PrivateKey|PresharedKey|WARP token|AllowedIPs/);
    assert.doesNotMatch(serialized, /\[Interface\]|\[Peer\]/);
  });

  test('handles partial response metadata without undefined display values', () => {
    const summary = buildResultSummary({ success: true, content: 'base64' }, {
      configCount: 1,
      routePresets: ['youtube'],
      mobileMode: false,
      routerMode: true,
      includeIpv6: false,
      vpnLinkRequested: true,
    });

    assert.equal(summary.variants, 1);
    assert.equal(summary.endpoint.source, 'unknown');
    assert.equal(summary.routesSource, 'unknown');
    assert.ok(summary.warnings.some(({ level }) => level === 'info'));
  });
});
