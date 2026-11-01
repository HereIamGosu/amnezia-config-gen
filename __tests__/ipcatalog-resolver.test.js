// __tests__/ipcatalog-resolver.test.js
// The preset address catalogue on a fixture snapshot (3.2.0, spec 3.2.0 §4.3, §4.5, §5.1): strict lazy loading,
// the plan (aliases, retired, unknown, no data) without network, the resolution (catalogue ∪ transitional presets each
// on its own call, the snapshot reserve, the WARP endpoint cut, the cut of a covered manual endpoint) and the prices.

'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { parseSnapshot, createSnapshotLoader, priceOf } = require('../src/server/ipCatalog/snapshot');
const { createResolver, CATALOG_UNAVAILABLE_MESSAGE } = require('../src/server/ipCatalog/resolvePresets');
const { coversSame, coversSame6 } = require('./helpers/cidr-coverage');

const E4 = ['162.159.192.0/24', '162.159.193.0/24', '162.159.195.0/24', '162.159.204.0/24'];
const E6 = ['2606:4700:d0::/48', '2606:4700:d1::/48'];

const PRESETS = {
  telegram: { domains: ['telegram.org'], ip: [{ from: 'official', list: 'telegram' }] },
  cloudflare: { domains: ['cloudflare.com'], ip: [{ from: 'official', list: 'cloudflare' }] },
  rutracker: { domains: ['rutracker.org'], ip: [{ from: 'portal', portals: ['rutracker.org'] }] },
  steam: { domains: ['steampowered.com'], ip: [{ from: 'asn', asns: [32590] }] },
  youtube: { domains: ['youtube.com'], legacy: {} },
  discord: { domains: ['discord.com'], legacy: { communityLists: ['Discord'] } },
};
const ALIASES = { rutracker_local: 'rutracker' };
const RETIRED = ['vk', 'ok'];
const catalogSet = (cidrs4, extra = {}) => ({
  cidrs4, cidrs6: [], addrs4: 0, precision: 'exact', coverage: {}, stale: null, noData: null, seen4: {}, seen6: {}, ...extra,
});
const DOC = {
  schema: 1,
  builtAt: '2026-11-05T10:00:00Z',
  sources: {},
  presets: {
    cloudflare: catalogSet(['162.158.0.0/15', '188.114.96.0/20'], { cidrs6: ['2606:4700::/32'] }),
    discord: { legacy: true, liveRoutes4: 93, fallback: catalogSet(['66.22.192.0/18'], { precision: 'approx' }) },
    rutracker: catalogSet(['104.21.32.1/32', '172.67.1.1/32'], { precision: 'approx' }),
    steam: catalogSet([], { noData: 'asn_not_announced' }),
    telegram: catalogSet(['149.154.160.0/20', '91.108.4.0/22'], { cidrs6: ['2001:b28:f23d::/48'] }),
    youtube: { legacy: true, liveRoutes4: 621, fallback: catalogSet(['142.250.0.0/15'], { cidrs6: ['2a00:1450::/32'] }) },
  },
};
const TEXT = JSON.stringify(DOC);

/** A resolver over the fixture; `live` answers transitional presets by key (a function, or null = no IPv4). */
const resolverFor = ({ text = TEXT, live = {}, missing = false } = {}) => {
  const calls = { read: 0, live: [] };
  const loadSnapshot = createSnapshotLoader({
    path: '/fixture/snapshot.json',
    readFile: () => {
      calls.read += 1;
      if (missing) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return text;
    },
  });
  const fetchLegacy = async (key, def, opts) => {
    calls.live.push({ key, def, opts });
    const answer = live[key];
    if (typeof answer === 'function') return answer(opts);
    return answer || { cidrs4: [], cidrs6: [], source: 'opencck' };
  };
  return { resolver: createResolver({ presets: PRESETS, aliases: ALIASES, retired: RETIRED, loadSnapshot, fetchLegacy }), calls };
};

const resolveKeys = async (r, keys, opts) => r.resolver.resolve(r.resolver.plan(keys), opts);

