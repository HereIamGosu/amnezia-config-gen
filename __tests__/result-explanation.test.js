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

  test('keeps only safe AWG 3.x capability metadata for result explanation', () => {
    const summary = buildResultSummary({
      success: true,
      mode: 'awg31',
      content: 'base64',
      awg: {
        requestedVersion: '3.1',
        profile: 'warp-safe',
        enabledFeatures: ['junk-packets', 'timing-ranges', 'content-padding-addition', 'disable-cookies', 'PrivateKey = secret'],
        disabledFeatures: [
          { feature: 'header-protection', reason: 'requires-awg-peer' },
          { feature: 'random-trailers', reason: 'requires-awg31-peer' },
          { feature: 'Endpoint = secret', reason: 'unexpected' },
        ],
        capabilities: {
          contentPaddingAddition: {
            status: 'source-confirmed',
            effectiveState: 'active',
            effectiveValue: '10-100',
          },
          disableCookies: {
            status: 'source-confirmed',
            effectiveState: 'active',
            effectiveValue: 'on',
          },
          randomTrailers: {
            status: 'peer-dependent-disabled',
            effectiveState: 'blocked',
          },
          headerProtectionKey: {
            status: 'peer-dependent-disabled',
            effectiveState: 'blocked',
          },
          unsafeCapability: {
            status: 'verified',
            effectiveState: 'active',
            effectiveValue: 'PrivateKey = secret',
          },
        },
        experimentalFeatures: [],
        routerCompatibility: 'experimental/router-dependent',
        unexpected: 'PresharedKey = secret',
      },
    }, {});

    assert.deepEqual(summary.awg, {
      version: '3.1',
      profile: 'warp-safe',
      enabledFeatures: ['junk-packets', 'timing-ranges', 'content-padding-addition', 'disable-cookies'],
      disabledFeatures: ['header-protection', 'random-trailers'],
      experimentalFeatures: [],
      capabilities: {
        contentPaddingAddition: {
          status: 'source-confirmed',
          effectiveState: 'active',
          effectiveValue: '10-100',
        },
        disableCookies: {
          status: 'source-confirmed',
          effectiveState: 'active',
          effectiveValue: 'on',
        },
        randomTrailers: {
          status: 'peer-dependent-disabled',
          effectiveState: 'blocked',
        },
        headerProtectionKey: {
          status: 'peer-dependent-disabled',
          effectiveState: 'blocked',
        },
      },
      routerCompatibility: 'experimental/router-dependent',
    });
    assert.doesNotMatch(JSON.stringify(summary), /PrivateKey|PresharedKey|Endpoint = secret/);
  });

  test('keeps old AWG metadata responses compatible when capabilities are absent', () => {
    const summary = buildResultSummary({
      success: true,
      mode: 'awg3',
      content: 'base64',
      awg: {
        requestedVersion: '3.0',
        profile: 'warp-safe',
        enabledFeatures: ['content-padding-addition'],
        disabledFeatures: [{ feature: 'header-protection' }],
        experimentalFeatures: [],
      },
    }, {});

    assert.deepEqual(summary.awg.capabilities, {});
    assert.equal(summary.awg.version, '3.0');
  });
});

describe('Lab Auto (Phase D)', () => {
  const labResponse = (overrides = {}) => ({
    success: true,
    mode: 'awg2',
    count: 1,
    configs: [{ content: 'base64', endpointSource: 'lab' }],
    lab: { requested: 1, selected: 1, requestedPort: 4500, portMatched: true, ports: [4500] },
    ...overrides,
  });

  test('a Lab endpoint is reported as Lab Auto, never as manual or hostname', () => {
    const summary = buildResultSummary(labResponse(), { warpEndpoint: 'lab', port: 4500, configCount: 1 });
    assert.deepEqual(summary.endpoint, { mode: 'lab', source: 'lab' });
    assert.equal(summary.port, '4500');
    assert.deepEqual(summary.warnings, []);
  });

  test('a response without a Lab source for a Lab Auto request stays unverified', () => {
    const summary = buildResultSummary(labResponse({ configs: [{ content: 'base64', endpointSource: 'hostname' }] }),
      { warpEndpoint: 'lab', port: 4500 });
    assert.deepEqual(summary.endpoint, { mode: 'lab', source: 'unknown' });
  });

  test('the port actually used and the Lab warnings get stable codes', () => {
    const summary = buildResultSummary(labResponse({
      count: 1,
      lab: { requested: 3, selected: 1, requestedPort: 880, portMatched: false, ports: [2408] },
      warning: [
        'Endpoint Lab: not enough fresh verified endpoints on port 880; other verified ports were used (2408).',
        'Endpoint Lab: only 1 distinct fresh verified endpoint(s) for 3 requested configs.',
      ],
    }), { warpEndpoint: 'lab', port: 880, configCount: 3 });
    assert.equal(summary.port, '2408');
    assert.deepEqual(summary.warnings.map((w) => w.code), ['lab_port_fallback', 'lab_partial_diversity', 'partial_generation']);
  });

  test('hostname responses keep their meaning', () => {
    const summary = buildResultSummary({ success: true, mode: 'awg2', configs: [{ content: 'x', endpointSource: 'hostname' }] },
      { warpEndpoint: 'hostname', port: 4500 });
    assert.deepEqual(summary.endpoint, { mode: 'hostname', source: 'hostname' });
    assert.equal(summary.port, 4500);
  });
});
