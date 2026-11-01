// __tests__/route-aggregation-api.test.js
// /api/warp split routes in 3.1.9: the IPv4 routes of the presets minus the WARP endpoint subnets E_fixed
// (decision No. 18), exactly aggregated (I14), the same in Lab Auto and hostname mode (I11), with a "Route budget:"
// warning above 1000 routes and no refusal. The full tunnel and the IPv6 part are untouched. T-C4, T-C5, T-C9 of
// spec R6 and the invariants the new path crosses (I6, I7, I8, I10, I11, the 3.1.8 IPv4-only degradation).
// No network: the harness answers Cloudflare and the route list hosts.

'use strict';

const assert = require('node:assert/strict');
const { describe, test, beforeEach } = require('node:test');
const { inflateSync } = require('node:zlib');
const { ROUTE_PRESETS } = require('../src/server/routePresets');
const { getCatalog } = require('../src/server/ipCatalog');
const { generate, registrationAnswer, parseConf, endpointOf, labProvider, labSnapshot, labEndpoint } = require('./helpers/warp-harness');
const { coversSame, parse } = require('./helpers/cidr-coverage');

const CLOUDFLARE = 'api.cloudflareclient.com';
const OPENCCK = 'iplist.opencck.org';
const E_FIXED = ['162.159.192.0/24', '162.159.193.0/24', '162.159.195.0/24', '162.159.204.0/24'];
const RANDOM_BY_DESIGN = new Set(['PrivateKey', 'Jc', 'Jmin', 'Jmax', 'I1', 'I2', 'I3', 'I4', 'I5']);
// What opencck returns for Discord, TikTok, OpenAI and others (report 2026-11-01): a Cloudflare /15 that holds
// E_fixed and engage 162.159.192.1, the FALLBACK /22 shared with ordinary sites, a mergeable pair, discord.com.
const LIST = [
  '162.158.0.0/15', '188.114.96.0/22', '10.0.0.0/9', '10.128.0.0/9', '203.0.113.4/32', '203.0.113.5/32',
  '162.159.128.233/32', '198.51.100.0/24',
];
const LIST6 = ['2606:4700:d0::/48', '2001:db8::/33', '2001:db8:8000::/33'];
// LIST6 after the 3.2.0 IPv6 cut: 2606:4700:d0::/48 is inside E6 (spec 3.2.0 §5.4 p. 1), the rest passes unchanged.
const LIST6_OFF_E6 = ['2001:db8:8000::/33', '2001:db8::/33'];

const line = (conf, key) => conf.split('\n').find((l) => l.startsWith(`${key} =`));
const allowedOf = (conf) => line(conf, 'AllowedIPs').slice('AllowedIPs = '.length).split(', ');
const v4 = (list) => list.filter((c) => !c.includes(':'));
const warnings = (body) => [].concat(body.warning ?? []);
const budgetWarnings = (body) => warnings(body).filter((w) => w.startsWith('Route budget:'));
/** Whether the IPv4 blocks of `list` route `address`: adding its /32 does not change the set. */
const covers = (list, address) => coversSame(v4(list), [...v4(list), `${address}/32`]).ok;

/** Cloudflare registers (`registrations[k - 1]` for registration k); opencck answers `list`/`list6` for every site. */
const network = ({ list = LIST, list6 = LIST6, registrations = [registrationAnswer()] } = {}) => {
  let calls = 0;
  return (_n, request) => {
    if (request.hostname === CLOUDFLARE) {
      calls += 1;
      return registrations[Math.min(Math.ceil(calls / 3), registrations.length) - 1];
    }
    if (request.hostname !== OPENCCK) return { status: 500, body: '' };
    const sites = new URLSearchParams(request.path.slice(2)).getAll('site');
    const cidrs = request.path.includes('data=cidr6') ? list6 : list;
    return { status: 200, body: JSON.stringify(Object.fromEntries(sites.map((s) => [s, cidrs]))) };
  };
};

// The route list fetchers keep a 10-minute cache per set of sites; each test starts with fresh modules.
const freshLists = () => {
  for (const id of ['../src/server/ipListFetch', '../src/server/communityIpFetch']) delete require.cache[require.resolve(id)];
};
beforeEach(freshLists);

const split = (query, opts = {}) => generate({ mode: 'awg2', routeMode: 'split', ...query }, { cloudflare: network(opts), ...opts.harness });

