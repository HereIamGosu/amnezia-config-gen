// src/server/cidrAggregate.js
// Exact aggregation of a route list (3.1.9, spec R6 4.2, invariant I14). The IPv4 part becomes the smallest set of
// aligned blocks that covers exactly the same addresses, minus the prefixes the caller excludes. Over-coverage is
// forbidden: a block never adds an address that was not in the list, or the visitor's other traffic would go
// through WARP. IPv6 entries (with ":") and malformed IPv4 entries pass unchanged (exact dedup), as before 3.1.9.
// The output is sorted by the default string sort, so a canonical list without merges is byte for byte what every
// version before 3.1.9 wrote.
// IPv6 (3.2.0, spec 3.2.0 §5.4 p. 1): `exclude6` subtracts IPv6 prefixes on BigInt intervals. An IPv6 entry that
// does not touch them passes byte for byte; one that does becomes the aligned blocks of its remainder. IPv6 entries
// are never merged with each other (spec R6 D5).

'use strict';

const net = require('net');

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
/** `a.b.c.d/p`: octets 0–255 and prefix 0–32 without leading zeros. Anything else has no defined address set. */
const STRICT_IPV4_CIDR = new RegExp(`^${OCTET}(\\.${OCTET}){3}\\/(3[0-2]|[12]?\\d)$`);

/** [start, end] of a well-formed IPv4 CIDR; host bits are dropped (10.0.0.1/8 is 10.0.0.0/8). Number arithmetic. */
const toInterval = (cidr) => {
  const [ip, len] = cidr.split('/');
  const addr = ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
  const size = 2 ** (32 - Number(len));
  const start = Math.floor(addr / size) * size;
  return [start, start + size - 1];
};

/** Sorts by start (then the longer first) and merges overlapping, nested and adjacent intervals in one pass. */
const mergeIntervals = (intervals) => {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out = [];
  for (const [start, end] of sorted) {
    const cur = out[out.length - 1];
    if (cur && start <= cur[1] + 1) cur[1] = Math.max(cur[1], end);
    else out.push([start, end]);
  }
  return out;
};

/** Removes the sorted, merged `holes` from the sorted, merged `intervals`. */
const subtractIntervals = (intervals, holes) => {
  const out = [];
  for (const [start, end] of intervals) {
    let cur = start;
    for (const [holeStart, holeEnd] of holes) {
      if (holeEnd < cur || holeStart > end) continue;
      if (holeStart > cur) out.push([cur, holeStart - 1]);
      cur = holeEnd + 1;
      if (cur > end) break;
    }
    if (cur <= end) out.push([cur, end]);
  }
  return out;
};

/** Trailing zero bits of an address; ctz(0) is 32: address 0 starts a block of any size, up to the whole space. */
const ctz = (n) => {
  if (n === 0) return 32;
  let bits = 0;
  while (n % 2 ** (bits + 1) === 0) bits += 1;
  return bits;
};

const largestPowerOfTwoAtMost = (n) => {
  let size = 1;
  while (size * 2 <= n) size *= 2;
  return size;
};

