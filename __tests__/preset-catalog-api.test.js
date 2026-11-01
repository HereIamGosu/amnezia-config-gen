// __tests__/preset-catalog-api.test.js
// The preset catalogue through the real handlers (3.2.0, spec 3.2.0 §5.1–§5.3, §5.6, K14, K15): /api/iplist with and
// without presets, aliases, retired presets, presets without data, the price and the counter on the AllowedIPs base,
// the raw fields of 3.1.9 with the two count defects fixed, the empty-set refusal of /api/warp before Lab Auto and
// registration, a broken snapshot (split 503, full tunnel 200) and the [preset-stats] line. No network: catalogue
// presets never ask one, and the transitional ones are answered by the harness.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const { generate, registrationAnswer, labProvider, labSnapshot, LAB_POOL } = require('./helpers/warp-harness');
const { getCatalog, resetCatalog } = require('../src/server/ipCatalog');
const { SNAPSHOT_PATH } = require('../src/server/ipCatalog/snapshot');
const { ROUTE_PRESETS, PRESET_QUICK_PICK, PRESET_CATEGORY_ORDER, RETIRED_PRESETS } = require('../src/server/routePresets');
const presetStats = require('../src/server/presetStats');

const CLOUDFLARE = 'api.cloudflareclient.com';
const SNAPSHOT = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
const LIVE = ['198.51.100.0/24', '203.0.113.0/25'];
const network = (_n, request) => {
  if (request.hostname === CLOUDFLARE) return registrationAnswer();
  if (request.hostname !== 'iplist.opencck.org') return { status: 500, body: '' };
  const sites = new URLSearchParams(request.path.slice(2)).getAll('site');
  return { status: 200, body: JSON.stringify(Object.fromEntries(sites.map((s) => [s, LIVE]))) };
};
const freshLists = () => {
  for (const id of ['../src/server/ipListFetch', '../src/server/communityIpFetch', '../api/iplist']) delete require.cache[require.resolve(id)];
};
beforeEach(() => { freshLists(); presetStats.__stats.reset(); });
afterEach(() => { resetCatalog(); presetStats.__stats.reset(); });

/** /api/iplist through the handler with Vercel-style fakes; `https` answered by `network`. */
const iplist = async (query) => {
  const m = mock.method(https, 'request', (options, cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      const answer = network(0, options);
      const res = new EventEmitter();
      res.statusCode = answer.status;
      cb(res);
      res.emit('data', Buffer.from(answer.body));
      res.emit('end');
    });
    return req;
  });
  try {
    const handler = require('../api/iplist');
    const res = { status: 200, body: null, setHeader() {}, getHeader() {} };
    const r = { setHeader() {}, status(c) { res.status = c; return r; }, json(b) { res.body = b; return r; } };
    await handler({ method: 'GET', url: `/api/iplist?${new URLSearchParams(query)}`, query, headers: {}, socket: {} }, r);
    return { ...res, requests: m.mock.calls.map((c) => c.arguments[0].hostname) };
  } finally {
    m.mock.restore();
  }
};
const allowedOf = (conf) => /^AllowedIPs = (.+)$/m.exec(conf)[1].split(', ');
const v4 = (list) => list.filter((c) => !c.includes(':'));
const warnings = (body) => [].concat(body.warning ?? []);
const withSnapshot = (mutate) => {
  const doc = JSON.parse(JSON.stringify(SNAPSHOT));
  mutate(doc);
  resetCatalog({ readFile: () => JSON.stringify(doc) });
};

