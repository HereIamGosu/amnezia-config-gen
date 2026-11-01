// __tests__/ipcatalog-build.test.js
// The catalogue builder (spec 3.2.0 §4.2, §8) on fixtures, without network: every parser (goog.json, cloud.json,
// cidr.txt, ips-v4/ips-v6, GitHub meta without actions, Zoom.txt, ipverse with comments, iptoasn ranges, a DoH answer
// with a CNAME chain, a rekryt/iplist portal config), the Google recipe "asn minus cloud.json", the address filters,
// `stale` on a failing source, the 30-day `seen4`, DoH retries on 429, the concurrency limit, the summary verdicts
// and determinism with a fixed `now`.

'use strict';

const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { describe, test } = require('node:test');
const { parseCidrText, parseGoogleRanges, parseGithubMeta } = require('../scripts/ipcatalog/sources/official');
const { parseIpverse, parseIptoasn, ipverseUrl, IPTOASN_URLS } = require('../scripts/ipcatalog/sources/asn');
const { parseDohAnswer, ECS_POINTS } = require('../scripts/ipcatalog/sources/doh');
const { parsePortalTree, parsePortalConfig, commitUrl, treeUrl, rawUrl } = require('../scripts/ipcatalog/sources/portal');
const { createGet, mapPool, HttpError } = require('../scripts/ipcatalog/lib/net');
const { buildCatalog } = require('../scripts/ipcatalog/catalog');
const { renderReport, coverageVerdicts } = require('../scripts/ipcatalog/report');
const { parseSnapshot } = require('../src/server/ipCatalog/snapshot');
const { checkSnapshot } = require('../src/server/ipCatalog/checkSnapshot');
const { coversSame } = require('./helpers/cidr-coverage');

const NOW = new Date('2026-11-05T10:00:00Z');
const SHA = 'a'.repeat(40);

const GOOG = JSON.stringify({ syncToken: '1', prefixes: [{ ipv4Prefix: '8.8.4.0/24' }, { ipv4Prefix: '8.8.8.0/24' }, { ipv6Prefix: '2001:4860::/32' }] });
const CLOUD = JSON.stringify({ prefixes: [{ ipv4Prefix: '34.64.0.0/10', service: 'Google Cloud' }, { ipv6Prefix: '2600:1900::/28', scope: 'us' }] });
const FIXTURES = {
  'https://www.gstatic.com/ipranges/goog.json': GOOG,
  'https://www.gstatic.com/ipranges/cloud.json': CLOUD,
  'https://core.telegram.org/resources/cidr.txt': '91.108.56.0/22\n91.108.4.0/22\n\n149.154.160.0/20\n2001:b28:f23d::/48\n',
  'https://www.cloudflare.com/ips-v4': '173.245.48.0/20\n162.158.0.0/15\n188.114.96.0/20\n',
  // Not in order: the snapshot must sort it.
  'https://www.cloudflare.com/ips-v6': '2606:4700::/32\n2400:cb00::/32\n',
  'https://api.github.com/meta': JSON.stringify({
    web: ['140.82.112.0/20', '2a0a:a440::/29'], api: ['140.82.112.0/20'], git: ['192.30.252.0/22'], pages: ['185.199.108.0/22'],
    actions: ['4.148.0.0/16', '13.64.0.0/11'],
  }),
  'https://assets.zoom.us/docs/ipranges/Zoom.txt': '# Zoom\n3.7.35.0/25\n3.21.137.128/25\n',
  [ipverseUrl(15169, 4)]: '# AS15169 GOOGLE\n8.8.4.0/24\n8.8.8.0/24\n34.64.0.0/10\n142.250.0.0/15\n',
  [ipverseUrl(15169, 6)]: '2001:4860::/32\n2600:1900::/28\n',
  [ipverseUrl(32590, 4)]: '# AS32590\n155.133.224.0/19\n208.64.200.0/22\n',
  [ipverseUrl(99999, 4)]: '8.0.0.0/7\n',
  [commitUrl()]: JSON.stringify({ sha: SHA }),
  [treeUrl(SHA)]: JSON.stringify({ tree: [{ path: 'config/torrent/rutracker.org.json', type: 'blob' }, { path: 'README.md', type: 'blob' }] }),
  [rawUrl(SHA, 'config/torrent/rutracker.org.json')]: JSON.stringify({ domains: ['rutracker.org', 'bt.t-ru.org', '*.wild.org', 'RuTracker.org.'], ip4: ['6.6.6.6'] }),
};
// DoH answers: name → type → subnet (or '*') → answer records.
const DOH = {
  'rutracker.org': { A: { '95.165.0.0/24': [['rutracker.org', 1, '104.21.32.39']], '*': [['rutracker.org', 1, '172.67.182.196']] },
    // Two AAAA records: their order in the answer must not change the snapshot (determinism test below).
    AAAA: { '*': [['rutracker.org', 28, '2606:4700:3036::ac43:b6c4'], ['rutracker.org', 28, '2606:4700:3033:0:0:0:6815:2027']] } },
  'bt.t-ru.org': { A: { '*': [['bt.t-ru.org.', 5, 'cdn.example.net.'], ['cdn.example.net.', 1, '104.21.40.1'], ['other.example.', 1, '9.9.9.9']] } },
  'rutracker.me': { A: { '*': [['rutracker.me', 1, '188.114.97.3']] } },
  'kinozal.tv': { A: { '*': [['kinozal.tv', 1, '127.0.0.1']] } },
  'telegram.org': { A: { '*': [['telegram.org', 1, '149.154.167.99']] } },
  'steampowered.com': { A: { '*': [['steampowered.com', 1, '23.32.5.6']] } },
  'google.com': { A: { '*': [['google.com', 1, '142.250.74.46'], ['google.com', 1, '34.64.1.1']] } },
};
const dohAnswer = (name, type, subnet) => {
  const byType = (DOH[name] || {})[type];
  if (!DOH[name]) return { Status: 3 };
  const records = (byType && (byType[subnet] || byType['*'])) || [];
  return { Status: 0, Answer: records.map(([n, t, data]) => ({ name: n, type: t, TTL: 60, data })), edns_client_subnet: subnet };
};

