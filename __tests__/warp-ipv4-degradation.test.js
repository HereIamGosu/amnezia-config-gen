// __tests__/warp-ipv4-degradation.test.js
// A Cloudflare registration without a usable IPv6 address (absent, empty or invalid) gives a working IPv4-only
// config instead of a 500 (3.1.8, R5 4.B without the MINOR fields): the config of ipv6=0 (I6), one fixed English
// warning per answer, no new response fields. mobile=1 is IPv4-only anyway (I7) and gets no warning. Every other
// field of the config is what an answer with IPv6 gives. No network: the harness answers the API requests.

'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { inflateSync } = require('node:zlib');
const { generate, registrationAnswer, parseConf, labSnapshot, LAB_POOL, labProvider } = require('./helpers/warp-harness');

const CLOUDFLARE = 'api.cloudflareclient.com';
const OPENCCK = 'iplist.opencck.org';
const MODES = ['legacy', 'awg2', 'awg3', 'awg31'];
const AWG_MODES = new Set(['awg2', 'awg3', 'awg31']);
const WARNING = 'WARP registration returned no IPv6 address';
// Differ between two identical requests by design: keys, junk sizes and CPS packets.
const RANDOM_BY_DESIGN = new Set(['PrivateKey', 'Jc', 'Jmin', 'Jmax', 'I1', 'I2', 'I3', 'I4', 'I5']);

const NO_IPV6 = [
  ['absent', registrationAnswer({ v6: null })],
  ['empty', registrationAnswer({ v6: '' })],
  ['not an address', registrationAnswer({ v6: 'not-an-address' })],
];

const line = (conf, key) => conf.split('\n').find((l) => l.startsWith(`${key} =`));
const warnings = (body) => [].concat(body.warning ?? []);
const ipv6Warnings = (body) => warnings(body).filter((w) => w.startsWith(WARNING));

