// src/server/ipCatalog/resolvePresets.js
// One resolver of preset routes for /api/warp and /api/iplist (3.2.0, spec 3.2.0 §5.1). Steps: aliases → retired
// presets (skipped, named in `warnings`) → presets without data (skipped, named) → catalogue presets from the
// snapshot ∪ transitional presets (§4.5) from the live lists, each preset on its own, with the snapshot reserve
// when its live call gives no IPv4 → the WARP endpoint cut and exact aggregation (I14), plus the cut of the
// addresses in `avoid4`/`avoid6` that the routes cover (a manual override, I15).
//
// `plan(keys)` is synchronous and touches no network, so a handler can refuse an empty set before Lab Auto and
// before any registration; `resolve(plan, opts)` does the live part.

'use strict';

const { aggregateCidrs, routeMatcher } = require('../cidrAggregate');
const { WARP_ENDPOINT_PREFIXES_V4, WARP_ENDPOINT_PREFIXES_V6 } = require('../warpEndpointPrefixes');
const { priceOf } = require('./snapshot');

const CATALOG_UNAVAILABLE_MESSAGE = 'Каталог адресов пресетов сейчас недоступен: split-туннель не собирается. Полный туннель работает.';
const LEGACY_PRECISION = 'wide';
const TELEMETRY_SOURCE = Object.freeze({ catalog: 'catalog', opencck: 'opencck', community: 'itdoginfo', mixed: 'fallback' });

const catalogUnavailable = () => Object.assign(new Error(CATALOG_UNAVAILABLE_MESSAGE), { statusCode: 503, code: 'catalog_unavailable' });

const normalizeKey = (raw) => String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
const sortedUnique = (list) => Array.from(new Set(list)).sort();

/**
 * @param {{
 *   presets: Record<string, { domains?: string[], legacy?: { communityLists?: string[] } }>,
 *   aliases?: Record<string, string>,
 *   retired?: string[],
 *   loadSnapshot: () => ({ ok: true, snapshot: { builtAt: string, presets: Record<string, any> } } | { ok: false, reason: string }),
 *   fetchLegacy?: (key: string, def: object, opts: { includeIpv6: boolean }) => Promise<{ cidrs4: string[], cidrs6: string[], source: string }>,
 * }} deps
 */