describe('snapshot: strict parsing, the price on the AllowedIPs base, lazy loading', () => {
  test('the fixture parses; the price is the aggregated count after the WARP endpoint cut', () => {
    const parsed = parseSnapshot(TEXT);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.snapshot.builtAt, '2026-11-05T10:00:00Z');
    // 162.158.0.0/15 without E4 is ten blocks, 188.114.96.0/20 one.
    assert.equal(parsed.snapshot.presets.cloudflare.routes4, 11);
    assert.equal(priceOf(['162.158.0.0/15', '188.114.96.0/20']), 11);
    assert.equal(parsed.snapshot.presets.steam.routes4, 0);
    assert.equal(parsed.snapshot.presets.youtube.legacy, true);
    assert.equal(parsed.snapshot.presets.youtube.fallback.routes4, 1);
  });

  test('anything unexpected makes the whole file unusable', () => {
    const variants = [
      ['{"schema": 1, "presets": {', 'snapshot_invalid_json'],
      [JSON.stringify({ ...DOC, schema: 2 }), 'snapshot_rejected'],
      [JSON.stringify({ ...DOC, builtAt: 'yesterday' }), 'snapshot_rejected'],
      [JSON.stringify({ ...DOC, presets: [] }), 'snapshot_rejected'],
      [JSON.stringify({ ...DOC, presets: { ...DOC.presets, telegram: catalogSet(['149.154.160.0/33']) } }), 'snapshot_rejected'],
      [JSON.stringify({ ...DOC, presets: { ...DOC.presets, telegram: catalogSet(['1.2.3.4']) } }), 'snapshot_rejected'],
      [JSON.stringify({ ...DOC, presets: { ...DOC.presets, telegram: catalogSet(['1.2.3.0/24'], { cidrs6: ['2001:db8::'] }) } }), 'snapshot_rejected'],
      [JSON.stringify({ ...DOC, presets: { ...DOC.presets, telegram: catalogSet(['1.2.3.0/24'], { precision: 'fine' }) } }), 'snapshot_rejected'],
      [JSON.stringify({ ...DOC, presets: { ...DOC.presets, youtube: { legacy: true, liveRoutes4: -1, fallback: catalogSet([]) } } }), 'snapshot_rejected'],
    ];
    for (const [text, reason] of variants) assert.deepEqual(parseSnapshot(text), { ok: false, reason }, text.slice(0, 80));
  });

  test('the loader reads nothing until asked, then once; a missing file is snapshot_missing', () => {
    const r = resolverFor();
    assert.equal(r.calls.read, 0, 'creating the resolver reads nothing');
    r.resolver.plan(['telegram']);
    r.resolver.plan(['cloudflare']);
    assert.equal(r.calls.read, 1);
    let reads = 0;
    const load = createSnapshotLoader({ readFile: () => { reads += 1; throw new Error('ENOENT'); } });
    assert.deepEqual(load(), { ok: false, reason: 'snapshot_missing' });
    assert.deepEqual(load(), { ok: false, reason: 'snapshot_missing' });
    assert.equal(reads, 1);
  });
});

describe('plan: aliases, retired, unknown, no data — synchronous, no network', () => {
  test('aliases fold into their target, retired and unknown keys are named, request order kept', () => {
    const r = resolverFor();
    const p = r.resolver.plan(['RuTracker_Local', 'vk', 'rutracker', 'telegram', 'nope', 'steam', 'ok', 'vk', '!!!']);
    assert.deepEqual(p.canonicalKeys, ['rutracker', 'telegram', 'steam']);
    assert.deepEqual(p.retired, ['vk', 'ok']);
    assert.deepEqual(p.unknown, ['nope']);
    assert.deepEqual(p.noData, { steam: 'asn_not_announced' });
    assert.deepEqual(p.active, ['rutracker', 'telegram']);
    assert.equal(r.calls.live.length, 0);
  });

  test('only retired keys: the snapshot is not even read, so a broken one does not matter', () => {
    const r = resolverFor({ missing: true });
    const p = r.resolver.plan(['vk', 'ok']);
    assert.deepEqual([p.canonicalKeys, p.active, p.retired], [[], [], ['vk', 'ok']]);
    assert.equal(r.calls.read, 0);
  });

  test('a live preset with an unusable snapshot → a 503 error with the fixed text', () => {
    for (const r of [resolverFor({ missing: true }), resolverFor({ text: '{' })]) {
      assert.throws(() => r.resolver.plan(['telegram']), (err) => err.statusCode === 503 && err.message === CATALOG_UNAVAILABLE_MESSAGE);
    }
  });
});