/** A fake GET: fixtures by URL, DoH answers by name/type/subnet, 404 for anything else; `overrides` win. */
const fakeNet = ({ overrides = {}, reverseDoh = false } = {}) => {
  const calls = [];
  const get = async (url) => {
    calls.push(url);
    if (Object.prototype.hasOwnProperty.call(overrides, url)) {
      const v = overrides[url];
      if (v instanceof Error) throw v;
      return typeof v === 'function' ? v() : v;
    }
    const doh = /^https:\/\/dns\.google\/resolve\?name=([^&]+)&type=(A|AAAA)&edns_client_subnet=(.+)$/.exec(url);
    if (doh) {
      const answer = dohAnswer(decodeURIComponent(doh[1]), doh[2], decodeURIComponent(doh[3]));
      if (reverseDoh && answer.Answer) answer.Answer.reverse();
      return JSON.stringify(answer);
    }
    if (FIXTURES[url] === undefined) throw new HttpError(url, 404);
    return FIXTURES[url];
  };
  return { get, calls };
};

const PRESETS = {
  google: { domains: ['google.com'], ip: [{ from: 'asn', asns: [15169], minus: 'google-cloud' }] },
  telegram: { domains: ['telegram.org'], ip: [{ from: 'official', list: 'telegram' }] },
  cloudflare: { domains: [], ip: [{ from: 'official', list: 'cloudflare' }] },
  github: { domains: [], ip: [{ from: 'official', list: 'github' }] },
  zoom: { domains: [], ip: [{ from: 'official', list: 'zoom' }] },
  rutracker: { domains: ['rutracker.org', 'rutracker.me'], ip: [{ from: 'portal', portals: ['rutracker.org'] }, { from: 'resolve' }] },
  kinozal: { domains: ['kinozal.tv'], ip: [{ from: 'resolve' }] },
  steam: { domains: ['steampowered.com'], ip: [{ from: 'asn', asns: [32590] }] },
  spotify: { domains: [], ip: [{ from: 'asn', asns: [8403] }] },
  wideasn: { domains: [], ip: [{ from: 'asn', asns: [99999] }] },
  control4: { domains: [], ip: [{ from: 'static', cidrs4: ['75.2.70.75/32'], source: 'DNS', date: '2026-10-01' }] },
  vk: { domains: ['vk.com'] },
  youtube: { domains: ['youtube.com'], legacy: {}, ip: [{ from: 'asn', asns: [15169], minus: 'google-cloud' }] },
};
const build = (opts = {}) => buildCatalog({
  presets: PRESETS, retired: ['vk'], now: NOW, get: fakeNet(opts.net).get, liveRoutes4: async () => 621, ...opts,
});

