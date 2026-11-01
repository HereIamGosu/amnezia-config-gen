// scripts/ipcatalog/sources/asn.js
// Announced prefixes of an AS (spec 3.2.0 §4.2, `{ from: 'asn', asns }`): ipverse/as-ip-blocks (CC0-1.0, daily,
// aggregated, only AS that announced something in the last 90 days), and iptoasn.com (PDDL 1.0, hourly ranges) when
// ipverse cannot be read. A 404 at ipverse means "not announced": an empty answer, not a failure.

'use strict';

const zlib = require('zlib');
const net = require('net');
const { HttpError } = require('../lib/net');
const { toInterval6 } = require('../../../src/server/cidrAggregate');

const ipverseUrl = (asn, family) => `https://raw.githubusercontent.com/ipverse/as-ip-blocks/master/as/${asn}/ipv${family}-aggregated.txt`;
const IPTOASN_URLS = Object.freeze({ 4: 'https://iptoasn.com/data/ip2asn-v4.tsv.gz', 6: 'https://iptoasn.com/data/ip2asn-v6.tsv.gz' });

/** ipverse `ipv4-aggregated.txt`: one prefix per line, `#` lines are comments. */
const parseIpverse = (text) => String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

const toBig4 = (ip) => BigInt(ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0));
const fromBig4 = (n) => [24n, 16n, 8n, 0n].map((s) => String((n >> s) & 255n)).join('.');
const toBig6 = (ip) => toInterval6(`${ip}/128`)[0];
const fromBig6 = (n) => Array.from({ length: 8 }, (_, i) => ((n >> BigInt(16 * (7 - i))) & 0xffffn).toString(16)).join(':');

/** An inclusive address range as the fewest aligned CIDR blocks. */
const rangeToCidrs = (start, end, bits, format) => {
  const out = [];
  let cur = start;
  while (cur <= end) {
    let size = 0n;
    while (size < BigInt(bits) && ((cur >> size) & 1n) === 0n && cur + (1n << (size + 1n)) - 1n <= end) size += 1n;
    out.push(`${format(cur)}/${BigInt(bits) - size}`);
    cur += 1n << size;
  }
  return out;
};

/**
 * iptoasn `ip2asn-v4.tsv` / `-v6.tsv`: `range_start range_end AS_number country description`, tab separated.
 * @param {string} text
 * @param {Set<number>} asns
 * @param {4|6} family
 * @returns {Map<number, string[]>} CIDRs per AS
 */
const parseIptoasn = (text, asns, family) => {
  const out = new Map([...asns].map((a) => [a, []]));
  for (const line of String(text).split(/\r?\n/)) {
    const [start, end, as] = line.split('\t');
    const asn = Number(as);
    if (!out.has(asn)) continue;
    const valid = family === 4 ? net.isIPv4(start) && net.isIPv4(end) : net.isIPv6(start) && net.isIPv6(end);
    if (!valid) continue;
    const blocks = family === 4
      ? rangeToCidrs(toBig4(start), toBig4(end), 32, fromBig4)
      : rangeToCidrs(toBig6(start), toBig6(end), 128, fromBig6);
    out.get(asn).push(...blocks);
  }
  return out;
};

/**
 * Prefixes of one AS, IPv4 and IPv6. `iptoasn(family)` gives the parsed iptoasn table lazily (one download per build).
 * @returns {Promise<{ cidrs4: string[], cidrs6: string[], via: string }>}
 */
const fetchAsn = async (get, asn, { iptoasn }) => {
  const readFamily = async (family) => {
    try {
      return { list: parseIpverse(await get(ipverseUrl(asn, family))), via: 'ipverse' };
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return { list: [], via: 'ipverse' };
      const table = await iptoasn(family);
      return { list: table(asn), via: 'iptoasn' };
    }
  };
  const [four, six] = [await readFamily(4), await readFamily(6)];
  const via = four.via === six.via ? four.via : `${four.via}+${six.via}`;
  return { cidrs4: four.list, cidrs6: six.list, via: four.list.length || six.list.length ? via : 'not_announced' };
};

/** A lazy reader of the iptoasn tables for the given AS numbers. */
const createIptoasn = (get, asns) => {
  const tables = {};
  return async (family) => {
    if (!tables[family]) {
      tables[family] = (async () => {
        const gz = await get(IPTOASN_URLS[family], { binary: true });
        const parsed = parseIptoasn(zlib.gunzipSync(gz).toString('utf8'), new Set(asns), family);
        return (asn) => parsed.get(asn) || [];
      })();
    }
    return tables[family];
  };
};

module.exports = { ipverseUrl, IPTOASN_URLS, parseIpverse, parseIptoasn, rangeToCidrs, fetchAsn, createIptoasn };
