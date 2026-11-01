// src/server/ipCatalog/addressFilters.js
// What may enter the preset catalogue (spec 3.2.0 §4.2, §4.4): strict CIDRs of public unicast space, nothing wider
// than /8 (IPv4) or /19 (IPv6) unless an official list is explicitly allowed to bring it. The builder filters with
// these rules and the snapshot check repeats them on the committed file.

'use strict';

const { STRICT_IPV4_CIDR, toInterval6 } = require('../cidrAggregate');

const MAX_WIDTH4 = 8;
const MAX_WIDTH6 = 19;

// Special-purpose IPv4 space (RFC 6890 and its updates): unspecified, private, CGNAT, loopback, link-local, IETF,
// documentation, 6to4 relay, benchmarking, multicast, reserved, broadcast. A route that touches it is refused.
const BOGONS4 = Object.freeze([
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24',
  '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
  '224.0.0.0/4', '240.0.0.0/4',
]);
// IPv6: only global unicast 2000::/3 is accepted, minus Teredo, documentation, 6to4 and the RFC 9637 documentation
// prefix. Unique local, link-local and multicast lie outside 2000::/3.
const GLOBAL_UNICAST6 = '2000::/3';
const BOGONS6 = Object.freeze(['2001::/32', '2001:db8::/32', '2002::/16', '3fff::/20']);

const interval4 = (cidr) => {
  const [ip, len] = cidr.split('/');
  const addr = ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
  const size = 2 ** (32 - Number(len));
  const start = Math.floor(addr / size) * size;
  return [start, start + size - 1];
};
const BOGON_INTERVALS4 = BOGONS4.map(interval4);
const GLOBAL6 = toInterval6(GLOBAL_UNICAST6);
const BOGON_INTERVALS6 = BOGONS6.map(toInterval6);

const overlaps = ([a, b], [c, d]) => a <= d && c <= b;

/**
 * Why an IPv4 entry may not enter the catalogue, or null when it may.
 * @param {string} cidr
 * @param {{ allowWide?: boolean }} [opts] an official list allowed to bring networks wider than /8
 * @returns {null | 'malformed' | 'bogon' | 'wide'}
 */
const rejectReason4 = (cidr, { allowWide = false } = {}) => {
  if (typeof cidr !== 'string' || !STRICT_IPV4_CIDR.test(cidr)) return 'malformed';
  const interval = interval4(cidr);
  if (BOGON_INTERVALS4.some((bogon) => overlaps(interval, bogon))) return 'bogon';
  if (!allowWide && Number(cidr.split('/')[1]) < MAX_WIDTH4) return 'wide';
  return null;
};

/**
 * Why an IPv6 entry may not enter the catalogue, or null when it may.
 * @param {string} cidr
 * @param {{ allowWide?: boolean }} [opts]
 * @returns {null | 'malformed' | 'bogon' | 'wide'}
 */
const rejectReason6 = (cidr, { allowWide = false } = {}) => {
  const interval = typeof cidr === 'string' ? toInterval6(cidr) : null;
  if (!interval) return 'malformed';
  if (interval[0] < GLOBAL6[0] || interval[1] > GLOBAL6[1]) return 'bogon';
  if (BOGON_INTERVALS6.some((bogon) => overlaps(interval, bogon))) return 'bogon';
  if (!allowWide && Number(cidr.split('/')[1]) < MAX_WIDTH6) return 'wide';
  return null;
};

module.exports = { BOGONS4, BOGONS6, GLOBAL_UNICAST6, MAX_WIDTH4, MAX_WIDTH6, rejectReason4, rejectReason6 };
