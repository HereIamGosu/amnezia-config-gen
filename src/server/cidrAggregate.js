// src/server/cidrAggregate.js
// Exact aggregation of a route list (3.1.9, spec R6 4.2, invariant I14). The IPv4 part becomes the smallest set of
// aligned blocks that covers exactly the same addresses, minus the prefixes the caller excludes. Over-coverage is
// forbidden: a block never adds an address that was not in the list, or the visitor's other traffic would go
// through WARP. IPv6 entries (with ":") and malformed IPv4 entries pass unchanged (exact dedup), as before 3.1.9.
// The output is sorted by the default string sort, so a canonical list without merges is byte for byte what every
// version before 3.1.9 wrote.

'use strict';

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

/**
 * @param {Iterable<unknown>} list route entries; non-strings are read as String(x), surrounding spaces trimmed,
 *   empty entries dropped
 * @param {{ exclude?: string[] }} [opts] well-formed IPv4 CIDRs whose addresses never appear in the output
 * @returns {{ cidrs: string[], before4: number, after4: number, count6: number, invalid4: number }} `before4`: distinct
 *   IPv4 strings of the input (malformed ones included); `after4`: IPv4 entries of the output (blocks + `invalid4`)
 */
const aggregateCidrs = (list, { exclude = [] } = {}) => {
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
  return {
    cidrs: [...blocks, ...invalid4, ...ipv6].sort(),
    before4,
    after4: blocks.length + invalid4.length,
    count6: ipv6.length,
    invalid4: invalid4.length,
  };
};

module.exports = { aggregateCidrs, STRICT_IPV4_CIDR };