describe('/api/iplist without presets: the catalogue', () => {
  test('categories, quick pick, aliases, retired keys, snapshot date; every preset with its price', async () => {
    const out = await iplist({});
    assert.equal(out.status, 200);
    const b = out.body;
    assert.deepEqual(b.categories, [...PRESET_CATEGORY_ORDER]);
    assert.deepEqual(b.groupRfPopular, [...PRESET_QUICK_PICK]);
    assert.deepEqual(b.aliases, { rutracker_local: 'rutracker' });
    assert.deepEqual(b.retired, [...RETIRED_PRESETS]);
    assert.equal(b.catalogBuiltAt, SNAPSHOT.builtAt);
    assert.deepEqual(b.presets.map((p) => p.id).sort(), Object.keys(ROUTE_PRESETS).sort());
    for (const p of b.presets) {
      assert.ok(PRESET_CATEGORY_ORDER.includes(p.category), `${p.id}: a known category`);
      assert.ok(Number.isInteger(p.routes4) && p.routes4 >= 0, p.id);
      assert.ok(['catalog', 'live'].includes(p.source), p.id);
      if (p.source === 'live') {
        assert.equal(p.routes4, SNAPSHOT.presets[p.id].liveRoutes4, `${p.id}: the liveRoutes4 of the build`);
        assert.equal(p.precision, 'wide');
      }
    }
    for (const key of RETIRED_PRESETS) assert.ok(!b.presets.some((p) => p.id === key), `${key} is not in the catalogue`);
    assert.deepEqual(out.requests, [], 'no network');
  });

  test('the price of a tile equals routes4 of the set made of that preset alone', async () => {
    const catalogKeys = Object.keys(ROUTE_PRESETS).filter((k) => !SNAPSHOT.presets[k].legacy && !SNAPSHOT.presets[k].noData);
    const listing = (await iplist({})).body.presets;
    for (const key of catalogKeys) {
      const one = await iplist({ presets: key });
      assert.equal(listing.find((p) => p.id === key).routes4, one.body.routes4, key);
    }
  });
});

describe('/api/iplist with presets', () => {
  test('a catalogue preset: raw fields of 3.1.9, routes4 = the IPv4 lines of /api/warp for the same set', async () => {
    // The spec named telegram here; it stayed transitional (owner, 2026-11-01): github and zoom stand in.
    for (const presets of ['github', 'cloudflare,github', 'zoom,steam,cloudflare,google']) {
      const one = await iplist({ presets });
      assert.equal(one.status, 200);
      assert.equal(one.body.cidrSource, 'catalog');
      assert.equal(one.body.count4, one.body.cidrs.length, 'raw union, no cut, no merge between presets');
      const warp = await generate({ mode: 'awg2', routeMode: 'split', presets }, { cloudflare: network });
      assert.equal(warp.status, 200, JSON.stringify(warp.body));
      assert.equal(one.body.routes4, v4(allowedOf(warp.configs[0])).length, presets);
    }
  });

  test('ipv6=1: the static IPv4 of a preset stays in cidrs and count6 counts only IPv6 (3.1.9 defects)', async () => {
    const four = await iplist({ presets: 'github' });
    const six = await iplist({ presets: 'github', ipv6: '1' });
    assert.deepEqual(v4(six.body.cidrs), v4(four.body.cidrs));
    assert.equal(six.body.count4, four.body.count4);
    assert.equal(six.body.count6, six.body.cidrs.filter((c) => c.includes(':')).length);
    assert.equal(six.body.count, six.body.count4 + six.body.count6);
    assert.ok(six.body.routes6 > 0);
  });

  test('a transitional preset: its live lists, source of the live part', async () => {
    const out = await iplist({ presets: 'youtube' });
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.cidrs, LIVE);
    assert.equal(out.body.cidrSource, 'opencck');
    assert.equal(out.body.presetStatus.youtube.source, 'live');
  });

  test('the table of §5.2: only retired, only without data, empty after the cut, unknown', async () => {
    const retired = await iplist({ presets: 'vk,ok' });
    assert.equal(retired.status, 200);
    assert.deepEqual([retired.body.count4, retired.body.routes4], [0, 0]);
    assert.deepEqual(retired.body.warnings, ['Presets retired: vk, ok']);

    withSnapshot((doc) => { doc.presets.steam = { ...doc.presets.steam, cidrs4: [], noData: 'asn_not_announced' }; });
    const noData = await iplist({ presets: 'steam' });
    assert.deepEqual([noData.status, noData.body.count4, noData.body.routes4], [200, 0, 0]);
    assert.deepEqual(noData.body.warnings, ['Presets without data: steam']);

    withSnapshot((doc) => { doc.presets.control4 = { ...doc.presets.control4, cidrs4: ['162.159.192.0/24'] }; });
    const cut = await iplist({ presets: 'control4' });
    assert.equal(cut.status, 200);
    assert.equal(cut.body.routes4, 0);
    assert.deepEqual(cut.body.warnings, ['Empty after endpoint cut']);

    const unknown = await iplist({ presets: 'nope,vk' });
    assert.equal(unknown.status, 400);
    assert.deepEqual(unknown.body.unknown, ['nope']);
  });

  test('an alias answers as its target', async () => {
    const alias = await iplist({ presets: 'rutracker_local' });
    const target = await iplist({ presets: 'rutracker' });
    assert.deepEqual(alias.body.cidrs, target.body.cidrs);
    assert.deepEqual(Object.keys(alias.body.presetStatus), ['rutracker']);
  });
});