describe('parsers', () => {
  test('cidr text: comments and blank lines skipped, families split (cidr.txt, ips-v4/ips-v6, Zoom.txt)', () => {
    assert.deepEqual(parseCidrText('# x\n91.108.4.0/22 # tail\n\n2001:b28:f23d::/48\r\n'), { cidrs4: ['91.108.4.0/22'], cidrs6: ['2001:b28:f23d::/48'] });
  });

  test('goog.json / cloud.json: ipv4Prefix and ipv6Prefix', () => {
    assert.deepEqual(parseGoogleRanges(GOOG), { cidrs4: ['8.8.4.0/24', '8.8.8.0/24'], cidrs6: ['2001:4860::/32'] });
    assert.throws(() => parseGoogleRanges('{}'));
  });

  test('GitHub meta: web, api, git, pages — never actions', () => {
    const out = parseGithubMeta(FIXTURES['https://api.github.com/meta']);
    assert.deepEqual(out.cidrs4, ['140.82.112.0/20', '140.82.112.0/20', '192.30.252.0/22', '185.199.108.0/22']);
    assert.deepEqual(out.cidrs6, ['2a0a:a440::/29']);
    assert.ok(!out.cidrs4.includes('4.148.0.0/16'));
  });

  test('ipverse: comment lines skipped', () => {
    assert.deepEqual(parseIpverse('# AS1\n\n1.0.0.0/24\n# x\n2.0.0.0/16\n'), ['1.0.0.0/24', '2.0.0.0/16']);
  });

  test('iptoasn: ranges of the asked AS become aligned CIDRs', () => {
    const tsv = '1.0.0.0\t1.0.0.255\t13335\tUS\tCLOUDFLARENET\n155.133.224.0\t155.133.255.255\t32590\tUS\tVALVE\n10.0.0.0\t10.0.0.2\t32590\tUS\tVALVE\n';
    const out = parseIptoasn(tsv, new Set([32590]), 4);
    assert.deepEqual(out.get(32590), ['155.133.224.0/19', '10.0.0.0/31', '10.0.0.2/32']);
    const six = parseIptoasn('2a01:b740::\t2a01:b740:ffff:ffff:ffff:ffff:ffff:ffff\t714\tUS\tAPPLE\n', new Set([714]), 6);
    assert.deepEqual(six.get(714), ['2a01:b740:0:0:0:0:0:0/32']);
  });

  test('DoH answer: the CNAME chain from the asked name, records of other owners ignored, NXDOMAIN empty', () => {
    const answer = JSON.stringify(dohAnswer('bt.t-ru.org', 'A', '85.214.0.0/24'));
    assert.deepEqual(parseDohAnswer(answer, 'bt.t-ru.org', 'A'), ['104.21.40.1/32']);
    const six = JSON.stringify(dohAnswer('rutracker.org', 'AAAA', 'x'));
    assert.deepEqual(parseDohAnswer(six, 'rutracker.org', 'AAAA'), ['2606:4700:3036::ac43:b6c4/128', '2606:4700:3033::6815:2027/128'], 'canonical text');
    assert.deepEqual(parseDohAnswer(JSON.stringify({ Status: 3 }), 'nope.example', 'A'), []);
    assert.deepEqual(parseDohAnswer(JSON.stringify({ Status: 2, Answer: [{ name: 'a', type: 1, data: '1.2.3.4' }] }), 'a', 'A'), []);
  });

  test('rekryt/iplist: the tree gives portal paths, a config gives clean unique domains (ip4 ignored)', () => {
    const tree = parsePortalTree(FIXTURES[treeUrl(SHA)]);
    assert.deepEqual([...tree], [['rutracker.org', 'config/torrent/rutracker.org.json']]);
    assert.deepEqual(parsePortalConfig(FIXTURES[rawUrl(SHA, 'config/torrent/rutracker.org.json')]), ['bt.t-ru.org', 'rutracker.org']);
  });
});

