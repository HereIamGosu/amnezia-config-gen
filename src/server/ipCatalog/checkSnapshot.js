// src/server/ipCatalog/checkSnapshot.js
// Checks of the committed snapshot without network (spec 3.2.0 §4.4). One module for `npm run ipcatalog:check` and
// __tests__/ipcatalog-snapshot.test.js, so CI checks the file through `npm test`. Coverage, jumps against the previous
// snapshot, failed sources and the comparison with other lists belong to the build summary (§9), not here.

'use strict';

const { aggregateCidrs } = require('../cidrAggregate');
const { parseSnapshot, SNAPSHOT_SCHEMA, PRECISIONS } = require('./snapshot');
const { rejectReason4, rejectReason6 } = require('./addressFilters');

/** Most routes a preset may cost without `precision: 'wide'` (spec §4.4). */
const MAX_ROUTES_WITHOUT_WIDE = 300;

const isSorted = (list) => list.every((value, i) => i === 0 || list[i - 1] < value);
const allowsWide = (def) => (def.ip || []).some((step) => step.from === 'official' && step.allowWide === true);

/**
 * @param {string} text the snapshot file
 * @param {{ presets: Record<string, { legacy?: object, ip?: object[] }>, retired?: string[] }} catalog
 * @returns {string[]} problems; empty when the snapshot passes
 */
const checkSnapshot = (text, { presets, retired = [] }) => {
  const problems = [];
  const parsed = parseSnapshot(text);
  if (!parsed.ok) return [`snapshot cannot be used: ${parsed.reason}`];
  const doc = JSON.parse(text);
  if (doc.schema !== SNAPSHOT_SCHEMA) problems.push(`schema ${doc.schema}`);
  if (!isSorted(Object.keys(doc.presets))) problems.push('preset keys are not sorted');
  if (doc.sources && !isSorted(Object.keys(doc.sources))) problems.push('source keys are not sorted');

  const expected = Object.keys(presets).filter((key) => !retired.includes(key));
  for (const key of expected) if (!doc.presets[key]) problems.push(`${key}: missing from the snapshot`);
  for (const key of Object.keys(doc.presets)) if (!expected.includes(key)) problems.push(`${key}: not a catalogue preset`);

  const checkSet = (where, set, def, priced) => {
    for (const [family, list] of [[4, set.cidrs4], [6, set.cidrs6 || []]]) {
      if (!isSorted(list)) problems.push(`${where}.cidrs${family}: not sorted or not unique`);
      for (const cidr of list) {
        const reason = family === 4 ? rejectReason4(cidr, { allowWide: allowsWide(def) }) : rejectReason6(cidr, { allowWide: allowsWide(def) });
        if (reason) problems.push(`${where}.cidrs${family}: ${cidr} is ${reason}`);
      }
    }
    for (const seen of ['seen4', 'seen6']) {
      if (set[seen] && !isSorted(Object.keys(set[seen]))) problems.push(`${where}.${seen}: keys not sorted`);
    }
    if (!set.cidrs4.length && !set.noData) problems.push(`${where}: no IPv4 routes and no noData reason`);
    if (set.cidrs4.length && JSON.stringify(aggregateCidrs(set.cidrs4).cidrs) !== JSON.stringify(set.cidrs4)) {
      problems.push(`${where}.cidrs4: not aggregated`);
    }
    if (!PRECISIONS.includes(set.precision)) problems.push(`${where}.precision: ${set.precision}`);
    if (priced.routes4 > MAX_ROUTES_WITHOUT_WIDE && set.precision !== 'wide') {
      problems.push(`${where}: ${priced.routes4} routes without precision "wide"`);
    }
  };

  for (const key of expected) {
    const record = doc.presets[key];
    const def = presets[key];
    if (!record) continue;
    const isLegacy = record.legacy === true;
    if (isLegacy !== Boolean(def.legacy)) {
      problems.push(`${key}: ${isLegacy ? 'transitional in the snapshot, not in routePresets.js' : 'transitional in routePresets.js, not in the snapshot'}`);
    }
    const priced = parsed.snapshot.presets[key];
    if (isLegacy) checkSet(`${key}.fallback`, record.fallback, def, priced.fallback);
    else checkSet(key, record, def, priced);
  }
  return problems;
};

module.exports = { checkSnapshot, MAX_ROUTES_WITHOUT_WIDE };