const decodeVpnLink = (link) => {
  const buf = Buffer.from(link.slice('vpn://'.length).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return JSON.parse(inflateSync(buf.slice(4)).toString('utf8'));
};

/** Fields of two configs that differ, random-by-design values aside; same lines and key order required. */
const semanticDiff = (a, b) => {
  const layout = (c) => c.split('\n').map((l) => l.replace(/ = .*$/, ' = …'));
  assert.deepEqual(layout(b), layout(a), 'same lines and key order');
  const pa = parseConf(a);
  const pb = parseConf(b);
  const out = [];
  pa.forEach((section, i) => section.fields.forEach(([key, value], j) => {
    if (!RANDOM_BY_DESIGN.has(key) && value !== pb[i].fields[j][1]) out.push(`${section.name}.${key}`);
  }));
  return out;
};

// Changed in 3.2.0 (spec 3.2.0 §8): S of a catalogue preset is its snapshot record; only the transitional presets
// still read the route lists, here the faked opencck. A preset without data in the snapshot is refused (K14).
describe('every preset: AllowedIPs = S \\ E_fixed (decision No. 18, I14)', () => {
  const snapshot = getCatalog().plan(Object.keys(ROUTE_PRESETS)).snapshot.presets;
  for (const key of Object.keys(ROUTE_PRESETS)) {
    test(key, async () => {
      const record = snapshot[key];
      const out = await split({ presets: key });
      if (!record.legacy && record.noData) {
        assert.equal(out.status, 400, JSON.stringify(out.body));
        assert.equal(out.body.error, 'empty_split_tunnel');
        return;
      }
      // A transitional preset: the faked lists plus its fixed legacy networks (telegram keeps the nine of 3.1.9).
      const s = record.legacy ? [...LIST, ...((ROUTE_PRESETS[key].legacy || {}).cidrs4 || [])] : record.cidrs4;
      assert.equal(out.status, 200, JSON.stringify(out.body));
      const allowed = allowedOf(out.configs[0]);
      assert.equal(coversSame(allowed, s, { minus: E_FIXED }).ok, true, 'exactly S minus E_fixed');
      assert.equal(coversSame(allowed, allowed, { minus: E_FIXED }).ok, true, 'nothing of E_fixed');
      if (record.legacy) {
        for (const address of ['162.159.128.233', '162.159.138.232', '188.114.96.3', '188.114.97.3', '10.200.0.1']) {
          assert.ok(covers(allowed, address), `${address} stays routed`);
        }
      }
      for (const address of ['162.159.192.1', '162.159.193.8', '162.159.195.1', '162.159.204.51']) {
        assert.equal(covers(allowed, address), false, `${address} is a WARP endpoint`);
      }
    });
  }

  test('a list made only of E_fixed is empty after the cut → 502 before registration, never a full tunnel', async () => {
    const out = await split({ presets: 'discord' }, { list: ['162.159.192.0/24', '162.159.193.0/25', '162.159.204.7/32'] });
    assert.equal(out.status, 502);
    assert.match(out.body.message, /пустой ответ/);
    assert.equal(out.requests.filter((r) => r.hostname === CLOUDFLARE).length, 0);
  });
});

describe('the same AllowedIPs in Lab Auto and hostname mode (I11)', () => {
  test('count=2: only Peer.Endpoint differs, and the Lab endpoint is outside AllowedIPs', async () => {
    const pool = [labEndpoint('162.159.192.11', 2408), labEndpoint('162.159.193.12', 500)];
    const host = await split({ presets: 'discord', count: '2', link: '1' });
    const lab = await split({ presets: 'discord', count: '2', link: '1', endpointMode: 'lab' },
      { harness: { lab: labProvider(labSnapshot(pool)) } });
    assert.equal(host.status, 200, JSON.stringify(host.body));
    assert.equal(lab.status, 200, JSON.stringify(lab.body));
    for (let i = 0; i < 2; i += 1) {
      assert.deepEqual(semanticDiff(host.configs[i], lab.configs[i]), ['Peer.Endpoint']);
      assert.equal(line(lab.configs[i], 'AllowedIPs'), line(host.configs[0], 'AllowedIPs'));
      const endpoint = endpointOf(lab.configs[i]).replace(/:\d+$/, '');
      assert.equal(covers(allowedOf(lab.configs[i]), endpoint), false, `${endpoint} is not routed into the tunnel`);
    }
  });
});

describe('what the cut does not touch', () => {
  test('T-C9 the full tunnel: 0.0.0.0/0 as before, without and with presets, without and with ipv6=1', async () => {
    for (const [query, expected] of [
      [{ mode: 'awg2' }, '0.0.0.0/0'],
      [{ mode: 'awg2', routeMode: 'full', presets: 'discord' }, '0.0.0.0/0'],
      [{ mode: 'awg2', ipv6: '1' }, '0.0.0.0/0, ::/0'],
      [{ mode: 'legacy', routeMode: 'full', presets: 'tiktok', ipv6: '1' }, '0.0.0.0/0, ::/0'],
    ]) {
      const out = await generate(query, { cloudflare: network() });
      assert.equal(out.status, 200);
      assert.equal(line(out.configs[0], 'AllowedIPs'), `AllowedIPs = ${expected}`, JSON.stringify(query));
      assert.deepEqual(budgetWarnings(out.body), []);
      assert.equal(out.requests.filter((r) => r.hostname === OPENCCK).length, 0, 'no route list request');
    }
  });

  // Changed in 3.2.0 (spec 3.2.0 §5.4 p. 1): the WARP endpoint /48 of E6 is cut from the IPv6 routes; the IPv6
  // routes off E6 still pass unchanged and are never merged (spec R6 D5).
  test('ipv6=1: the IPv6 routes lose E6 and are otherwise unchanged, not merged', async () => {
    const out = await split({ presets: 'discord', ipv6: '1' });
    assert.equal(out.status, 200);
    const allowed = allowedOf(out.configs[0]);
    assert.deepEqual(allowed.filter((c) => c.includes(':')).sort(), LIST6_OFF_E6);
    assert.equal(coversSame(v4(allowed), LIST, { minus: E_FIXED }).ok, true);
  });
});

describe('route budget: a warning above 1000 routes, never a refusal (DECISIONS No. 29–31)', () => {
  // Even addresses are never adjacent: the aggregator cannot merge them.
  const unmergeable = (n, base = parse('198.18.0.0/32')[0]) => Array.from({ length: n }, (_, i) => {
    const a = base + 2 * i;
    return `${[24, 16, 8, 0].map((sh) => Math.floor(a / 2 ** sh) % 256).join('.')}/32`;
  });

  test('T-C4 1001 routes: 200, every route kept, one registration, a warning with the three numbers', async () => {
    const out = await split({ presets: 'discord' }, { list: unmergeable(1001) });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(allowedOf(out.configs[0]).length, 1001);
    assert.equal(out.requests.filter((r) => r.hostname === CLOUDFLARE).length, 3);
    assert.deepEqual(budgetWarnings(out.body), [
      'Route budget: 1001 IPv4 routes in AllowedIPs (1001 in the source lists) is above the limit of 1000; phones and routers may handle a list this long unstably.',
    ]);
  });

  test('exactly 1000 routes and 800 routes: no warning', async () => {
    for (const n of [1000, 800]) {
      freshLists();
      const out = await split({ presets: 'discord' }, { list: unmergeable(n) });
      assert.equal(out.status, 200);
      assert.equal(allowedOf(out.configs[0]).length, n);
      assert.deepEqual(budgetWarnings(out.body), [], `${n} routes`);
    }
  });

  test('the cut can push a list over: 999 routes and 162.158.0.0/15 → 1009 in AllowedIPs, a warning', async () => {
    const out = await split({ presets: 'discord' }, { list: [...unmergeable(999), '162.158.0.0/15'] });
    assert.equal(out.status, 200);
    assert.equal(allowedOf(out.configs[0]).length, 1009);
    assert.equal(budgetWarnings(out.body).length, 1);
    assert.match(budgetWarnings(out.body)[0], /^Route budget: 1009 IPv4 routes in AllowedIPs \(1000 in the source lists\)/);
  });

  test('mergeable routes count after merging: 1200 aligned /32 pairs → 600 routes, no warning', async () => {
    const pairs = Array.from({ length: 600 }, (_, i) => [`198.18.${Math.floor(i / 64)}.${(i % 64) * 4}/32`, `198.18.${Math.floor(i / 64)}.${(i % 64) * 4 + 1}/32`]).flat();
    const out = await split({ presets: 'discord' }, { list: pairs });
    assert.equal(out.status, 200);
    assert.equal(allowedOf(out.configs[0]).length, 600);
    assert.deepEqual(budgetWarnings(out.body), []);
  });
});

describe('the invariants on the new path', () => {
  test('I6: split without ipv6 is IPv4-only and aggregated', async () => {
    const out = await split({ presets: 'discord' });
    const allowed = line(out.configs[0], 'AllowedIPs');
    assert.doesNotMatch(allowed, /:/);
    assert.match(allowed, /\b10\.0\.0\.0\/8\b/);
    assert.match(allowed, /\b203\.0\.113\.4\/31\b/);
  });

  test('I7: mobile=1 + ipv6=1 split has no IPv6 in AllowedIPs', async () => {
    const out = await split({ presets: 'discord', mobile: '1', ipv6: '1' });
    assert.equal(out.status, 200);
    assert.doesNotMatch(line(out.configs[0], 'AllowedIPs'), /:/);
    assert.doesNotMatch(line(out.configs[0], 'Address'), /:/);
  });

  test('I8: mobile=1 + router=1 split keeps the router caps, every config, routes aggregated', async () => {
    for (const mode of ['legacy', 'awg2', 'awg3', 'awg31']) {
      const out = await split({ mode, presets: 'discord', mobile: '1', router: '1', count: '3' });
      assert.equal(out.status, 200, mode);
      for (const conf of out.configs) {
        assert.equal(line(conf, 'Jc'), 'Jc = 2', mode);
        assert.equal(line(conf, 'Jmin'), 'Jmin = 64', mode);
        assert.equal(line(conf, 'Jmax'), 'Jmax = 128', mode);
        assert.match(line(conf, 'AllowedIPs'), /\b10\.0\.0\.0\/8\b/);
      }
    }
  });

  test('T-C5 / I10: vpn:// carries the same .conf, and allowed_ips equals AllowedIPs', async () => {
    const out = await split({ presets: 'discord', link: '1' });
    assert.equal(out.status, 200);
    const last = JSON.parse(decodeVpnLink(out.body.configs[0].vpnLink).containers[0].awg.last_config);
    assert.equal(last.config, out.configs[0]);
    assert.deepEqual(last.allowed_ips, allowedOf(out.configs[0]));
    // 162.158.0.0/15 without E_fixed (10 blocks, discord.com inside), 188.114.96.0/22, 10.0.0.0/8, 203.0.113.4/31,
    // 198.51.100.0/24.
    assert.equal(last.allowed_ips.length, 14);
  });

  test('3.1.8 degradation: ipv6=1 and a registration without IPv6 → IPv4 routes only, still cut and aggregated', async () => {
    const out = await split({ presets: 'discord', ipv6: '1', count: '2' },
      { registrations: [registrationAnswer({ v6: null }), registrationAnswer()] });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const first = allowedOf(out.configs[0]);
    assert.equal(first.some((c) => c.includes(':')), false);
    assert.equal(coversSame(first, LIST, { minus: E_FIXED }).ok, true);
    assert.deepEqual(allowedOf(out.configs[1]).filter((c) => c.includes(':')).sort(), LIST6_OFF_E6);
    assert.equal(warnings(out.body).filter((w) => w.startsWith('WARP registration returned no IPv6')).length, 1);
  });
});

// The same invariants on the catalogue path (prompt 3.2.0: I10 and the 3.1.8 degradation on both paths): GitHub
// takes its networks from the committed snapshot, no list is asked.
describe('the catalogue path (GitHub from the snapshot): I10 and the 3.1.8 degradation', () => {
  const github = getCatalog().plan(['github']).snapshot.presets.github;

  test('T-C5 / I10: vpn:// carries the same .conf, and allowed_ips equals AllowedIPs', async () => {
    const out = await split({ presets: 'github', link: '1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const last = JSON.parse(decodeVpnLink(out.body.configs[0].vpnLink).containers[0].awg.last_config);
    assert.equal(last.config, out.configs[0]);
    assert.deepEqual(last.allowed_ips, allowedOf(out.configs[0]));
    assert.equal(coversSame(last.allowed_ips, github.cidrs4, { minus: E_FIXED }).ok, true);
  });

  test('3.1.8 degradation: ipv6=1 and a registration without IPv6 → IPv4 routes only in that config', async () => {
    const six = github.cidrs6;
    assert.ok(six.length && six.every((c) => !c.startsWith('2606:4700:d')), 'GitHub has IPv6 networks off E6');
    const out = await split({ presets: 'github', ipv6: '1', count: '2' },
      { registrations: [registrationAnswer({ v6: null }), registrationAnswer()] });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const first = allowedOf(out.configs[0]);
    assert.equal(first.some((c) => c.includes(':')), false);
    assert.equal(coversSame(first, github.cidrs4, { minus: E_FIXED }).ok, true);
    assert.deepEqual(allowedOf(out.configs[1]).filter((c) => c.includes(':')).sort(), [...six].sort());
    assert.equal(warnings(out.body).filter((w) => w.startsWith('WARP registration returned no IPv6')).length, 1);
  });
});
