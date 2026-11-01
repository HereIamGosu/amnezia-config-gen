// __tests__/cidr-aggregate.test.js
// aggregateCidrs (3.1.9, spec R6 4.2 and section 6, T-A1…T-A11): the IPv4 part of a route list becomes the smallest
// set of aligned blocks that covers exactly the same addresses, minus the prefixes the caller excludes. No
// over-coverage, IPv6 and malformed entries pass unchanged, the order is the default string sort of every version
// before 3.1.9. Coverage is checked by __tests__/helpers/cidr-coverage.js, which shares no code with the module.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const { aggregateCidrs } = require('../src/server/cidrAggregate');
const { expandPresetsToSites } = require('../src/server/routePresets');
const {
  coversSame, paint16, minimalCount, mulberry32, randomBlocks16, randomBlocksAnywhere, parse, addressCount,
  coversSame6, parse6,
} = require('./helpers/cidr-coverage');

const BASE_10 = parse('10.0.0.0/16')[0];
// WARP endpoint subnets of the 3.1.9 cut (decision No. 18), written out here so this file does not depend on it.
const E_FIXED = ['162.159.192.0/24', '162.159.193.0/24', '162.159.195.0/24', '162.159.204.0/24'];

const cidrsOf = (list, opts) => aggregateCidrs(list, opts).cidrs;

describe('T-A1…T-A3: exact and minimal coverage on generated cases', () => {
  test('T-A1 exact coverage inside 10.0.0.0/16 (500 seeded cases, 1–60 blocks, prefixes 16–32)', () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const random = mulberry32(seed);
      const input = randomBlocks16(random, BASE_10, 1 + Math.floor(random() * 60));
      const output = cidrsOf(input);
      assert.equal(coversSame(output, input).ok, true, `seed ${seed}`);
      assert.deepEqual(paint16(output, BASE_10), paint16(input, BASE_10), `seed ${seed}: painted cells`);
    }
  });

  test('T-A2 exact coverage over the whole space (200 seeded cases, prefixes 0–32, host bits set)', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = mulberry32(10_000 + seed);
      const input = randomBlocksAnywhere(random, 1 + Math.floor(random() * 40));
      const output = cidrsOf(input);
      const check = coversSame(output, input);
      assert.equal(check.ok, true, `seed ${seed}: differs at ${check.witness}`);
      assert.equal(addressCount(output), addressCount(input), `seed ${seed}: address count`);
    }
  });

  test('T-A3 the output is minimal: as many blocks as the prefix tree needs, no nested or mergeable pair', () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const random = mulberry32(seed);
      const input = randomBlocks16(random, BASE_10, 1 + Math.floor(random() * 60));
      const output = cidrsOf(input);
      assert.equal(output.length, minimalCount(paint16(input, BASE_10)), `seed ${seed}`);
      const blocks = output.map(parse).sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < blocks.length; i += 1) {
        const [prev, cur] = [blocks[i - 1], blocks[i]];
        assert.ok(cur[0] > prev[1], `seed ${seed}: overlapping blocks`);
        const size = prev[1] - prev[0] + 1;
        const mergeable = cur[1] - cur[0] + 1 === size && cur[0] === prev[1] + 1 && prev[0] % (2 * size) === 0;
        assert.equal(mergeable, false, `seed ${seed}: ${output.join(' ')} has a mergeable pair`);
      }
    }
  });
});