const decodeVpnLink = (link) => {
  const buf = Buffer.from(link.slice('vpn://'.length).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return JSON.parse(inflateSync(buf.slice(4)).toString('utf8'));
};

/** Fields of two configs that differ, random-by-design keys aside; asserts the same layout but for `allowed`. */
const differingFields = (a, b) => {
  const out = [];
  const pa = parseConf(a);
  const pb = parseConf(b);
  assert.deepEqual(pa.map((s) => [s.name, s.fields.map(([k]) => k)]), pb.map((s) => [s.name, s.fields.map(([k]) => k)]), 'same sections and key order');
  pa.forEach((section, i) => section.fields.forEach(([key, value], j) => {
    if (!RANDOM_BY_DESIGN.has(key) && value !== pb[i].fields[j][1]) out.push(`${section.name}.${key}`);
  }));
  return out;
};

/** WARP fields and I1/I5 that the degradation must not touch (patterns of invariant-i11-lab-auto.test.js). */
const assertWarpFields = (conf, mode) => {
  assert.match(conf, /^I1 = /m, 'I1');
  assert.match(conf, /^MTU = 1280$/m, 'I4');
  if (AWG_MODES.has(mode)) {
    for (const n of [1, 2, 3, 4]) {
      assert.match(conf, new RegExp(`^S${n} = 0$`, 'm'), 'I2');
      assert.match(conf, new RegExp(`^H${n} = ${n}$`, 'm'), 'I3');
    }
  }
  if (mode === 'awg2') {
    const iface = conf.split(/\n\[Peer\]/)[0];
    let prev = -1;
    for (const f of ['PrivateKey', 'Address', 'DNS', 'MTU', 'Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4', 'I1']) {
      const idx = iface.indexOf(`\n${f} =`);
      assert.ok(idx > prev, `I5: ${f}`);
      prev = idx;
    }
  }
};

/** Answers registration k (POST, PATCH, GET) with answers[k - 1]; route lists with `other(request)`. */
const perRegistration = (answers, other = () => ({ status: 500, body: '' })) => {
  let cloudflareCalls = 0;
  return (_n, request) => {
    if (request.hostname !== CLOUDFLARE) return other(request);
    cloudflareCalls += 1;
    return answers[Math.min(Math.ceil(cloudflareCalls / 3), answers.length) - 1];
  };
};

describe('a registration without IPv6 gives an IPv4-only config, not a 500', () => {
  for (const [kind, answer] of NO_IPV6) {
    for (const mode of MODES) {
      test(`${mode}, IPv6 ${kind}: 200 with an IPv4-only Address and route, one warning`, async () => {
        const out = await generate({ mode }, { cloudflare: answer });
        assert.equal(out.status, 200, JSON.stringify(out.body));
        assert.equal(out.body.success, true);
        const conf = out.configs[0];
        // `/32` or a bare address, as the mode's template writes it with IPv6 (compared field by field below).
        assert.match(line(conf, 'Address'), /^Address = 172\.16\.0\.2(\/32)?$/);
        assert.equal(line(conf, 'AllowedIPs'), 'AllowedIPs = 0.0.0.0/0');
        assertWarpFields(conf, mode);
        assert.deepEqual(ipv6Warnings(out.body), [`${WARNING} for config(s) 1: the config is IPv4-only.`]);
      });
    }
  }

  for (const mode of MODES) {
    test(`${mode}, plainAddress=1: the bare IPv4 address`, async () => {
      const out = await generate({ mode, plainAddress: '1' }, { cloudflare: registrationAnswer({ v6: null }) });
      assert.equal(out.status, 200);
      assert.equal(line(out.configs[0], 'Address'), 'Address = 172.16.0.2');
    });
  }

  test('no new response fields: no `registration`, no `configs[i].ipv6`', async () => {
    const out = await generate({ mode: 'awg2', count: '2' }, { cloudflare: registrationAnswer({ v6: null }) });
    assert.equal(out.status, 200);
    assert.equal('registration' in out.body, false);
    for (const config of out.body.configs) assert.equal('ipv6' in config, false);
  });

  test('a registration with IPv6 keeps its answer: no warning, IPv6 Address', async () => {
    const out = await generate({ mode: 'awg2' }, { cloudflare: registrationAnswer() });
    assert.equal(out.status, 200);
    assert.deepEqual(ipv6Warnings(out.body), []);
    assert.match(line(out.configs[0], 'Address'), /^Address = 172\.16\.0\.2(\/32)?, fd01::2(\/128)?$/);
  });
});

describe('only the Address and the IPv6 route differ from an answer with IPv6 (I6: the config of ipv6=0)', () => {
  for (const mode of MODES) {
    test(`${mode}: without IPv6 = with IPv6 and ipv6=0, field by field`, async () => {
      const withV6 = await generate({ mode }, { cloudflare: registrationAnswer() });
      const withoutV6 = await generate({ mode }, { cloudflare: registrationAnswer({ v6: null }) });
      assert.deepEqual(differingFields(withV6.configs[0], withoutV6.configs[0]), ['Interface.Address']);
    });

    test(`${mode}, ipv6=1: no ::/0 without an IPv6 address, the same warning`, async () => {
      const withV6 = await generate({ mode, ipv6: '1' }, { cloudflare: registrationAnswer() });
      const withoutV6 = await generate({ mode, ipv6: '1' }, { cloudflare: registrationAnswer({ v6: null }) });
      assert.equal(withoutV6.status, 200);
      assert.equal(line(withV6.configs[0], 'AllowedIPs'), 'AllowedIPs = 0.0.0.0/0, ::/0');
      assert.equal(line(withoutV6.configs[0], 'AllowedIPs'), 'AllowedIPs = 0.0.0.0/0');
      assert.deepEqual(differingFields(withV6.configs[0], withoutV6.configs[0]), ['Interface.Address', 'Peer.AllowedIPs']);
      assert.equal(ipv6Warnings(withoutV6.body).length, 1);
    });
  }

  test('split, ipv6=1: IPv6 CIDRs of the route lists are dropped, IPv4 CIDRs kept', async () => {
    const lists = (request) => {
      if (request.hostname !== OPENCCK) return { status: 500, body: '' };
      const cidrs = request.path.includes('data=cidr6') ? ['2001:db8::/32'] : ['203.0.113.0/24'];
      return { status: 200, body: JSON.stringify({ 'discord.com': cidrs }) };
    };
    const query = { mode: 'awg2', ipv6: '1', routeMode: 'split', presets: 'discord' };
    const withV6 = await generate(query, { cloudflare: perRegistration([registrationAnswer()], lists) });
    const withoutV6 = await generate(query, { cloudflare: perRegistration([registrationAnswer({ v6: null })], lists) });
    assert.equal(withV6.status, 200, JSON.stringify(withV6.body));
    assert.match(line(withV6.configs[0], 'AllowedIPs'), /2001:db8::\/32/, 'the lists did answer with IPv6');
    assert.equal(withoutV6.status, 200, JSON.stringify(withoutV6.body));
    const allowed = line(withoutV6.configs[0], 'AllowedIPs');
    assert.doesNotMatch(allowed, /:/);
    assert.match(allowed, /203\.0\.113\.0\/24/);
  });
});

describe('several configs in one answer', () => {
  test('count=3, the second registration without IPv6: only it is IPv4-only, one warning naming it', async () => {
    const answers = [registrationAnswer(), registrationAnswer({ v6: null }), registrationAnswer()];
    const out = await generate({ mode: 'awg2', count: '3', ipv6: '1' }, { cloudflare: perRegistration(answers) });
    assert.equal(out.status, 200);
    assert.equal(out.configs.length, 3);
    assert.match(line(out.configs[0], 'Address'), /:/);
    assert.doesNotMatch(line(out.configs[1], 'Address'), /:/);
    assert.match(line(out.configs[2], 'Address'), /:/);
    assert.equal(line(out.configs[0], 'AllowedIPs'), 'AllowedIPs = 0.0.0.0/0, ::/0');
    assert.equal(line(out.configs[1], 'AllowedIPs'), 'AllowedIPs = 0.0.0.0/0');
    assert.equal(line(out.configs[2], 'AllowedIPs'), 'AllowedIPs = 0.0.0.0/0, ::/0');
    assert.deepEqual(ipv6Warnings(out.body), [`${WARNING} for config(s) 2: the config is IPv4-only.`]);
  });

  test('count=3, no registration with IPv6: one warning naming all three', async () => {
    const out = await generate({ mode: 'awg2', count: '3' }, { cloudflare: registrationAnswer({ v6: null }) });
    assert.equal(out.status, 200);
    assert.deepEqual(ipv6Warnings(out.body), [`${WARNING} for config(s) 1, 2, 3: the config is IPv4-only.`]);
  });
});

describe('mobile=1 is IPv4-only anyway (I7)', () => {
  for (const mode of MODES) {
    test(`${mode}: the config of mobile=1 with IPv6, and no warning`, async () => {
      const withV6 = await generate({ mode, mobile: '1', ipv6: '1' }, { cloudflare: registrationAnswer() });
      const withoutV6 = await generate({ mode, mobile: '1', ipv6: '1' }, { cloudflare: registrationAnswer({ v6: null }) });
      assert.equal(withoutV6.status, 200);
      assert.deepEqual(differingFields(withV6.configs[0], withoutV6.configs[0]), []);
      assert.deepEqual(ipv6Warnings(withoutV6.body), []);
    });
  }
});

describe('router caps hold without IPv6 (I8)', () => {
  const num = (conf, key) => Number(new RegExp(`^${key} = (\\d+)$`, 'm').exec(conf)?.[1]);
  for (const mode of MODES) {
    for (const extra of [{ router: '1' }, { mobile: '1', router: '1' }]) {
      test(`${mode}, ${new URLSearchParams(extra)}: Jc <= 2, 40 <= Jmin <= 64, Jmin + 64 <= Jmax <= 128 in every config`, async () => {
        const out = await generate({ mode, count: '3', ...extra }, { cloudflare: registrationAnswer({ v6: null }) });
        assert.equal(out.status, 200);
        assert.equal(out.configs.length, 3);
        for (const conf of out.configs) {
          const [jc, jmin, jmax] = ['Jc', 'Jmin', 'Jmax'].map((key) => num(conf, key));
          assert.ok(jc >= 1 && jc <= 2, `Jc ${jc}`);
          assert.ok(jmin >= 40 && jmin <= 64, `Jmin ${jmin}`);
          assert.ok(jmax <= 128 && jmax - jmin >= 64, `Jmin ${jmin} Jmax ${jmax}`);
          assert.doesNotMatch(line(conf, 'Address'), /:/);
          assertWarpFields(conf, mode);
        }
      });
    }
  }
});

describe('the rest of the request holds', () => {
  test('link=1: vpn:// carries the same IPv4-only .conf (I10)', async () => {
    const out = await generate({ mode: 'awg2', link: '1' }, { cloudflare: registrationAnswer({ v6: null }) });
    assert.equal(out.status, 200);
    const obj = decodeVpnLink(out.body.configs[0].vpnLink);
    assert.equal(JSON.parse(obj.containers[0].awg.last_config).config, out.configs[0]);
  });

  test('Lab Auto: the Lab endpoint stays, the Address is IPv4-only (I11)', async () => {
    const out = await generate({ mode: 'awg2', endpointMode: 'lab' }, {
      lab: labProvider(labSnapshot(LAB_POOL)),
      cloudflare: registrationAnswer({ v6: null }),
    });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.configs[0].endpointSource, 'lab');
    assert.doesNotMatch(line(out.configs[0], 'Address'), /:/);
    assert.equal(ipv6Warnings(out.body).length, 1);
  });

  test('an invalid IPv4 address is still a failure', async () => {
    for (const v4 of ['', '300.1.1.1', 'fd01::2']) {
      const out = await generate({ mode: 'awg2' }, { cloudflare: registrationAnswer({ v4 }) });
      assert.notEqual(out.status, 200, `v4 ${JSON.stringify(v4)}`);
      assert.equal(out.body.success, false);
    }
  });
});
