const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const {
  classifyGenerationError,
  durationMs,
  sanitizePayload,
  trackEvent,
} = require('../public/static/analytics');

describe('privacy-safe telemetry adapter', () => {
  test('sanitizer keeps only allowlisted, bounded product metadata', () => {
    const payload = sanitizePayload({
      mode: 'awg2',
      count_requested: 3,
      count_produced: 2,
      endpoint_mode: 'auto',
      endpoint_source: 'fallback',
      routes_source: 'itdoginfo',
      has_warning: true,
      warning_count: 1,
      route_mode: 'split',
      mobile_profile: true,
      router_profile: false,
      cps_mode: 'quic',
      duration_ms: 1234.6,
      error_code: 'http',
      content: '[Interface]\nPrivateKey = secret',
      PrivateKey: 'secret',
      PresharedKey: 'secret',
      warpToken: 'secret',
      endpoint: '203.0.113.10:4500',
      allowedIps: ['10.0.0.0/8'],
      customCidr: '192.0.2.0/24',
      message: 'sensitive upstream message',
      userAgent: 'full browser fingerprint',
    });

    assert.deepEqual(payload, {
      mode: 'awg2',
      endpoint_mode: 'auto',
      endpoint_source: 'fallback',
      routes_source: 'itdoginfo',
      route_mode: 'split',
      cps_mode: 'quic',
      error_code: 'http',
      count_requested: 3,
      count_produced: 2,
      warning_count: 1,
      duration_ms: 1235,
      has_warning: true,
      mobile_profile: true,
      router_profile: false,
    });
  });

  test('duration never becomes negative or non-finite', () => {
    assert.equal(durationMs(100, 250.4), 150);
    assert.equal(durationMs(250, 100), 0);
    assert.equal(durationMs(Number.NaN, 100), 0);
  });

  test('generation errors are classified without returning the original message', () => {
    const sensitive = new Error('PrivateKey = secret; endpoint=203.0.113.10:4500');
    assert.equal(classifyGenerationError({ name: 'AbortError', message: sensitive.message }), 'timeout');
    assert.equal(classifyGenerationError(sensitive, 502), 'http');
    assert.equal(classifyGenerationError(new TypeError(sensitive.message)), 'network');
    assert.equal(classifyGenerationError(new SyntaxError(sensitive.message)), 'invalid_response');
    assert.equal(classifyGenerationError(sensitive), 'unknown');
  });

  test('disabled analytics is a no-op', () => {
    assert.equal(trackEvent('generation_started', { mode: 'legacy' }), false);
    assert.equal(trackEvent('unregistered_event', { mode: 'legacy' }), false);
  });

  test('provider receives only the sanitized payload', () => {
    let call;
    global.ym = (...args) => { call = args; };
    try {
      assert.equal(trackEvent('generation_failed', {
        mode: 'legacy',
        error_code: 'network',
        message: 'PrivateKey = secret',
      }), true);
      assert.deepEqual(call, [
        99328227,
        'reachGoal',
        'generation_failed',
        { mode: 'legacy', error_code: 'network' },
      ]);
    } finally {
      delete global.ym;
    }
  });

  test('session replay is disabled because config previews contain secrets', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.match(html, /webvisor:\s*false/);
    assert.doesNotMatch(html, /webvisor:\s*true/);
  });
});
