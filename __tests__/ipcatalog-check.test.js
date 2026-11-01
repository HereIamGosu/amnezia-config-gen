// __tests__/ipcatalog-check.test.js
// The snapshot checks of spec 3.2.0 §4.4 on fixtures: a sound file passes, and each defect is named — schema and
// order, a preset missing or extra, no routes without a reason, bogon / private / multicast / too wide networks,
// more than 300 routes without "wide", a list that is not aggregated, transitional status out of step with
// routePresets.js. The committed snapshot is checked by ipcatalog-snapshot.test.js with the same module.

'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { checkSnapshot, MAX_ROUTES_WITHOUT_WIDE } = require('../src/server/ipCatalog/checkSnapshot');
const { rejectReason4, rejectReason6 } = require('../src/server/ipCatalog/addressFilters');

const PRESETS = {
  cloudflare: { ip: [{ from: 'official', list: 'cloudflare' }] },
  telegram: { ip: [{ from: 'official', list: 'telegram' }] },
  youtube: { legacy: {}, ip: [{ from: 'asn', asns: [15169] }] },
  wideok: { ip: [{ from: 'official', list: 'x', allowWide: true }] },
};
const set = (cidrs4, extra = {}) => ({ cidrs4, cidrs6: [], precision: 'exact', stale: null, noData: null, seen4: {}, seen6: {}, ...extra });
const DOC = {
  schema: 1,
  builtAt: '2026-11-05T10:00:00Z',
  sources: { a: {}, b: {} },
  presets: {
    cloudflare: set(['162.158.0.0/15', '188.114.96.0/20'], { cidrs6: ['2606:4700::/32'] }),
    telegram: set(['149.154.160.0/20', '91.108.4.0/22']),
    wideok: set(['17.0.0.0/8']),
    youtube: { legacy: true, liveRoutes4: 621, fallback: set(['142.250.0.0/15']) },
  },
};
const check = (doc, presets = PRESETS, retired = ['vk']) => checkSnapshot(JSON.stringify(doc), { presets, retired });
const withPreset = (key, record) => ({ ...DOC, presets: { ...DOC.presets, [key]: record } });
/** `n` unmergeable /32 (every other address of 11.0.0.0/16), in string order like a snapshot. */
const scattered = (n) => Array.from({ length: n }, (_, i) => `11.0.${Math.floor((2 * i) / 256)}.${(2 * i) % 256}/32`).sort();

describe('address filters', () => {
  test('IPv4: private, CGNAT, loopback, documentation, multicast, reserved are bogons; wider than /8 is wide', () => {
    for (const cidr of ['10.1.0.0/16', '100.64.1.0/24', '127.0.0.1/32', '192.168.1.0/24', '198.51.100.7/32', '224.0.0.1/32', '240.0.0.0/8', '255.255.255.255/32', '0.0.0.0/0']) {
      assert.equal(rejectReason4(cidr), 'bogon', cidr);
    }
    assert.equal(rejectReason4('8.0.0.0/7'), 'wide');
    assert.equal(rejectReason4('8.0.0.0/7', { allowWide: true }), null);
    assert.equal(rejectReason4('17.0.0.0/8'), null);
    assert.equal(rejectReason4('1.2.3.4'), 'malformed');
  });

  test('IPv6: only global unicast, without Teredo, documentation, 6to4; wider than /19 is wide', () => {
    for (const cidr of ['fc00::/7', 'fe80::1/128', 'ff02::1/128', '::1/128', '2001:db8::/32', '2002::/16', '2001::/32', '3fff::/24']) {
      assert.equal(rejectReason6(cidr), 'bogon', cidr);
    }
    assert.equal(rejectReason6('2606::/16'), 'wide');
    assert.equal(rejectReason6('2a06:98c0::/29'), null);
    assert.equal(rejectReason6('2606:4700::'), 'malformed');
  });
});