const createResolver = ({ presets, aliases = {}, retired = [], loadSnapshot, fetchLegacy }) => {
  const retiredSet = new Set(retired);

  /** The snapshot, or a 503 error before any registration. */
  const snapshotOrThrow = () => {
    const loaded = loadSnapshot();
    if (!loaded.ok) throw catalogUnavailable();
    return loaded.snapshot;
  };

  /**
   * Aliases, retired, unknown and no-data keys, in request order, without duplicates. Reads the snapshot only when a
   * live (not retired) preset is asked for; throws a 503 error when it is then unusable.
   * @param {string[]} keys
   */
  const plan = (keys) => {
    const canonicalKeys = [];
    const retiredKeys = [];
    const unknown = [];
    for (const raw of keys) {
      const key = normalizeKey(raw);
      if (!key) continue;
      const target = Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : key;
      if (retiredSet.has(target)) {
        if (!retiredKeys.includes(target)) retiredKeys.push(target);
      } else if (Object.prototype.hasOwnProperty.call(presets, target)) {
        if (!canonicalKeys.includes(target)) canonicalKeys.push(target);
      } else if (!unknown.includes(key)) {
        unknown.push(key);
      }
    }
    const snapshot = canonicalKeys.length ? snapshotOrThrow() : null;
    const noData = {};
    const active = [];
    for (const key of canonicalKeys) {
      const record = snapshot.presets[key];
      if (!record) noData[key] = 'not_in_snapshot';
      else if (!record.legacy && record.noData) noData[key] = record.noData;
      else active.push(key);
    }
    return { canonicalKeys, retired: retiredKeys, unknown, noData, active, snapshot };
  };

  /**
   * @param {ReturnType<typeof plan>} p
   * @param {{ includeIpv6?: boolean, avoid4?: string[], avoid6?: string[] }} [opts] `avoid4`/`avoid6`: addresses
   *   to keep out of AllowedIPs when the routes cover them (a manual endpoint)
   */
  const resolve = async (p, { includeIpv6 = false, avoid4 = [], avoid6 = [] } = {}) => {
    const presetStatus = {};
    const noData = { ...p.noData };
    for (const key of p.retired) presetStatus[key] = { source: 'retired' };

    const raw4 = [];
    const raw6 = [];
    const liveSources = new Set();
    const fallbackKeys = [];
    const legacyKeys = p.active.filter((key) => p.snapshot.presets[key].legacy);
    // Each transitional preset on its own call: the answer tells whether this preset has data (spec §4.5).
    const live = await Promise.all(legacyKeys.map((key) => Promise.resolve()
      .then(() => fetchLegacy(key, presets[key], { includeIpv6 }))
      .catch(() => null)));

    for (const key of p.active) {
      const record = p.snapshot.presets[key];
      if (!record.legacy) {
        raw4.push(...record.cidrs4);
        if (includeIpv6) raw6.push(...record.cidrs6);
        presetStatus[key] = { source: 'catalog', precision: record.precision, routes4: record.routes4 };
        continue;
      }
      const answer = live[legacyKeys.indexOf(key)];
      const cidrs4 = answer ? answer.cidrs4.filter((c) => !c.includes(':')) : [];
      if (cidrs4.length) {
        raw4.push(...cidrs4);
        if (includeIpv6) raw6.push(...(answer.cidrs6 || []));
        liveSources.add(answer.source);
        presetStatus[key] = { source: 'live', precision: LEGACY_PRECISION, routes4: priceOf(cidrs4) };
      } else if (!record.fallback.noData) {
        raw4.push(...record.fallback.cidrs4);
        if (includeIpv6) raw6.push(...record.fallback.cidrs6);
        fallbackKeys.push(key);
        presetStatus[key] = { source: 'catalog-fallback', precision: record.fallback.precision, routes4: record.fallback.routes4 };
      } else {
        noData[key] = record.fallback.noData;
      }
    }
    for (const [key, reason] of Object.entries(noData)) presetStatus[key] = { source: 'noData', noData: reason };

    const warnings = [];
    if (p.retired.length) warnings.push(`Presets retired: ${p.retired.join(', ')}`);
    const noDataKeys = p.canonicalKeys.filter((key) => noData[key]);
    if (noDataKeys.length) warnings.push(`Presets without data: ${noDataKeys.join(', ')}`);
    if (fallbackKeys.length) warnings.push(`Route source fallback: ${fallbackKeys.join(', ')}`);

    const unique4 = sortedUnique(raw4);
    const unique6 = sortedUnique(raw6);
    const exclude = WARP_ENDPOINT_PREFIXES_V4;
    const exclude6 = includeIpv6 ? WARP_ENDPOINT_PREFIXES_V6 : [];
    let aggregated = aggregateCidrs([...unique4, ...unique6], { exclude, exclude6 });
    // An address of `avoid4`/`avoid6` inside the routes leaves them as a /32 (/128) (I14 with O4/O6, I15).
    const routed = routeMatcher(aggregated.cidrs);
    const inside4 = avoid4.filter((address) => routed(address));
    const inside6 = includeIpv6 ? avoid6.filter((address) => routed(address)) : [];
    if (inside4.length || inside6.length) {
      aggregated = aggregateCidrs([...unique4, ...unique6], {
        exclude: [...exclude, ...inside4.map((a) => `${a}/32`)],
        exclude6: [...exclude6, ...inside6.map((a) => `${a}/128`)],
      });
    }

    const cidrSource = liveSources.size === 0 ? 'catalog' : liveSources.size === 1 ? [...liveSources][0] : 'mixed';
    return {
      canonicalKeys: p.canonicalKeys,
      raw4: unique4,
      raw6: unique6,
      cidrs: aggregated.cidrs,
      before4: aggregated.before4,
      after4: aggregated.after4,
      count6: aggregated.count6,
      presetStatus,
      cidrSource,
      telemetrySource: TELEMETRY_SOURCE[cidrSource] || 'fallback',
      warnings,
      avoidInside: [...inside4, ...inside6],
    };
  };

  /**
   * Price and precision of every preset for the catalogue (spec §5.2): a catalogue preset its `routes4`, a
   * transitional one its `liveRoutes4` of the last build. Null when the snapshot cannot be used.
   */
  const prices = () => {
    const loaded = loadSnapshot();
    if (!loaded.ok) return null;
    const out = {};
    for (const key of Object.keys(presets)) {
      const record = loaded.snapshot.presets[key];
      if (!record) out[key] = { source: 'catalog', routes4: 0, precision: null, noData: 'not_in_snapshot' };
      else if (record.legacy) out[key] = { source: 'live', routes4: record.liveRoutes4, precision: LEGACY_PRECISION, noData: null };
      else out[key] = { source: 'catalog', routes4: record.routes4, precision: record.precision, noData: record.noData };
    }
    return { builtAt: loaded.snapshot.builtAt, presets: out };
  };

  return { plan, resolve, prices };
};

module.exports = { createResolver, catalogUnavailable, CATALOG_UNAVAILABLE_MESSAGE };
