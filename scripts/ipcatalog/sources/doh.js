// scripts/ipcatalog/sources/doh.js
// Own resolution of domains (spec 3.2.0 §4.2, `resolve` and `portal`): Google DoH JSON with an explicit EDNS Client
// Subnet for each of three points, A and AAAA, the CNAME chain followed inside the answer, A → /32, AAAA → /128.
// The maintainer's workstation goes out through a VPN client, so the point "without ECS" would be the VPN exit; it
// is not used. NXDOMAIN, SERVFAIL and other DNS statuses are an empty answer; HTTP and network failures (after the
// retries of lib/net.js) fail the preset step.

'use strict';

const net = require('net');
const { toInterval6 } = require('../../../src/server/cidrAggregate');

const DOH_URL = 'https://dns.google/resolve';
// Client subnets of the three points (spec §4.2): Moscow and Saint Petersburg (Russian home access networks, chosen by
// their RIPE registration, which the snapshot sources record) and Germany (85.214.0.0/24: a client whose DNS goes
// through the tunnel resolves from the WARP exit, INFERENCE of the spec). RIPE whois checked 2026-11-01.
const ECS_POINTS = Object.freeze([
  { id: 'moscow', subnet: '95.165.0.0/24', ripe: '95.165.0.0/17 MGTS-PPPOE, Moscow Local Telephone Network, RU' },
  { id: 'saint-petersburg', subnet: '178.70.0.0/24', ripe: '178.70.0.0/17 RU-AVANGARD-DSL, North-West Telecom, St. Petersburg, RU' },
  { id: 'germany', subnet: '85.214.0.0/24', ripe: '85.214.0.0/22 STRATO-RZG-DED2, Strato, Berlin, DE' },
]);
const TYPES = Object.freeze({ A: 1, AAAA: 28 });
const CNAME = 5;

const dohUrl = (name, type, subnet) => `${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}&edns_client_subnet=${encodeURIComponent(subnet)}`;
const normName = (n) => String(n).toLowerCase().replace(/\.$/, '');

/** Canonical text of an IPv6 address (RFC 5952), from the same parser the aggregator uses. */
const canonical6 = (addr) => {
  const n = toInterval6(`${addr}/128`)[0];
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
  return best.at < 0 ? hex.join(':') : `${hex.slice(0, best.at).join(':')}::${hex.slice(best.at + best.len).join(':')}`;
};

/**
 * Addresses for `name` in a DoH JSON answer: the CNAME chain from `name` is followed through the records of the
 * answer, and the A (AAAA) records of every name on it are taken. A DNS status other than NOERROR gives nothing.
 * @returns {string[]} `/32` or `/128` entries
 */
const parseDohAnswer = (text, name, type) => {
  const doc = JSON.parse(text);
  if (doc.Status !== 0 || !Array.isArray(doc.Answer)) return [];
  const cname = new Map();
  const addrs = new Map();
  for (const rr of doc.Answer) {
    const owner = normName(rr.name);
    if (rr.type === CNAME) cname.set(owner, normName(rr.data));
    else if (rr.type === TYPES[type]) addrs.set(owner, [...(addrs.get(owner) || []), String(rr.data).trim()]);
  }
  const out = [];
  const seen = new Set();
  for (let cur = normName(name); cur && !seen.has(cur); cur = cname.get(cur)) {
    seen.add(cur);
    for (const a of addrs.get(cur) || []) {
      if (type === 'A' && net.isIPv4(a)) out.push(`${a}/32`);
      if (type === 'AAAA' && net.isIPv6(a)) out.push(`${canonical6(a)}/128`);
    }
  }
  return out;
};

/**
 * A and AAAA of one domain from every ECS point.
 * @returns {Promise<{ v4: string[], v6: string[], queries: number }>}
 */
const resolveDomain = async (get, name, points = ECS_POINTS) => {
  const v4 = new Set();
  const v6 = new Set();
  for (const { subnet } of points) {
    for (const type of ['A', 'AAAA']) {
      for (const entry of parseDohAnswer(await get(dohUrl(name, type, subnet)), name, type)) (type === 'A' ? v4 : v6).add(entry);
    }
  }
  return { v4: [...v4], v6: [...v6], queries: points.length * 2 };
};

/** A plain hostname of a domain list (lower case, no wildcard, no trailing dot), or null. */
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const cleanHostname = (raw) => {
  const name = normName(String(raw ?? '').trim());
  return HOSTNAME.test(name) ? name : null;
};

module.exports = { DOH_URL, ECS_POINTS, dohUrl, parseDohAnswer, resolveDomain, cleanHostname, canonical6 };
