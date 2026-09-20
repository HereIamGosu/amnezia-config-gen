'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  DNS_PRESETS,
  getDnsString,
  listDnsPresetsForApi,
} = require('../src/server/routePresets');

test('Xbox DNS preset contains the published IPv4 and IPv6 servers', () => {
  assert.equal(
    getDnsString('xbox_dns'),
    '111.88.96.50, 111.88.96.51, 2a00:ab00:1233:26::50, 2a00:ab00:1233:26::51',
  );
  assert.deepEqual(DNS_PRESETS.xbox_dns, {
    label: 'Xbox DNS',
    dns: '111.88.96.50, 111.88.96.51, 2a00:ab00:1233:26::50, 2a00:ab00:1233:26::51',
  });
});

test('Xbox DNS is exposed in the API DNS preset catalogue', () => {
  assert.deepEqual(
    listDnsPresetsForApi().find((preset) => preset.id === 'xbox_dns'),
    { id: 'xbox_dns', label: 'Xbox DNS' },
  );
});
