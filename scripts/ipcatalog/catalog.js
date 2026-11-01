// scripts/ipcatalog/catalog.js
// Builds the preset address catalogue (spec 3.2.0 §4.2–§4.3) from the recipes of src/server/routePresets.js:
// official lists, AS announcements, own DoH resolution of domains (the preset's own and those of opencck portals) and
// static networks. Every output entry passes the address filters; IPv4 is aggregated exactly without the WARP
// endpoint cut (the cut belongs to the request, one rule in one place). Resolved addresses stay for 30 days after
// they were last seen. A source that fails after the retries leaves the preset with its previous record, marked
// `stale` with the date of that data; a release build forbids it (§9).
//
// Deterministic: every date comes from the one `now` the caller passes, keys and CIDRs are sorted, and the result
// is serialised with sorted object keys, so the same answers give the same bytes.

'use strict';

const crypto = require('crypto');
const { aggregateCidrs, STRICT_IPV4_CIDR } = require('../../src/server/cidrAggregate');
const { rejectReason4, rejectReason6 } = require('../../src/server/ipCatalog/addressFilters');
const { SNAPSHOT_SCHEMA, priceOf } = require('../../src/server/ipCatalog/snapshot');
const { MAX_ROUTES_WITHOUT_WIDE } = require('../../src/server/ipCatalog/checkSnapshot');
const { WARP_ENDPOINT_PREFIXES_V4 } = require('../../src/server/warpEndpointPrefixes');
const { OFFICIAL_LISTS } = require('./sources/official');
const { fetchAsn, createIptoasn, ipverseUrl } = require('./sources/asn');
const { resolveDomain, ECS_POINTS, DOH_URL, cleanHostname, canonical6 } = require('./sources/doh');
const { createPortalReader, REPO } = require('./sources/portal');
const { coverageOf } = require('./sources/reconcile');
const { mapPool } = require('./lib/net');

const DOH_CONCURRENCY = 8;
const MAX_DOMAINS = 600;
const SEEN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const isoSeconds = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const sortedUnique = (list) => Array.from(new Set(list)).sort();
// The digest key ends with Digest: a source digest is a checksum, and secret scans skip keys named so.
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  return value;
};
/** The snapshot file text: sorted keys, two-space indentation, a final newline. */
const serializeSnapshot = (doc) => `${JSON.stringify(sortKeys(doc), null, 2)}\n`;

const addressCount4 = (cidrs4) => cidrs4.reduce((sum, c) => sum + 2 ** (32 - Number(c.split('/')[1])), 0);

/** A short text of a recipe for the summary. */
const describeRecipe = (def) => (def.ip || []).map((step) => {
  if (step.from === 'official') return `official ${step.list}`;
  if (step.from === 'asn') return `asn ${step.asns.join(' ')}${step.minus ? ` − ${step.minus}` : ''}`;
  if (step.from === 'portal') return `portal ${step.portals.join(', ')}`;
  if (step.from === 'static') return `static ${step.cidrs4.length} (${step.source}, ${step.date})`;
  return 'resolve';
}).join(' + ');

/**
 * @param {{
 *   presets: Record<string, object>, retired?: string[], previous?: object|null, now: Date,
 *   get: (url: string, opts?: object) => Promise<string|Buffer>,
 *   liveRoutes4?: (key: string, def: object) => Promise<number|null>,
 *   points?: Array<{ id: string, subnet: string }>, log?: (line: string) => void,
 * }} opts
 * @returns {Promise<{ text: string, doc: object, summary: object }>}
 */