describe('checkSnapshot', () => {
  test('a sound snapshot passes', () => {
    assert.deepEqual(check(DOC), []);
  });

  test('an unusable file is one problem', () => {
    assert.deepEqual(checkSnapshot('{', { presets: PRESETS }), ['snapshot cannot be used: snapshot_invalid_json']);
  });

  test('order: preset keys, source keys, CIDRs, seen keys', () => {
    assert.match(check({ ...DOC, presets: { telegram: DOC.presets.telegram, ...DOC.presets } }).join('\n'), /preset keys are not sorted/);
    assert.match(check({ ...DOC, sources: { b: {}, a: {} } }).join('\n'), /source keys are not sorted/);
    assert.match(check(withPreset('telegram', set(['91.108.4.0/22', '149.154.160.0/20']))).join('\n'), /telegram\.cidrs4: not sorted/);
    assert.match(check(withPreset('telegram', set(['149.154.160.0/20'], { seen4: { b: 1, a: 1 } }))).join('\n'), /telegram\.seen4: keys not sorted/);
  });

  test('every preset that is not retired is in the snapshot, and nothing else', () => {
    const { telegram, ...rest } = DOC.presets;
    assert.ok(telegram);
    assert.deepEqual(check({ ...DOC, presets: rest }), ['telegram: missing from the snapshot']);
    const withVk = Object.fromEntries(Object.entries({ ...DOC.presets, vk: set(['5.0.0.0/16']) }).sort());
    assert.deepEqual(check({ ...DOC, presets: withVk }), ['vk: not a catalogue preset']);
  });

  test('no routes need a reason; a reason is enough', () => {
    assert.match(check(withPreset('telegram', set([]))).join('\n'), /telegram: no IPv4 routes and no noData reason/);
    assert.deepEqual(check(withPreset('telegram', set([], { noData: 'no_source' }))), []);
  });

  test('bogons and too wide networks are named; an official list may be allowed to be wide', () => {
    const problems = check(withPreset('cloudflare', set(['10.0.0.0/24', '8.0.0.0/7'], { cidrs6: ['fe80::/64'] }))).join('\n');
    assert.match(problems, /10\.0\.0\.0\/24 is bogon/);
    assert.match(problems, /8\.0\.0\.0\/7 is wide/);
    assert.match(problems, /fe80::\/64 is bogon/);
    assert.deepEqual(check(withPreset('wideok', set(['8.0.0.0/7']))), []);
  });

  test(`more than ${MAX_ROUTES_WITHOUT_WIDE} routes need precision "wide"`, () => {
    assert.deepEqual(check(withPreset('telegram', set(scattered(MAX_ROUTES_WITHOUT_WIDE), { precision: 'approx' }))), []);
    assert.match(check(withPreset('telegram', set(scattered(MAX_ROUTES_WITHOUT_WIDE + 1), { precision: 'approx' }))).join('\n'),
      /telegram: 301 routes without precision "wide"/);
    assert.deepEqual(check(withPreset('telegram', set(scattered(MAX_ROUTES_WITHOUT_WIDE + 1), { precision: 'wide' }))), []);
  });

  test('cidrs4 must already be aggregated', () => {
    assert.match(check(withPreset('telegram', set(['10.0.0.0/9', '10.128.0.0/9'].map((c) => c.replace('10.', '11.'))))).join('\n'),
      /telegram\.cidrs4: not aggregated/);
  });

  test('transitional in the snapshot exactly when routePresets.js says so; its reserve is checked too', () => {
    assert.match(check(withPreset('youtube', set(['142.250.0.0/15']))).join('\n'), /youtube: transitional in routePresets\.js, not in the snapshot/);
    assert.match(check(withPreset('telegram', { legacy: true, liveRoutes4: 5, fallback: set(['149.154.160.0/20']) })).join('\n'),
      /telegram: transitional in the snapshot, not in routePresets\.js/);
    assert.match(check(withPreset('youtube', { legacy: true, liveRoutes4: 1, fallback: set(['192.168.0.0/16']) })).join('\n'),
      /youtube\.fallback\.cidrs4: 192\.168\.0\.0\/16 is bogon/);
  });
});
