// __tests__/helpers/cidr-coverage.js
// An oracle for IPv4 route lists that does not share code with src/server/cidrAggregate.js: which addresses a list
// covers, whether two lists cover the same addresses, the smallest number of aligned blocks for a painted /16, and a
// seeded PRNG for generated cases (spec R6, section 6).

'use strict';

const SPACE = 2 ** 32;

/** `a.b.c.d/p` → [start, end] of the network, host bits ignored. Only for well-formed IPv4 CIDRs. */
const parse = (cidr) => {
  const [ip, len] = String(cidr).split('/');
  const addr = ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
  const size = 2 ** (32 - Number(len));
  const start = Math.floor(addr / size) * size;
  return [start, start + size - 1];
};

/** Sorted, disjoint, non-adjacent intervals covering the same addresses as `list`. */
const intervalsOf = (list) => {
  const sorted = list.map(parse).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
};

/** Whether `point` lies in one of the sorted disjoint `intervals` (binary search). */
const contains = (intervals, point) => {
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (point < intervals[mid][0]) hi = mid - 1;
    else if (point > intervals[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
};

const addressCount = (list) => intervalsOf(list).reduce((sum, [start, end]) => sum + (end - start + 1), 0);

/**
 * Whether `listA` covers exactly the addresses of `listB` minus those of `minus`. Membership in a union of blocks
 * changes only at a block's start and right after its end, so comparing the points start - 1, start, end, end + 1
 * of every block of the three lists decides equality of the sets. `witness` is an address where they differ.
 */
const coversSame = (listA, listB, { minus = [] } = {}) => {
  const a = intervalsOf(listA);
  const b = intervalsOf(listB);
  const m = intervalsOf(minus);
  const points = new Set();
  for (const [start, end] of [...a, ...b, ...m]) {
    for (const p of [start - 1, start, end, end + 1]) if (p >= 0 && p < SPACE) points.add(p);
  }
  for (const p of points) {
    const inA = contains(a, p);
    const inB = contains(b, p) && !contains(m, p);
    if (inA !== inB) return { ok: false, witness: p };
  }
  return { ok: true, witness: null };
};

const formatAddress = (n) => [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.');

/** Paints the blocks of `list` over the /16 that starts at `base` (blocks outside it are ignored). */
const paint16 = (list, base, { minus = [] } = {}) => {
  const bitmap = new Uint8Array(65536);
  const fill = (cidr, value) => {
    const [start, end] = parse(cidr);
    const from = Math.max(start, base);
    const to = Math.min(end, base + 65535);
    for (let p = from; p <= to; p += 1) bitmap[p - base] = value;
  };
  for (const cidr of list) fill(cidr, 1);
  for (const cidr of minus) fill(cidr, 0);
  return bitmap;
};

/** Smallest number of aligned blocks that cover exactly the painted cells: a prefix tree over the bitmap. */
const minimalCount = (bitmap) => {
  const sums = new Uint32Array(bitmap.length + 1);
  for (let i = 0; i < bitmap.length; i += 1) sums[i + 1] = sums[i] + bitmap[i];
  const node = (from, size) => {
    const painted = sums[from + size] - sums[from];
    if (painted === 0) return 0;
    if (painted === size) return 1;
    return node(from, size / 2) + node(from + size / 2, size / 2);
  };
  return node(0, bitmap.length);
};

/** mulberry32: a small seeded PRNG, so a failing generated case can be replayed from its seed. */
const mulberry32 = (seed) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
};

/** `count` random blocks with prefixes in [minLen, 32] inside the /16 at `base` (well formed, host bits zero). */
const randomBlocks16 = (random, base, count, minLen = 16) => {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const len = minLen + Math.floor(random() * (33 - minLen));
    const size = 2 ** (32 - len);
    const offset = Math.floor((random() * 65536) / size) * size;
    out.push(`${formatAddress(base + offset)}/${len}`);
  }
  return out;
};

/** `count` random blocks anywhere in the IPv4 space, prefixes 0..32, host bits possibly set. */
const randomBlocksAnywhere = (random, count) => {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const len = Math.floor(random() * 33);
    out.push(`${formatAddress(Math.floor(random() * SPACE))}/${len}`);
  }
  return out;
};

module.exports = {
  parse,
  intervalsOf,
  addressCount,
  coversSame,
  formatAddress,
  paint16,
  minimalCount,
  mulberry32,
  randomBlocks16,
  randomBlocksAnywhere,
};