describe('T-A4: edge cases of spec R6 4.2, one test each', () => {
  test('an empty list → no routes, every counter 0', () => {
    assert.deepEqual(aggregateCidrs([]), { cidrs: [], before4: 0, after4: 0, count6: 0, invalid4: 0 });
  });

  test('duplicates, exact and after canonicalisation → one entry', () => {
    assert.deepEqual(cidrsOf(['10.0.0.0/8', '10.0.0.0/8', '10.255.0.1/8']), ['10.0.0.0/8']);
  });

  test('two aligned neighbouring /32 → one /31', () => {
    assert.deepEqual(cidrsOf(['1.2.3.4/32', '1.2.3.5/32']), ['1.2.3.4/31']);
  });

  test('two neighbouring /32 that are not aligned stay two entries', () => {
    assert.deepEqual(cidrsOf(['1.2.3.5/32', '1.2.3.6/32']), ['1.2.3.5/32', '1.2.3.6/32']);
  });

  test('a nested network disappears into the outer one', () => {
    assert.deepEqual(cidrsOf(['10.0.0.0/8', '10.1.0.0/16']), ['10.0.0.0/8']);
  });

  test('two adjacent aligned halves → their parent', () => {
    assert.deepEqual(cidrsOf(['10.0.0.0/9', '10.128.0.0/9']), ['10.0.0.0/8']);
  });

  test('two networks with a gap between them are not merged (no over-coverage)', () => {
    assert.deepEqual(cidrsOf(['10.0.0.0/24', '10.0.2.0/24']), ['10.0.0.0/24', '10.0.2.0/24']);
  });

  test('host bits are dropped: 10.0.0.1/8 → 10.0.0.0/8, and with 10.0.0.0/8 one entry', () => {
    assert.deepEqual(cidrsOf(['10.0.0.1/8']), ['10.0.0.0/8']);
    assert.deepEqual(cidrsOf(['10.0.0.1/8', '10.0.0.0/8']), ['10.0.0.0/8']);
  });

  test('0.0.0.0/0 absorbs every IPv4 entry; IPv6 and malformed entries stay', () => {
    assert.deepEqual(cidrsOf(['0.0.0.0/0', '10.0.0.0/8', '255.255.255.255/32']), ['0.0.0.0/0']);
    assert.deepEqual(cidrsOf(['8.8.8.8/32', '0.0.0.0/0', '2001:db8::/32', '1.2.3.4']), ['0.0.0.0/0', '1.2.3.4', '2001:db8::/32']);
  });

  test('the edges of the space', () => {
    assert.deepEqual(cidrsOf(['0.0.0.0/32']), ['0.0.0.0/32']);
    assert.deepEqual(cidrsOf(['255.255.255.255/32']), ['255.255.255.255/32']);
    assert.deepEqual(cidrsOf(['255.255.255.254/32', '255.255.255.255/32']), ['255.255.255.254/31']);
    assert.deepEqual(cidrsOf(['0.0.0.0/1', '128.0.0.0/1']), ['0.0.0.0/0']);
    assert.deepEqual(cidrsOf(['0.0.0.0/32', '0.0.0.1/32']), ['0.0.0.0/31']);
  });

  test('mixed families: IPv4 merged, IPv6 passes, one string sort over both', () => {
    assert.deepEqual(
      cidrsOf(['2001:db8::/33', '10.0.0.0/9', '2001:db8:8000::/33', '10.128.0.0/9']),
      ['10.0.0.0/8', '2001:db8:8000::/33', '2001:db8::/33'],
    );
  });

  test('malformed IPv4 entries pass unchanged and are counted', () => {
    const input = ['1.2.3.4/33', '256.0.0.0/8', '01.2.3.4/8', '1.2.3.4', '1.2.3.0/024', '10.0.0.0/8'];
    const out = aggregateCidrs(input);
    assert.deepEqual(out.cidrs, ['01.2.3.4/8', '1.2.3.0/024', '1.2.3.4', '1.2.3.4/33', '10.0.0.0/8', '256.0.0.0/8']);
    assert.equal(out.invalid4, 5);
  });

  test('surrounding spaces are trimmed; a space inside makes the entry malformed; empty entries go', () => {
    const out = aggregateCidrs(['  10.0.0.0/9 ', '\t10.128.0.0/9', '10.0.0.0 /8', '', '   ', null]);
    assert.deepEqual(out.cidrs, ['10.0.0.0 /8', '10.0.0.0/8', 'null']);
    assert.equal(out.invalid4, 2);
  });
});