describe('network: retries and the concurrency limit', () => {
  test('429 is retried after 1 s and 2 s; a 404 fails at once; five network failures give up after 1+2+4+8 s', async () => {
    const delays = [];
    const sleep = async (ms) => { delays.push(ms); };
    let n = 0;
    const flaky = createGet({ sleep, fetchText: async (url) => { n += 1; if (n <= 2) throw new HttpError(url, 429); return 'ok'; } });
    assert.equal(await flaky('https://dns.google/resolve?name=a'), 'ok');
    assert.deepEqual(delays, [1000, 2000]);

    delays.length = 0;
    let missing = 0;
    const notFound = createGet({ sleep, fetchText: async (url) => { missing += 1; throw new HttpError(url, 404); } });
    await assert.rejects(notFound('https://x/'), /HTTP 404/);
    assert.equal(missing, 1);
    assert.deepEqual(delays, []);

    let down = 0;
    const offline = createGet({ sleep, fetchText: async () => { down += 1; throw new TypeError('fetch failed'); } });
    await assert.rejects(offline('https://x/'), /fetch failed/);
    assert.equal(down, 5);
    assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
  });

  test('mapPool keeps at most `limit` tasks in flight and the input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapPool(Array.from({ length: 30 }, (_, i) => i), 8, async (i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
      return i * 2;
    });
    assert.equal(peak, 8);
    assert.deepEqual(out, Array.from({ length: 30 }, (_, i) => i * 2));
  });
});