describe('/api/warp: aliases, retired presets, presets without data (§5.3, K14)', () => {
  test('an alias is expanded silently; routesPresets names the canonical key', async () => {
    const alias = await generate({ mode: 'awg2', routeMode: 'split', presets: 'rutracker_local' }, { cloudflare: network });
    const target = await generate({ mode: 'awg2', routeMode: 'split', presets: 'rutracker' }, { cloudflare: network });
    assert.equal(alias.status, 200, JSON.stringify(alias.body));
    assert.deepEqual(alias.body.routesPresets, ['rutracker']);
    assert.equal(allowedOf(alias.configs[0]).join(), allowedOf(target.configs[0]).join());
    assert.deepEqual(warnings(alias.body), []);
  });

  test('a retired preset in a mix is skipped with a warning; presetSitesCount counts domains', async () => {
    const out = await generate({ mode: 'awg2', routeMode: 'split', presets: 'vk,github' }, { cloudflare: network });
    assert.equal(out.status, 200);
    assert.deepEqual(warnings(out.body), ['Presets retired: vk']);
    assert.deepEqual(out.body.routesPresets, ['github']);
    assert.equal(out.body.presetSitesCount, ROUTE_PRESETS.github.domains.length);
    assert.equal(out.body.routesTelemetrySource, 'catalog');
  });

  test('only retired presets → 400 empty_split_tunnel before Lab Auto and registration, with or without routeMode', async () => {
    for (const query of [{ routeMode: 'split', presets: 'vk' }, { presets: 'vk,ok' }]) {
      const lab = labProvider(labSnapshot(LAB_POOL));
      const out = await generate({ mode: 'awg2', endpointMode: 'lab', ...query }, { cloudflare: network, lab });
      assert.equal(out.status, 400, JSON.stringify(out.body));
      assert.equal(out.body.error, 'empty_split_tunnel');
      assert.match(out.body.message, /retired presets \(vk/);
      assert.equal(out.requests.length, 0);
      assert.equal(lab.calls.select, 0);
    }
  });

  test('a preset without data: skipped with a warning; alone → 400 empty_split_tunnel naming it', async () => {
    withSnapshot((doc) => { doc.presets.steam = { ...doc.presets.steam, cidrs4: [], noData: 'asn_not_announced' }; });
    const mix = await generate({ mode: 'awg2', routeMode: 'split', presets: 'steam,github' }, { cloudflare: network });
    assert.equal(mix.status, 200);
    assert.deepEqual(warnings(mix.body), ['Presets without data: steam']);
    const alone = await generate({ mode: 'awg2', routeMode: 'split', presets: 'steam' }, { cloudflare: network });
    assert.equal(alone.status, 400);
    assert.equal(alone.body.error, 'empty_split_tunnel');
    assert.match(alone.body.message, /presets without data \(steam\)/);
  });
});

// mobile=1 drops IPv6 twice in api/warp.js (the routes are asked without it, the config filters it): the test fails
// only when both are gone, so it checks the behaviour, not one line.
describe('/api/warp: IPv6 networks of a catalogue preset (I6, I7)', () => {
  test('IPv6 routes only with ipv6=1, never without it or with mobile=1 (github)', async () => {
    assert.ok(SNAPSHOT.presets.github.cidrs6.length, 'the check needs a catalogue preset with IPv6 networks');
    const on = await generate({ mode: 'awg2', routeMode: 'split', presets: 'github', ipv6: '1' }, { cloudflare: network });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.ok(allowedOf(on.configs[0]).some((c) => c.includes(':')), 'ipv6=1 carries the IPv6 networks of the preset');
    for (const extra of [{}, { mobile: '1', ipv6: '1' }]) {
      const out = await generate({ mode: 'awg2', routeMode: 'split', presets: 'github', ...extra }, { cloudflare: network });
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.deepEqual(allowedOf(out.configs[0]).filter((c) => c.includes(':')), [], JSON.stringify(extra));
    }
  });
});

describe('a broken or missing snapshot', () => {
  for (const [name, reader] of [['not JSON', () => '{'], ['missing', () => { throw new Error('ENOENT'); }]]) {
    test(`${name}: split and /api/iplist with presets → 503 before registration; the full tunnel and the catalogue → 200`, async () => {
      resetCatalog({ readFile: reader });
      const splitOut = await generate({ mode: 'awg2', routeMode: 'split', presets: 'telegram' }, { cloudflare: network });
      assert.equal(splitOut.status, 503);
      assert.match(splitOut.body.message, /Каталог адресов пресетов сейчас недоступен/);
      assert.equal(splitOut.requests.length, 0);
      const full = await generate({ mode: 'awg2' }, { cloudflare: network });
      assert.equal(full.status, 200);
      const withPresets = await iplist({ presets: 'telegram' });
      assert.equal(withPresets.status, 503);
      const listing = await iplist({});
      assert.equal(listing.status, 200);
      assert.equal(listing.body.catalogBuiltAt, null);
    });
  }
});

describe('[preset-stats] (K8, spec §5.6)', () => {
  test('one line per window: successful split generations per canonical key, catalogue order, no IP', async () => {
    await generate({ mode: 'awg2', routeMode: 'split', presets: 'telegram,rutracker_local' }, { cloudflare: network });
    await generate({ mode: 'awg2', routeMode: 'split', presets: 'telegram' }, { cloudflare: network });
    await generate({ mode: 'awg2', routeMode: 'split', presets: 'vk' }, { cloudflare: network });
    await generate({ mode: 'awg2' }, { cloudflare: network });
    const lines = [];
    const line = presetStats.flushPresetStats((l) => lines.push(l));
    assert.equal(line, '[preset-stats] window=600s telegram=2 rutracker=1');
    assert.deepEqual(lines, [line]);
    assert.doesNotMatch(line, /\d+\.\d+\.\d+\.\d+|10\.0\.0\.1/, 'no address');
    assert.equal(presetStats.flushPresetStats((l) => lines.push(l)), null, 'an empty window writes nothing');
    assert.equal(lines.length, 1);
  });

  test('only catalogue keys are counted; the window timer does not keep the process alive', () => {
    presetStats.recordPresetUse(['telegram', 'not-a-preset', 'telegram']);
    assert.equal(presetStats.__stats.timer().hasRef(), false);
    assert.equal(presetStats.flushPresetStats(() => {}), '[preset-stats] window=600s telegram=1');
  });

  test('server.js flushes the counters at shutdown', () => {
    const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    assert.match(source, /const shutdown = \(\) => \{[\s\S]*flushPresetStats\(\);[\s\S]*server\.close/);
  });
});

describe('the catalogue plan is the one the handlers use', () => {
  test('getCatalog() is shared and reads the committed snapshot', () => {
    assert.equal(getCatalog(), getCatalog());
    assert.equal(getCatalog().prices().builtAt, SNAPSHOT.builtAt);
  });
});
