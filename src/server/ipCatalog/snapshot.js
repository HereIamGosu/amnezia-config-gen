// src/server/ipCatalog/snapshot.js
// The preset address catalogue (3.2.0, spec 3.2.0 §4.3): src/server/ipCatalog/snapshot.json, built off the request
// path by `npm run ipcatalog:build` and committed. The server reads it lazily, on the first request that needs
// preset routes, and keeps it in memory; the full tunnel never touches it. A missing or broken file is one answer:
// the catalogue cannot be used, and the caller refuses split routes before any registration.
//
// Record of a catalogue preset: { cidrs4, cidrs6, addrs4, precision, coverage, stale, noData, seen4, seen6 }.
// Record of a transitional preset (§4.5): { legacy: true, liveRoutes4, fallback: { cidrs4, cidrs6, precision, … } }.
// The price `routes4` is computed here with the same aggregator and the same WARP endpoint cut as a config, so the
// tile and the AllowedIPs lines count on one base (spec §4.3 «Цена»).

'use strict';

const fs = require('fs');
const path = require('path');
const { aggregateCidrs, STRICT_IPV4_CIDR, toInterval6 } = require('../cidrAggregate');
const { WARP_ENDPOINT_PREFIXES_V4 } = require('../warpEndpointPrefixes');

const SNAPSHOT_PATH = path.join(__dirname, 'snapshot.json');
const SNAPSHOT_SCHEMA = 1;
const PRECISIONS = Object.freeze(['exact', 'approx', 'wide']);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;

/** Price of an IPv4 list: lines it gives in AllowedIPs after the WARP endpoint cut and exact aggregation. */
const priceOf = (cidrs4) => aggregateCidrs(cidrs4, { exclude: WARP_ENDPOINT_PREFIXES_V4 }).after4;

/** Throws on a list that is not made of strict CIDRs of one family. */
const assertCidrs = (list, family, where) => {
  if (!Array.isArray(list)) throw new Error(`${where}: not a list`);
  for (const cidr of list) {
    const ok = typeof cidr === 'string' && (family === 4 ? STRICT_IPV4_CIDR.test(cidr) : Boolean(toInterval6(cidr)));
    if (!ok) throw new Error(`${where}: malformed entry`);
  }
};

/** A set of addresses: { cidrs4, cidrs6, precision, noData } checked and priced. */
const readAddressSet = (record, where) => {
  assertCidrs(record.cidrs4, 4, `${where}.cidrs4`);
  assertCidrs(record.cidrs6 ?? [], 6, `${where}.cidrs6`);
  if (!PRECISIONS.includes(record.precision)) throw new Error(`${where}.precision`);
  if (record.noData != null && typeof record.noData !== 'string') throw new Error(`${where}.noData`);
  const noData = record.noData || (record.cidrs4.length ? null : 'empty');
  return {
    cidrs4: record.cidrs4,
    cidrs6: record.cidrs6 ?? [],
    precision: record.precision,
    noData,
    routes4: noData ? 0 : priceOf(record.cidrs4),
    stale: record.stale ?? null,
  };
};

/**
 * Parses and checks the snapshot text. Never throws.
 * @param {string} text
 * @returns {{ ok: true, snapshot: { builtAt: string, presets: Record<string, object> } } | { ok: false, reason: string }}
 */
const parseSnapshot = (text) => {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'snapshot_invalid_json' };
  }
  try {
    if (!isObject(doc) || doc.schema !== SNAPSHOT_SCHEMA) throw new Error('schema');
    if (typeof doc.builtAt !== 'string' || !ISO_RE.test(doc.builtAt)) throw new Error('builtAt');
    if (!isObject(doc.presets)) throw new Error('presets');
    const presets = {};
    for (const [key, record] of Object.entries(doc.presets)) {
      if (!isObject(record)) throw new Error(key);
      if (record.legacy === true) {
        if (!isCount(record.liveRoutes4) || !isObject(record.fallback)) throw new Error(`${key}.legacy`);
        presets[key] = { legacy: true, liveRoutes4: record.liveRoutes4, fallback: readAddressSet(record.fallback, `${key}.fallback`) };
      } else {
        presets[key] = { legacy: false, ...readAddressSet(record, key) };
      }
    }
    return { ok: true, snapshot: { builtAt: doc.builtAt, presets } };
  } catch {
    return { ok: false, reason: 'snapshot_rejected' };
  }
};

/**
 * Lazy, cached reader of one snapshot file: the first call reads and parses it, every later call returns the same
 * answer (the file ships with the image and does not change while the process runs).
 * @param {{ path?: string, readFile?: (p: string, enc: string) => string }} [opts]
 * @returns {() => ReturnType<typeof parseSnapshot>}
 */
const createSnapshotLoader = ({ path: file = SNAPSHOT_PATH, readFile = fs.readFileSync } = {}) => {
  let cached = null;
  return () => {
    if (!cached) {
      let text;
      try {
        text = readFile(file, 'utf8');
      } catch {
        cached = { ok: false, reason: 'snapshot_missing' };
        return cached;
      }
      cached = parseSnapshot(text);
    }
    return cached;
  };
};

module.exports = { SNAPSHOT_PATH, SNAPSHOT_SCHEMA, PRECISIONS, parseSnapshot, createSnapshotLoader, priceOf };