describe('buildCatalog', () => {
  test('a sound build: every non-retired preset, parsable, the recipes applied', async () => {
    const { text, doc, summary } = await build();
    assert.equal(parseSnapshot(text).ok, true);
    assert.deepEqual(checkSnapshot(text, { presets: PRESETS, retired: ['vk'] }), [], 'the build passes the §4.4 checks, order included');
    assert.deepEqual(Object.keys(doc.presets).sort(), Object.keys(PRESETS).filter((k) => k !== 'vk').sort());
    assert.equal(doc.builtAt, '2026-11-05T10:00:00Z');
    assert.deepEqual(summary.failed, []);
    assert.deepEqual(summary.stale, []);
    const p = doc.presets;
    assert.deepEqual(p.telegram.cidrs4, ['149.154.160.0/20', '91.108.4.0/22', '91.108.56.0/22']);
    assert.deepEqual(p.telegram.cidrs6, ['2001:b28:f23d::/48']);
    assert.equal(p.telegram.precision, 'exact');
    assert.deepEqual(p.telegram.coverage, { covered: 1, reference: 1 });
    assert.deepEqual(p.cloudflare.cidrs4, ['162.158.0.0/15', '173.245.48.0/20', '188.114.96.0/20'], 'no endpoint cut in the snapshot');
    assert.deepEqual(p.github.cidrs4, ['140.82.112.0/20', '185.199.108.0/22', '192.30.252.0/22']);
    assert.deepEqual(p.zoom.cidrs4, ['3.21.137.128/25', '3.7.35.0/25']);
    assert.deepEqual(p.control4.cidrs4, ['75.2.70.75/32']);
    assert.equal(p.youtube.legacy, true);
    assert.equal(p.youtube.liveRoutes4, 621);
  });

  test('the Google recipe: the AS announcements minus cloud.json, both families', async () => {
    const { doc } = await build();
    assert.equal(coversSame(doc.presets.google.cidrs4, ['8.8.4.0/24', '8.8.8.0/24', '34.64.0.0/10', '142.250.0.0/15'], { minus: ['34.64.0.0/10'] }).ok, true);
    assert.deepEqual(doc.presets.google.cidrs6, ['2001:4860::/32']);
    assert.deepEqual(doc.presets.google.coverage, { covered: 1, reference: 2 }, 'the GCP address of google.com is not covered');
    assert.deepEqual(doc.presets.youtube.fallback.cidrs4, doc.presets.google.cidrs4);
  });

  test('portal + resolve: domains of the portal and of the preset, every ECS point, CNAME followed', async () => {
    const net = fakeNet();
    const { doc } = await buildCatalog({ presets: { rutracker: PRESETS.rutracker }, now: NOW, get: net.get });
    const r = doc.presets.rutracker;
    assert.deepEqual(r.cidrs4, ['104.21.32.39/32', '104.21.40.1/32', '172.67.182.196/32', '188.114.97.3/32']);
    assert.deepEqual(r.cidrs6, ['2606:4700:3033::6815:2027/128', '2606:4700:3036::ac43:b6c4/128']);
    assert.equal(r.precision, 'approx');
    assert.deepEqual(Object.keys(r.seen4), r.cidrs4);
    assert.ok(Object.values(r.seen4).every((d) => d === '2026-11-05'));
    for (const { subnet } of ECS_POINTS) {
      assert.ok(net.calls.includes(`https://dns.google/resolve?name=rutracker.org&type=A&edns_client_subnet=${encodeURIComponent(subnet)}`), subnet);
    }
    assert.ok(!net.calls.some((u) => u.includes('wild.org')), 'a wildcard entry of a portal is not a domain');
  });

  test('filters: a loopback answer, a too wide AS network and an unannounced AS leave no data, with a reason', async () => {
    const { doc, summary } = await build();
    assert.deepEqual(doc.presets.kinozal.cidrs4, []);
    assert.equal(doc.presets.kinozal.noData, 'no_ipv4_addresses');
    assert.deepEqual(summary.presets.kinozal.dropped, {}, 'a bogon answer never enters seen4');
    assert.deepEqual(doc.presets.wideasn.cidrs4, []);
    assert.deepEqual(summary.presets.wideasn.dropped, { wide: 1 });
    assert.equal(doc.presets.spotify.noData, 'no_ipv4_addresses');
    assert.match(summary.presets.spotify.notes.join(' '), /AS8403 not announced/);
  });

  test('ipverse down → iptoasn; the AS answer is the same set', async () => {
    const tsv = '155.133.224.0\t155.133.255.255\t32590\tUS\tVALVE\n208.64.200.0\t208.64.203.255\t32590\tUS\tVALVE\n';
    const { doc } = await build({ net: { overrides: {
      [ipverseUrl(32590, 4)]: new HttpError(ipverseUrl(32590, 4), 503),
      [ipverseUrl(32590, 6)]: new HttpError(ipverseUrl(32590, 6), 503),
      [IPTOASN_URLS[4]]: zlib.gzipSync(tsv),
      [IPTOASN_URLS[6]]: zlib.gzipSync(''),
    } } });
    assert.deepEqual(doc.presets.steam.cidrs4, ['155.133.224.0/19', '208.64.200.0/22']);
    assert.equal(doc.sources['asn-32590'].via, 'iptoasn');
  });

  test('a failing source: the previous record stays, marked stale with the date of its data; none before → noData', async () => {
    const first = await build();
    const failing = { 'https://core.telegram.org/resources/cidr.txt': new HttpError('cidr.txt', 503) };
    const second = await build({ previous: { ...first.doc, builtAt: '2026-10-20T08:00:00Z' }, net: { overrides: failing } });
    assert.deepEqual(second.doc.presets.telegram.cidrs4, first.doc.presets.telegram.cidrs4);
    assert.equal(second.doc.presets.telegram.stale, '2026-10-20T08:00:00Z');
    assert.deepEqual(second.summary.stale, ['telegram']);
    assert.equal(second.summary.failed[0].key, 'telegram');
    assert.equal(second.doc.sources.telegram.ok, false);
    const fresh = await build({ net: { overrides: failing } });
    assert.equal(fresh.doc.presets.telegram.noData, 'source_failed');
    assert.deepEqual(fresh.summary.stale, []);
    assert.equal(fresh.summary.failed.length, 1);
  });

  test('the build command fails on a failed source or a stale record unless --allow-stale', async () => {
    const { exitCodeFor, parseArgs } = require('../scripts/ipcatalog/build');
    const first = await build();
    assert.equal(exitCodeFor(first.summary, parseArgs([])), 0);
    const stale = await build({ previous: first.doc, net: { overrides: { 'https://core.telegram.org/resources/cidr.txt': new HttpError('x', 500) } } });
    assert.equal(exitCodeFor(stale.summary, parseArgs([])), 1);
    assert.equal(exitCodeFor(stale.summary, parseArgs(['--allow-stale'])), 0);
    assert.deepEqual(parseArgs(['--report', 'r.md', '--now', '2026-11-05T10:00:00Z']).report, 'r.md');
    assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  });

  test('a transitional preset without a live answer keeps the previous liveRoutes4, stale', async () => {
    const first = await build();
    const second = await build({ previous: first.doc, liveRoutes4: async () => null });
    assert.equal(second.doc.presets.youtube.liveRoutes4, 621);
    assert.equal(second.doc.presets.youtube.stale, '2026-11-05T10:00:00Z');
    assert.deepEqual(second.summary.stale, ['youtube (live)']);
  });

  test('seen4: resolved addresses stay 30 days after they were last seen, older ones go', async () => {
    const first = await buildCatalog({ presets: { rutracker: PRESETS.rutracker }, now: NOW, get: fakeNet().get });
    const previous = { ...first.doc, presets: { rutracker: { ...first.doc.presets.rutracker, seen4: {
      '93.184.216.34/32': '2026-10-05', '93.184.216.35/32': '2026-10-06', '104.21.32.39/32': '2026-10-01',
    } } } };
    const { doc } = await buildCatalog({ presets: { rutracker: PRESETS.rutracker }, previous, now: NOW, get: fakeNet().get });
    const seen = doc.presets.rutracker.seen4;
    assert.equal(seen['93.184.216.34/32'], undefined, '31 days old');
    assert.equal(seen['93.184.216.35/32'], '2026-10-06', '30 days old');
    assert.equal(seen['104.21.32.39/32'], '2026-11-05', 'seen again today');
    assert.ok(doc.presets.rutracker.cidrs4.includes('93.184.216.35/32'));
  });

  test('determinism: the same answers and `now` give the same bytes, whatever the answer order', async () => {
    const a = await build();
    const b = await build({ net: { reverseDoh: true } });
    assert.equal(a.text, b.text);
    assert.match(a.text, /^\{\n {2}"builtAt": "2026-11-05T10:00:00Z",\n {2}"presets": \{/);
    assert.ok(a.text.endsWith('\n'));
    const later = await build({ now: new Date('2026-11-06T10:00:00Z') });
    assert.notEqual(later.text, a.text, 'the date is part of the snapshot');
  });
});

describe('summary', () => {
  test('a preset of the opencck era below 90 % coverage must stay transitional; the table and the quick pick', async () => {
    const { summary } = await build();
    const reconcile = {
      rutracker: { opencckIp4: ['104.21.32.39', '172.67.182.196', '1.1.1.1', '1.0.0.1'], ipnames: null, itdoginfo: null },
      telegram: { opencckIp4: null, ipnames: null, itdoginfo: ['149.154.160.0/20', '5.28.192.0/18'] },
    };
    const verdicts = coverageVerdicts(summary, reconcile);
    assert.equal(verdicts.rutracker.share, 0.5);
    assert.equal(verdicts.rutracker.verdict, 'переходный: покрытие < 90 %');
    // Changed in 3.2.0 (owner, 2026-11-01): telegram falls under the threshold by the second item of §9 p. 3; here it
    // has no reference, so the owner decides. cloudflare (no addresses in 3.1.9) stays outside the rule.
    assert.equal(verdicts.telegram.verdict, 'нет эталона — решает владелец');
    assert.equal(verdicts.cloudflare.verdict, null, 'not of the opencck era');
    const md = renderReport({ summary, reconcile, quickPick: ['telegram', 'youtube', 'cloudflare'], ecs: ECS_POINTS });
    assert.match(md, /\| rutracker \| portal rutracker\.org \+ resolve \| 4 \|.*\| НУЖЕН legacy: переходный: покрытие < 90 % \|/);
    assert.match(md, /- Ниже порога, но в каталоге — пометить `legacy` и пересобрать: [^\n]*rutracker \(50\.0 %\)/);
    assert.match(md, /- Ниже порога, переходные \(`legacy` в routePresets\.js\): нет\./);
    assert.match(md, /Состав: telegram, youtube, cloudflare\. Пресеты каталога вместе после агрегации и выреза: \d+; переходные по liveRoutes4: 621;/);
    assert.match(md, /- telegram: 2 сетей itdoginfo, у 1 начальный адрес внутри сетей пресета\./);
    assert.match(md, /moscow: `95\.165\.0\.0\/24`/);
  });
});