describe('T-A5…T-A9: families, counters, idempotence, order, the pre-3.1.9 form, no mutation', () => {
  test('T-A5 mixed families and malformed entries pass unchanged; counters', () => {
    const input = ['10.0.0.0/8', '2606:4700::/32', '1.2.3.4/33', '1.2.3.4', '01.2.3.4/8', '10.1.0.0/16', '2606:4700::/32'];
    const out = aggregateCidrs(input);
    assert.deepEqual(out.cidrs, ['01.2.3.4/8', '1.2.3.4', '1.2.3.4/33', '10.0.0.0/8', '2606:4700::/32']);
    assert.equal(out.invalid4, 3);
    assert.equal(out.count6, 1);
    assert.equal(out.before4, 5, 'distinct strings without ":"');
    assert.equal(out.after4, 4, 'merged blocks plus malformed entries');
  });

  test('T-A6 idempotent: aggregating the output gives the output', () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const random = mulberry32(seed);
      const once = cidrsOf(randomBlocks16(random, BASE_10, 1 + Math.floor(random() * 60)));
      assert.deepEqual(cidrsOf(once), once, `seed ${seed}`);
    }
  });

  test('T-A7 the input order and repeats do not change the output; the output is string-sorted', () => {
    const random = mulberry32(7);
    const input = [...randomBlocks16(random, BASE_10, 40), '2001:db8::/32', '1.2.3.4', '172.16.0.0/12'];
    const expected = cidrsOf(input);
    assert.deepEqual(expected, [...expected].sort());
    for (let i = 0; i < 50; i += 1) {
      const shuffled = [...input, ...input.slice(0, i)].sort(() => random() - 0.5);
      assert.deepEqual(cidrsOf(shuffled), expected, `permutation ${i}`);
    }
  });

  test('T-A8 a canonical list without merges is byte for byte the pre-3.1.9 Array.from(new Set(x)).sort()', () => {
    const input = ['91.108.4.0/22', '8.8.8.0/24', '2606:4700::/32', '149.154.160.0/20', '8.8.8.0/24', '1.2.3.4', '10.0.2.0/24'];
    assert.deepEqual(cidrsOf(input), Array.from(new Set(input)).sort());
  });

  test('T-A9 the input is not mutated', () => {
    const input = Object.freeze(['10.0.0.0/9', '10.128.0.0/9', '1.2.3.4']);
    assert.doesNotThrow(() => aggregateCidrs(input, { exclude: Object.freeze(['10.0.0.0/24']) }));
    assert.deepEqual(input, ['10.0.0.0/9', '10.128.0.0/9', '1.2.3.4']);
  });
});

describe('T-A10: the static presets of routePresets.js', () => {
  const telegram = expandPresetsToSites(['telegram']).staticCidrs;
  const control4 = expandPresetsToSites(['control4']).staticCidrs;

  test('telegram 9 → 7 in string order', () => {
    assert.equal(telegram.length, 9);
    const out = cidrsOf(telegram);
    assert.deepEqual(out, ['149.154.160.0/20', '185.76.151.0/24', '91.105.192.0/23', '91.108.16.0/21', '91.108.4.0/22', '91.108.56.0/22', '91.108.8.0/21']);
    assert.equal(coversSame(out, telegram).ok, true);
  });

  test('control4 7 → 7, telegram + control4 16 → 14', () => {
    assert.equal(cidrsOf(control4).length, 7);
    assert.equal(coversSame(cidrsOf(control4), control4).ok, true);
    const both = cidrsOf([...telegram, ...control4]);
    assert.equal(both.length, 14);
    assert.equal(coversSame(both, [...telegram, ...control4]).ok, true);
  });
});

describe('subtraction of excluded IPv4 prefixes before the split into blocks', () => {
  test('a hole in the middle', () => {
    assert.deepEqual(cidrsOf(['10.0.0.0/22'], { exclude: ['10.0.1.0/24'] }), ['10.0.0.0/24', '10.0.2.0/23']);
  });

  test('adjacent holes (192 and 193) leave no route between them', () => {
    const out = cidrsOf(['162.159.192.0/22'], { exclude: ['162.159.192.0/24', '162.159.193.0/24'] });
    assert.deepEqual(out, ['162.159.194.0/23']);
  });

  test('a hole at either edge', () => {
    assert.deepEqual(cidrsOf(['10.0.0.0/23'], { exclude: ['10.0.0.0/24'] }), ['10.0.1.0/24']);
    assert.deepEqual(cidrsOf(['10.0.0.0/23'], { exclude: ['10.0.1.0/24'] }), ['10.0.0.0/24']);
  });

  test('an excluded prefix that covers the whole entry removes it; nothing left → an empty list', () => {
    const out = aggregateCidrs(['162.159.192.0/25', '162.159.192.7/32'], { exclude: E_FIXED });
    assert.deepEqual(out.cidrs, []);
    assert.equal(out.after4, 0);
    assert.equal(out.before4, 2);
  });

  test('162.158.0.0/15 without E_fixed is exactly ten blocks', () => {
    const out = aggregateCidrs(['162.158.0.0/15'], { exclude: E_FIXED });
    assert.deepEqual(out.cidrs, [
      '162.158.0.0/16', '162.159.0.0/17', '162.159.128.0/18', '162.159.194.0/24', '162.159.196.0/22',
      '162.159.200.0/22', '162.159.205.0/24', '162.159.206.0/23', '162.159.208.0/20', '162.159.224.0/19',
    ]);
    assert.equal(out.after4, 10);
    assert.equal(out.before4, 1);
    assert.equal(coversSame(out.cidrs, ['162.158.0.0/15'], { minus: E_FIXED }).ok, true);
  });

  test('IPv6 and malformed entries pass the subtraction unchanged', () => {
    const input = ['162.159.192.0/24', '2606:4700:d0::/48', '162.159.192.1', '162.159.193.0/33', '162.159.128.0/24'];
    const out = aggregateCidrs(input, { exclude: E_FIXED });
    assert.deepEqual(out.cidrs, ['162.159.128.0/24', '162.159.192.1', '162.159.193.0/33', '2606:4700:d0::/48']);
    assert.equal(out.invalid4, 2);
    assert.equal(out.count6, 1);
  });

  test('generated cases inside 162.159.0.0/16: exactly S minus E_fixed, minimal, never touching E_fixed', () => {
    const base = parse('162.159.0.0/16')[0];
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = mulberry32(50_000 + seed);
      const input = randomBlocks16(random, base, 1 + Math.floor(random() * 40));
      const output = cidrsOf(input, { exclude: E_FIXED });
      assert.equal(coversSame(output, input, { minus: E_FIXED }).ok, true, `seed ${seed}`);
      assert.equal(output.length, minimalCount(paint16(input, base, { minus: E_FIXED })), `seed ${seed}: minimal`);
      assert.equal(coversSame(output, output, { minus: E_FIXED }).ok, true, `seed ${seed}: E_fixed is not covered`);
    }
  });

  test('an exclude entry that is not a well-formed IPv4 CIDR is a programming error', () => {
    assert.throws(() => aggregateCidrs(['10.0.0.0/8'], { exclude: ['2606:4700:d0::/48'] }), TypeError);
    assert.throws(() => aggregateCidrs(['10.0.0.0/8'], { exclude: ['162.159.192.0'] }), TypeError);
  });
});