const formatAddress = (n) => [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.');

/**
 * Greedy split of an interval into aligned blocks: at each position the largest block aligned to it that still fits.
 * Minimal for one interval; the merged intervals are disjoint and not adjacent, so the total is minimal too.
 */
const toBlocks = ([start, end], out) => {
  let cur = start;
  while (cur <= end) {
    const size = Math.min(2 ** ctz(cur), largestPowerOfTwoAtMost(end - cur + 1));
    out.push(`${formatAddress(cur)}/${32 - Math.round(Math.log2(size))}`);
    cur += size;
  }
};

const PREFIX6 = /^(12[0-8]|1[01]\d|[1-9]?\d)$/;

/** A valid IPv6 address (checked by net.isIPv6, no zone) → BigInt; `::` and an IPv4 tail expanded. */
const ipv6ToBigInt = (addr) => {
  let text = addr.toLowerCase();
  const tail = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(2).map(Number);
    text = `${tail[1]}${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
  }
  const [head, rest] = text.split('::');
  const groupsOf = (s) => (s ? s.split(':') : []);
  const left = groupsOf(head);
  const right = rest === undefined ? [] : groupsOf(rest);
  const groups = rest === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.reduce((acc, group) => (acc << 16n) + BigInt(Number.parseInt(group, 16)), 0n);
};

/** [start, end] (BigInt) of `addr/p` with a valid IPv6 address and prefix 0–128 without leading zeros, else null. */
const toInterval6 = (cidr) => {
  const slash = cidr.indexOf('/');
  if (slash < 0) return null;
  const addr = cidr.slice(0, slash);
  const len = cidr.slice(slash + 1);
  if (!PREFIX6.test(len) || addr.includes('%') || !net.isIPv6(addr)) return null;
  const size = 1n << BigInt(128 - Number(len));
  const start = (ipv6ToBigInt(addr) / size) * size;
  return [start, start + size - 1n];
};

const compareBig = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** mergeIntervals on BigInt intervals. */
const mergeIntervals6 = (intervals) => {
  const sorted = [...intervals].sort((a, b) => compareBig(a[0], b[0]) || compareBig(b[1], a[1]));
  const out = [];
  for (const [start, end] of sorted) {
    const cur = out[out.length - 1];
    if (cur && start <= cur[1] + 1n) cur[1] = cur[1] > end ? cur[1] : end;
    else out.push([start, end]);
  }
  return out;
};

/** subtractIntervals on BigInt intervals. */
const subtractIntervals6 = (intervals, holes) => {
  const out = [];
  for (const [start, end] of intervals) {
    let cur = start;
    for (const [holeStart, holeEnd] of holes) {
      if (holeEnd < cur || holeStart > end) continue;
      if (holeStart > cur) out.push([cur, holeStart - 1n]);
      cur = holeEnd + 1n;
      if (cur > end) break;
    }
    if (cur <= end) out.push([cur, end]);
  }
  return out;
};

/** RFC 5952 text of a BigInt address: lower case, no leading zeros, the first longest run of 2+ zero groups → `::`. */
const formatAddress6 = (n) => {
  const groups = Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(16 * (7 - i))) & 0xffffn));
  let best = { at: -1, len: 1 };
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i += 1; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > best.len) best = { at: i, len: j - i };
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best.at < 0) return hex.join(':');
  return `${hex.slice(0, best.at).join(':')}::${hex.slice(best.at + best.len).join(':')}`;
};

/** toBlocks on a BigInt interval: the largest aligned block that fits at each position. */
const toBlocks6 = ([start, end], out) => {
  let cur = start;
  while (cur <= end) {
    let bits = 0n;
    while (bits < 128n && ((cur >> bits) & 1n) === 0n && cur + (1n << (bits + 1n)) - 1n <= end) bits += 1n;
    out.add(`${formatAddress6(cur)}/${128n - bits}`);
    cur += 1n << bits;
  }
};

/**
 * @param {Iterable<unknown>} list route entries; non-strings are read as String(x), surrounding spaces trimmed,
 *   empty entries dropped
 * @param {{ exclude?: string[], exclude6?: string[] }} [opts] well-formed IPv4 (`exclude`) and IPv6 (`exclude6`)
 *   CIDRs whose addresses never appear in the output
 * @returns {{ cidrs: string[], before4: number, after4: number, count6: number, invalid4: number }} `before4`: distinct
 *   IPv4 strings of the input (malformed ones included); `after4`: IPv4 entries of the output (blocks + `invalid4`);
 *   `count6`: IPv6 entries of the output
 */
const aggregateCidrs = (list, { exclude = [], exclude6 = [] } = {}) => {
  const entries = new Set();
  for (const item of list) {
    const value = String(item).trim();
    if (value) entries.add(value);
  }
  const holes = mergeIntervals(exclude.map((cidr) => {
    if (typeof cidr !== 'string' || !STRICT_IPV4_CIDR.test(cidr)) {
      throw new TypeError(`aggregateCidrs: exclude entry is not a well-formed IPv4 CIDR: ${cidr}`);
    }
    return toInterval(cidr);
  }));
  const holes6 = mergeIntervals6(exclude6.map((cidr) => {
    const interval = typeof cidr === 'string' ? toInterval6(cidr) : null;
    if (!interval) throw new TypeError(`aggregateCidrs: exclude6 entry is not a well-formed IPv6 CIDR: ${cidr}`);
    return interval;
  }));

  const ipv6 = [];
  const invalid4 = [];
  const intervals = [];
  let before4 = 0;
  for (const entry of entries) {
    if (entry.includes(':')) { ipv6.push(entry); continue; }
    before4 += 1;
    if (STRICT_IPV4_CIDR.test(entry)) intervals.push(toInterval(entry));
    else invalid4.push(entry);
  }

  const blocks = [];
  for (const interval of subtractIntervals(mergeIntervals(intervals), holes)) toBlocks(interval, blocks);

  const out6 = new Set();
  for (const entry of ipv6) {
    const interval = holes6.length ? toInterval6(entry) : null;
    if (!interval || !holes6.some(([start, end]) => start <= interval[1] && end >= interval[0])) {
      out6.add(entry);
      continue;
    }
    for (const rest of subtractIntervals6([interval], holes6)) toBlocks6(rest, out6);
  }
  return {
    cidrs: [...blocks, ...invalid4, ...out6].sort(),
    before4,
    after4: blocks.length + invalid4.length,
    count6: out6.size,
    invalid4: invalid4.length,
  };
};

/**
 * Whether a route list covers an address (I15, 3.2.0): the Endpoint choice skips the candidates the split routes
 * cover, and a manual override inside them is cut. Well-formed IPv4 and IPv6 CIDRs count; malformed entries cover
 * nothing; an address that is neither IPv4 nor IPv6 is never covered.
 * @param {Iterable<unknown>} list
 * @returns {(address: string) => boolean}
 */
const routeMatcher = (list) => {
  const v4 = [];
  const v6 = [];
  for (const item of list) {
    const value = String(item).trim();
    if (value.includes(':')) {
      const interval = toInterval6(value);
      if (interval) v6.push(interval);
    } else if (STRICT_IPV4_CIDR.test(value)) {
      v4.push(toInterval(value));
    }
  }
  const merged4 = mergeIntervals(v4);
  const merged6 = mergeIntervals6(v6);
  return (address) => {
    const text = String(address ?? '').trim();
    if (net.isIPv4(text)) {
      const [n] = toInterval(`${text}/32`);
      return merged4.some(([start, end]) => n >= start && n <= end);
    }
    const interval = toInterval6(`${text}/128`);
    return Boolean(interval) && merged6.some(([start, end]) => interval[0] >= start && interval[0] <= end);
  };
};

module.exports = { aggregateCidrs, routeMatcher, STRICT_IPV4_CIDR, toInterval6 };