const buildCatalog = async ({
  presets, retired = [], previous = null, now, get, liveRoutes4 = async () => null, points = ECS_POINTS, log = () => {},
}) => {
  const builtAt = isoSeconds(now);
  const today = builtAt.slice(0, 10);
  const seenCutoff = isoSeconds(new Date(now.getTime() - SEEN_DAYS * DAY_MS)).slice(0, 10);
  const sources = {};
  const memo = new Map();
  const once = (key, fn) => {
    if (!memo.has(key)) memo.set(key, fn());
    return memo.get(key);
  };

  const allAsns = sortedUnique(Object.values(presets).flatMap((d) => (d.ip || []).filter((s) => s.from === 'asn').flatMap((s) => s.asns)));
  const iptoasn = createIptoasn(get, allAsns);
  const portals = createPortalReader(get);
  let dohDomains = 0;

  const official = (list) => once(`official:${list}`, async () => {
    const defs = OFFICIAL_LISTS[list];
    if (!defs) throw new Error(`unknown official list ${list}`);
    const out = { cidrs4: [], cidrs6: [] };
    for (const src of defs) {
      try {
        const text = await get(src.url);
        const parsed = src.parse(text);
        out.cidrs4.push(...parsed.cidrs4);
        out.cidrs6.push(...parsed.cidrs6);
        sources[src.id] = { fetchedAt: builtAt, ok: true, sha256Digest: sha256(text), url: src.url };
      } catch (err) {
        sources[src.id] = { error: String(err.message), fetchedAt: builtAt, ok: false, url: src.url };
        throw new Error(`${src.id}: ${err.message}`);
      }
    }
    return out;
  });

  const asnOf = (asn) => once(`asn:${asn}`, async () => {
    try {
      const r = await fetchAsn(get, asn, { iptoasn });
      sources[`asn-${asn}`] = { fetchedAt: builtAt, ok: true, sha256Digest: sha256(JSON.stringify(r)), url: ipverseUrl(asn, 4), via: r.via };
      return r;
    } catch (err) {
      sources[`asn-${asn}`] = { error: String(err.message), fetchedAt: builtAt, ok: false, url: ipverseUrl(asn, 4) };
      throw new Error(`asn ${asn}: ${err.message}`);
    }
  });

  const dohOf = (domain) => once(`doh:${domain}`, async () => {
    dohDomains += 1;
    return resolveDomain(get, domain, points);
  });

  /** Own resolution of a domain list: addresses as /32 and /128. Throws when DoH fails after the retries. */
  const resolveAll = async (domains) => {
    const answers = await mapPool(domains, DOH_CONCURRENCY, (d) => dohOf(d));
    return { v4: sortedUnique(answers.flatMap((a) => a.v4)), v6: sortedUnique(answers.flatMap((a) => a.v6)) };
  };

  /** Merges today's resolution with the previous `seen` map: entries seen within 30 days stay. */
  const mergeSeen = (fresh, previousSeen) => {
    const out = {};
    for (const [cidr, date] of Object.entries(previousSeen || {})) if (date >= seenCutoff) out[cidr] = date;
    for (const cidr of fresh) out[cidr] = today;
    return sortKeys(out);
  };

  /** One address set from a recipe (a catalogue preset, or the reserve of a transitional one). */
  const buildSet = async (key, def, previousSet) => {
    const v4 = [];
    const v6 = [];
    const domains = new Set();
    let usesResolve = false;
    const notes = [];
    for (const step of def.ip || []) {
      if (step.from === 'official') {
        const r = await official(step.list);
        v4.push(...r.cidrs4);
        v6.push(...r.cidrs6);
      } else if (step.from === 'asn') {
        const parts = [];
        for (const asn of step.asns) parts.push(await asnOf(asn));
        for (const [i, part] of parts.entries()) if (part.via === 'not_announced') notes.push(`AS${step.asns[i]} not announced`);
        let a4 = parts.flatMap((p) => p.cidrs4).filter((c) => STRICT_IPV4_CIDR.test(c));
        let a6 = parts.flatMap((p) => p.cidrs6);
        if (step.minus === 'google-cloud') {
          const cloud = await official('google-cloud');
          a4 = aggregateCidrs(a4, { exclude: cloud.cidrs4.filter((c) => STRICT_IPV4_CIDR.test(c)) }).cidrs;
          a6 = aggregateCidrs(a6, { exclude6: cloud.cidrs6.filter((c) => !rejectReason6(c, { allowWide: true })) }).cidrs;
        } else if (step.minus) {
          throw new Error(`${key}: unknown minus ${step.minus}`);
        }
        v4.push(...a4);
        v6.push(...a6);
      } else if (step.from === 'static') {
        v4.push(...step.cidrs4);
        v6.push(...(step.cidrs6 || []));
      } else if (step.from === 'resolve') {
        usesResolve = true;
        for (const d of step.domains || def.domains || []) if (cleanHostname(d)) domains.add(cleanHostname(d));
      } else if (step.from === 'portal') {
        usesResolve = true;
        for (const portal of step.portals) for (const d of await portals.domainsOf(portal)) domains.add(d);
      } else {
        throw new Error(`${key}: unknown recipe step ${step.from}`);
      }
    }

    let seen4 = {};
    let seen6 = {};
    const tooManyDomains = domains.size > MAX_DOMAINS;
    if (usesResolve && !tooManyDomains) {
      const resolved = await resolveAll([...domains].sort());
      seen4 = mergeSeen(resolved.v4.filter((c) => !rejectReason4(c)), previousSet && previousSet.seen4);
      seen6 = mergeSeen(resolved.v6.filter((c) => !rejectReason6(c)), previousSet && previousSet.seen6);
    } else if (tooManyDomains) {
      notes.push(`${domains.size} domains > ${MAX_DOMAINS}: not resolved, must be transitional`);
    }

    const allowWide = (def.ip || []).some((s) => s.from === 'official' && s.allowWide === true);
    const dropped = {};
    const keep = (list, reasonOf) => list.filter((c) => {
      const reason = reasonOf(c, { allowWide });
      if (reason) dropped[reason] = (dropped[reason] || 0) + 1;
      return !reason;
    });
    const cidrs4 = aggregateCidrs(keep([...v4, ...Object.keys(seen4)], rejectReason4)).cidrs;
    // IPv6 is not aggregated (spec R6 D5); the text is made canonical so one network is written one way.
    const canonical6Cidr = (c) => `${canonical6(c.split('/')[0])}/${c.split('/')[1]}`;
    const cidrs6 = sortedUnique(keep([...v6, ...Object.keys(seen6)], rejectReason6).map(canonical6Cidr));
    const routes4 = priceOf(cidrs4);
    const precision = tooManyDomains || routes4 > MAX_ROUTES_WITHOUT_WIDE ? 'wide' : usesResolve ? 'approx' : 'exact';

    // Coverage on own data (spec §9 p. 3): the preset's own domains, resolved, against its routes after the cut.
    let coverage = null;
    if ((def.domains || []).length) {
      try {
        const own = await resolveAll(sortedUnique((def.domains || []).map(cleanHostname).filter(Boolean)));
        const c = coverageOf(own.v4, aggregateCidrs(cidrs4, { exclude: WARP_ENDPOINT_PREFIXES_V4 }).cidrs);
        coverage = { covered: c.covered, reference: c.reference };
      } catch {
        notes.push('own coverage not resolved');
      }
    }
    const set = {
      addrs4: addressCount4(cidrs4),
      cidrs4,
      cidrs6,
      coverage,
      noData: cidrs4.length ? null : (tooManyDomains ? 'too_many_domains' : 'no_ipv4_addresses'),
      precision,
      seen4,
      seen6,
      stale: null,
    };
    return { set, info: { domains: domains.size, dropped, notes, routes4 } };
  };

  const summary = { builtAt, failed: [], stale: [], presets: {} };
  const out = {};
  const keys = Object.keys(presets).filter((k) => !retired.includes(k)).sort();
  for (const key of keys) {
    const def = presets[key];
    const prev = previous && previous.presets ? previous.presets[key] : null;
    const isLegacy = Boolean(def.legacy);
    const prevSet = prev ? (prev.legacy ? prev.fallback : prev) : null;
    const staleDate = (record) => record.stale || previous.builtAt;
    let set;
    let info;
    try {
      ({ set, info } = await buildSet(key, def, prevSet));
    } catch (err) {
      summary.failed.push({ key, error: String(err.message) });
      log(`${key}: ${err.message}`);
      if (prevSet) {
        set = { ...prevSet, stale: staleDate(prevSet) };
        summary.stale.push(key);
      } else {
        set = { addrs4: 0, cidrs4: [], cidrs6: [], coverage: null, noData: 'source_failed', precision: 'exact', seen4: {}, seen6: {}, stale: null };
      }
      info = { domains: 0, dropped: {}, notes: ['previous record kept'], routes4: priceOf(set.cidrs4) };
    }
    const entry = { legacy: isLegacy, recipe: describeRecipe(def), set, ...info };
    if (isLegacy) {
      let live = null;
      try {
        live = await liveRoutes4(key, def);
      } catch {
        live = null;
      }
      let record;
      if (Number.isInteger(live) && live > 0) {
        record = { fallback: set, legacy: true, liveRoutes4: live, stale: null };
      } else if (prev && prev.legacy) {
        record = { fallback: set, legacy: true, liveRoutes4: prev.liveRoutes4, stale: prev.stale || previous.builtAt };
        summary.stale.push(`${key} (live)`);
      } else {
        record = { fallback: set, legacy: true, liveRoutes4: 0, stale: null };
        summary.failed.push({ key, error: 'live routes: no IPv4 answer' });
      }
      entry.liveRoutes4 = record.liveRoutes4;
      out[key] = record;
    } else {
      out[key] = set;
    }
    summary.presets[key] = entry;
  }

  if (dohDomains) {
    sources.doh = { domains: dohDomains, ecs: points.map(({ id, subnet, ripe }) => ({ id, ripe, subnet })), fetchedAt: builtAt, url: DOH_URL };
  }
  try {
    if (Object.values(presets).some((d) => (d.ip || []).some((s) => s.from === 'portal'))) {
      sources['rekryt-iplist'] = { commit: await portals.commit(), fetchedAt: builtAt, url: `https://github.com/${REPO}` };
    }
  } catch {
    /* the failure is already recorded by the presets that needed a portal */
  }

  const doc = { builtAt, presets: out, schema: SNAPSHOT_SCHEMA, sources };
  return { text: serializeSnapshot(doc), doc, summary };
};

module.exports = { buildCatalog, serializeSnapshot, describeRecipe, MAX_DOMAINS, SEEN_DAYS, DOH_CONCURRENCY };