describe('resolve: catalogue, transitional presets, reserve, cut', () => {
  test('catalogue presets only: no network, source catalog, AllowedIPs = S \\ E4 aggregated', async () => {
    const r = resolverFor();
    const out = await resolveKeys(r, ['cloudflare', 'telegram']);
    assert.equal(r.calls.live.length, 0);
    assert.equal(out.cidrSource, 'catalog');
    assert.equal(out.telemetrySource, 'catalog');
    assert.deepEqual(out.raw4, ['149.154.160.0/20', '162.158.0.0/15', '188.114.96.0/20', '91.108.4.0/22']);
    assert.deepEqual(out.raw6, []);
    assert.equal(coversSame(out.cidrs, out.raw4, { minus: E4 }).ok, true);
    assert.equal(out.after4, out.cidrs.length);
    assert.deepEqual(out.presetStatus.cloudflare, { source: 'catalog', precision: 'exact', routes4: 11 });
    assert.deepEqual(out.warnings, []);
  });

  test('a transitional preset answered live: its own call, source of the live part, price of the answer', async () => {
    const r = resolverFor({ live: { youtube: { cidrs4: ['8.8.8.0/24', '8.8.9.0/24', '2001:4860::/32'], cidrs6: ['2001:4860::/32'], source: 'opencck' } } });
    const out = await resolveKeys(r, ['youtube', 'telegram']);
    assert.deepEqual(r.calls.live.map((c) => c.key), ['youtube']);
    assert.equal(r.calls.live[0].def, PRESETS.youtube);
    assert.equal(out.cidrSource, 'opencck');
    assert.equal(out.telemetrySource, 'opencck');
    assert.ok(out.raw4.includes('8.8.8.0/24'));
    assert.ok(!out.raw4.some((c) => c.includes(':')), 'an IPv6 entry of a cidr4 answer never enters the IPv4 part');
    assert.deepEqual(out.presetStatus.youtube, { source: 'live', precision: 'wide', routes4: 1 });
    assert.deepEqual(out.warnings, []);
  });

  test('no IPv4 from the live call, or a call that throws → the snapshot reserve, named in a warning', async () => {
    for (const live of [{}, { youtube: () => { throw new Error('lists down'); } }, { youtube: { cidrs4: ['2001:4860::/32'], cidrs6: [], source: 'opencck' } }]) {
      const r = resolverFor({ live });
      const out = await resolveKeys(r, ['youtube']);
      assert.deepEqual(out.raw4, ['142.250.0.0/15']);
      assert.equal(out.cidrSource, 'catalog', 'every transitional preset went to the reserve');
      assert.deepEqual(out.presetStatus.youtube, { source: 'catalog-fallback', precision: 'exact', routes4: 1 });
      assert.deepEqual(out.warnings, ['Route source fallback: youtube']);
    }
  });

  test('each transitional preset on its own call; sources mixed → mixed / fallback telemetry', async () => {
    const r = resolverFor({ live: {
      youtube: { cidrs4: ['8.8.8.0/24'], cidrs6: [], source: 'opencck' },
      discord: { cidrs4: ['66.22.192.0/18'], cidrs6: [], source: 'community' },
    } });
    const out = await resolveKeys(r, ['discord', 'youtube']);
    assert.deepEqual(r.calls.live.map((c) => c.key).sort(), ['discord', 'youtube']);
    assert.deepEqual(r.calls.live.find((c) => c.key === 'discord').def.legacy.communityLists, ['Discord']);
    assert.equal(out.cidrSource, 'mixed');
    assert.equal(out.telemetrySource, 'fallback');
    const one = resolverFor({ live: { discord: { cidrs4: ['66.22.192.0/18'], cidrs6: [], source: 'community' } } });
    assert.equal((await resolveKeys(one, ['discord'])).telemetrySource, 'itdoginfo');
  });

  test('retired and no-data presets are skipped and named, in this order', async () => {
    const r = resolverFor();
    const out = await resolveKeys(r, ['vk', 'steam', 'telegram', 'ok']);
    assert.deepEqual(out.warnings, ['Presets retired: vk, ok', 'Presets without data: steam']);
    assert.deepEqual(out.presetStatus.vk, { source: 'retired' });
    assert.deepEqual(out.presetStatus.steam, { source: 'noData', noData: 'asn_not_announced' });
    assert.deepEqual(out.raw4, ['149.154.160.0/20', '91.108.4.0/22']);
  });

  test('IPv4 is always there, IPv6 only with includeIpv6 and then without E6', async () => {
    const r = resolverFor({ live: { youtube: { cidrs4: ['8.8.8.0/24'], cidrs6: ['2001:4860::/32'], source: 'opencck' } } });
    const four = await resolveKeys(r, ['cloudflare', 'telegram', 'youtube']);
    assert.equal(four.cidrs.some((c) => c.includes(':')), false);
    assert.equal(four.count6, 0);
    const six = await resolveKeys(r, ['cloudflare', 'telegram', 'youtube'], { includeIpv6: true });
    assert.deepEqual(six.raw4, four.raw4, 'the static IPv4 of a preset stays with ipv6=1');
    assert.deepEqual(six.raw6, ['2001:4860::/32', '2001:b28:f23d::/48', '2606:4700::/32']);
    const v6 = six.cidrs.filter((c) => c.includes(':'));
    assert.equal(coversSame6(v6, six.raw6, { minus: E6 }).ok, true);
    assert.equal(six.count6, v6.length);
    assert.equal(six.count6, 2 + 15);
  });

  test('avoid: a covered address leaves AllowedIPs as a /32 (/128) and is reported; an uncovered one changes nothing', async () => {
    const r = resolverFor();
    const inside = await resolveKeys(r, ['cloudflare'], { avoid4: ['188.114.96.7'] });
    assert.deepEqual(inside.avoidInside, ['188.114.96.7']);
    assert.equal(coversSame(inside.cidrs, inside.raw4, { minus: [...E4, '188.114.96.7/32'] }).ok, true);
    const outside = await resolveKeys(r, ['cloudflare'], { avoid4: ['203.0.113.9', '162.159.192.1'] });
    assert.deepEqual(outside.avoidInside, [], 'an engage address is already cut by E4');
    const six = await resolveKeys(r, ['cloudflare'], { includeIpv6: true, avoid6: ['2606:4700:4700::1111'] });
    assert.deepEqual(six.avoidInside, ['2606:4700:4700::1111']);
    assert.equal(coversSame6(six.cidrs.filter((c) => c.includes(':')), six.raw6, { minus: [...E6, '2606:4700:4700::1111/128'] }).ok, true);
    const noSix = await resolveKeys(r, ['cloudflare'], { avoid6: ['2606:4700:4700::1111'] });
    assert.deepEqual(noSix.avoidInside, [], 'without IPv6 routes there is nothing to cut');
  });

  test('a set that is empty after the cut gives an empty list; the caller decides', async () => {
    const text = JSON.stringify({ ...DOC, presets: { ...DOC.presets, telegram: catalogSet(['162.159.192.0/24']) } });
    const out = await resolveKeys(resolverFor({ text }), ['telegram']);
    assert.deepEqual(out.cidrs, []);
    assert.equal(out.after4, 0);
    assert.equal(out.before4, 1);
  });
});

describe('prices for the catalogue', () => {
  test('a catalogue preset its routes4, a transitional one its liveRoutes4 (wide), no data 0', () => {
    const { prices } = resolverFor().resolver;
    const out = prices();
    assert.equal(out.builtAt, '2026-11-05T10:00:00Z');
    assert.deepEqual(out.presets.cloudflare, { source: 'catalog', routes4: 11, precision: 'exact', noData: null });
    assert.deepEqual(out.presets.youtube, { source: 'live', routes4: 621, precision: 'wide', noData: null });
    assert.deepEqual(out.presets.steam, { source: 'catalog', routes4: 0, precision: 'exact', noData: 'asn_not_announced' });
    assert.equal(resolverFor({ missing: true }).resolver.prices(), null);
  });
});
