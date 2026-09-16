'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { __internals } = require('../api/warp');

const WARP_SAFE_OBFUSCATION = {
  Jc: 1,
  Jmin: 10,
  Jmax: 20,
  S1: 0,
  S2: 0,
  S3: 0,
  S4: 0,
  H1: '1',
  H2: '2',
  H3: '3',
  H4: '4',
};

const build = (mode, extras = {}) => __internals.buildFullConfig(
  mode,
  'PRIVATE',
  'PUBLIC',
  '172.16.0.2',
  'fd01::2',
  'engage.cloudflareclient.com:4500',
  WARP_SAFE_OBFUSCATION,
  ['0.0.0.0/0'],
  '1.1.1.1, 1.0.0.1',
  { persistentKeepalive: '25-35', ...extras },
);

test('AWG3 WARP profile preserves stock-WireGuard peer invariants', () => {
  const conf = build('awg3');

  for (const [field, value] of Object.entries({ S1: 0, S2: 0, S3: 0, S4: 0, H1: 1, H2: 2, H3: 3, H4: 4 })) {
    assert.match(conf, new RegExp(`^${field} = ${value}$`, 'm'));
  }
  for (const [field, value] of Object.entries(__internals.AWG3_DEFAULT_TIMINGS)) {
    const iniField = field[0].toUpperCase() + field.slice(1);
    assert.match(conf, new RegExp(`^${iniField} = ${value}$`, 'm'));
  }
  assert.match(conf, /^PersistentKeepalive = 25-35$/m);
  assert.match(conf, /^MTU = 1280$/m);
  assert.match(conf, /^ContentPaddingAddition = 10-100$/m);
  assert.doesNotMatch(conf, /^(HeaderProtectionKey|RandomTrailers|DisableCookies)\s*=/m);
});

test('AWG31 WARP profile enables local-only defaults and disables peer-dependent trailers', () => {
  const conf = build('awg31');

  assert.match(conf, /^ContentPaddingAddition = 10-100$/m);
  assert.match(conf, /^RandomTrailers = off$/m);
  assert.match(conf, /^DisableCookies = on$/m);
  assert.doesNotMatch(conf, /^HeaderProtectionKey\s*=/m);
  assert.doesNotMatch(conf, /^RandomTrailers = on$/m);
});

test('AWG3 content padding and AWG31 cookies can be disabled without weakening WARP invariants', () => {
  const awg3 = build('awg3', { contentPaddingAddition: null });
  const awg31 = build('awg31', { contentPaddingAddition: null, disableCookies: 'off' });

  assert.doesNotMatch(awg3, /^ContentPaddingAddition\s*=/m);
  assert.doesNotMatch(awg31, /^ContentPaddingAddition\s*=/m);
  assert.match(awg31, /^DisableCookies = off$/m);
  assert.match(awg31, /^RandomTrailers = off$/m);
  assert.doesNotMatch(awg31, /^HeaderProtectionKey\s*=/m);
});