describe('exclude6: subtraction of IPv6 prefixes, no IPv6 aggregation (3.2.0, spec 3.2.0 §5.4 p. 1)', () => {
  // The WARP endpoint /48 of the 3.2.0 cut, written out here so this file does not depend on the module.
  const E6 = ['2606:4700:d0::/48', '2606:4700:d1::/48'];
  const v6 = (list) => list.filter((c) => c.includes(':'));
  /** Full eight-group form of a BigInt address: a valid IPv6 spelling the oracle reads independently. */
  const full6 = (n) => Array.from({ length: 8 }, (_, i) => ((n >> BigInt(16 * (7 - i))) & 0xffffn).toString(16)).join(':');

  test('an entry that does not touch the excluded prefixes passes byte for byte, even in a non-canonical spelling', () => {
    const input = ['2001:DB8::/32', '2001:0db8:8000::/33', '2606:4700:4700::1111/128', '2606:4700:cf::/48'];
    const out = aggregateCidrs(input, { exclude6: E6 });
    assert.deepEqual(v6(out.cidrs), [...input].sort());
    assert.equal(out.count6, 4);
  });

  test('IPv6 is not aggregated: adjacent halves stay two entries', () => {
    assert.deepEqual(cidrsOf(['2001:db8::/33', '2001:db8:8000::/33'], { exclude6: E6 }), ['2001:db8:8000::/33', '2001:db8::/33']);
  });

  test('2606:4700::/32 (Cloudflare ips-v6) without E6: fifteen aligned blocks, exactly the /32 minus E6', () => {
    const out = aggregateCidrs(['2606:4700::/32'], { exclude6: E6 });
    assert.equal(out.count6, 15);
    assert.equal(coversSame6(out.cidrs, ['2606:4700::/32'], { minus: E6 }).ok, true);
    assert.ok(out.cidrs.includes('2606:4700:d2::/47'), out.cidrs.join(' '));
    assert.ok(out.cidrs.includes('2606:4700:8000::/33'), out.cidrs.join(' '));
    for (const cidr of out.cidrs) assert.match(cidr, /^[0-9a-f:]+\/\d+$/, 'lower case, compressed');
  });

  test('an entry inside E6 disappears; one equal to it too; nothing left → no IPv6 entry', () => {
    const out = aggregateCidrs(['2606:4700:d0::/48', '2606:4700:d1:5::/64', '2606:4700:d0::a29f:c001/128'], { exclude6: E6 });
    assert.deepEqual(out.cidrs, []);
    assert.equal(out.count6, 0);
  });

  test('host bits of a touching entry are dropped before the split: 2606:4700:d0::1/40 is 2606:4700::/40', () => {
    const out = aggregateCidrs(['2606:4700:d0::1/40'], { exclude6: E6 });
    assert.equal(coversSame6(out.cidrs, ['2606:4700::/40'], { minus: E6 }).ok, true);
    assert.equal(out.count6, 7, 'the /40 minus a /47: one sibling on each of the seven levels');
  });

  test('a /128 hole (a manual override) inside a /48: eighty blocks, the address excluded', () => {
    const out = aggregateCidrs(['2606:4700:4700::/48'], { exclude6: ['2606:4700:4700::1111/128'] });
    assert.equal(out.count6, 80);
    assert.equal(coversSame6(out.cidrs, ['2606:4700:4700::/48'], { minus: ['2606:4700:4700::1111/128'] }).ok, true);
  });

  test('malformed IPv6 entries pass unchanged; IPv4 is not touched by exclude6', () => {
    const input = ['2606:4700:d0::/129', '2606:zz::/32', '2606:4700:d0::', '2606:4700:d0::/048', 'fe80::1%eth0/64', '162.159.192.0/24'];
    const out = aggregateCidrs(input, { exclude6: E6 });
    assert.deepEqual(out.cidrs, [...input].sort());
  });

  test('exclude and exclude6 together: each family loses its own prefixes', () => {
    const out = aggregateCidrs(['162.159.192.0/23', '2606:4700:d0::/47', '2001:db8::/32'], {
      exclude: ['162.159.192.0/24'], exclude6: E6,
    });
    assert.deepEqual(out.cidrs, ['162.159.193.0/24', '2001:db8::/32']);
  });

  test('an exclude6 entry that is not a well-formed IPv6 CIDR is a programming error', () => {
    assert.throws(() => aggregateCidrs(['2001:db8::/32'], { exclude6: ['162.159.192.0/24'] }), TypeError);
    assert.throws(() => aggregateCidrs(['2001:db8::/32'], { exclude6: ['2606:4700:d0::'] }), TypeError);
    assert.throws(() => aggregateCidrs(['2001:db8::/32'], { exclude6: ['2606:4700:d0::/129'] }), TypeError);
  });

  test('generated cases inside a /112: exactly each entry minus the holes, nothing of the holes, idempotent', () => {
    const base = parse6('2001:db8:1:2:3:4:5:0/112')[0];
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = mulberry32(70_000 + seed);
      const block = (minLen) => {
        const len = minLen + Math.floor(random() * (129 - minLen));
        const size = 2 ** (128 - len);
        const offset = Math.floor((random() * 65536) / size) * size;
        return `${full6(base + BigInt(offset))}/${len}`;
      };
      const input = Array.from({ length: 1 + Math.floor(random() * 6) }, () => block(112));
      const holes = Array.from({ length: 1 + Math.floor(random() * 3) }, () => block(114));
      const out = aggregateCidrs(input, { exclude6: holes });
      assert.equal(coversSame6(out.cidrs, input, { minus: holes }).ok, true, `seed ${seed}`);
      assert.equal(coversSame6(out.cidrs, out.cidrs, { minus: holes }).ok, true, `seed ${seed}: holes covered`);
      assert.deepEqual(cidrsOf(out.cidrs, { exclude6: holes }), out.cidrs, `seed ${seed}: idempotent`);
    }
  });
});

describe('T-A11: recorded public lists (the three largest of the 3.1.9 measurement)', () => {
  const dir = path.join(__dirname, 'fixtures', 'route-lists');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort() : [];

  test('three fixtures are recorded', () => {
    assert.equal(files.length, 3, `fixtures in ${dir}`);
  });

  // Well-formed IPv4 CIDR, written here independently of the module: octets 0–255 and prefix 0–32, no leading zeros.
  const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
  const STRICT4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}\\/(3[0-2]|[12]?\\d)$`);
  const strict = (list) => list.filter((c) => STRICT4.test(c));

  for (const file of files) {
    test(`${file}: exact coverage, then exactly the list minus E_fixed; never more entries without the cut; idempotent`, () => {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
      const plain = aggregateCidrs(raw);
      assert.equal(coversSame(strict(plain.cidrs), strict(raw)).ok, true);
      assert.ok(plain.after4 <= plain.before4, `${plain.after4} <= ${plain.before4}`);
      const cut = aggregateCidrs(raw, { exclude: E_FIXED });
      assert.equal(coversSame(strict(cut.cidrs), strict(raw), { minus: E_FIXED }).ok, true);
      assert.deepEqual(cidrsOf(cut.cidrs, { exclude: E_FIXED }), cut.cidrs);
    });
  }
});
