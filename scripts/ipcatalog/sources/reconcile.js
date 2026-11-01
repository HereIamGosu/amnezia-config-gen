// scripts/ipcatalog/sources/reconcile.js
// Comparison sources for the build summary only (spec 3.2.0 §4.2, §9 p. 3, K9): the opencck API (ip4 of the portals
// a preset's domains name, the reference of coverage), itdoginfo lists and antonme/ipnames resolutions from Moscow and
// Saint Petersburg (no licence on either). Nothing of these goes into the snapshot.

'use strict';

const net = require('net');
const { routeMatcher } = require('../../../src/server/cidrAggregate');

const opencckUrl = (domains, data) => {
  const params = new URLSearchParams({ format: 'json', data });
  for (const d of domains) params.append('site', d);
  return `https://iplist.opencck.org/?${params}`;
};
const itdoginfoUrl = (list) => `https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Subnets/IPv4/${list}.lst`;
const ipnamesUrl = (service) => `https://raw.githubusercontent.com/antonme/ipnames/master/resolve-${service}.txt`;

// Presets that have a counterpart in the comparison sources.
const ITDOGINFO_LISTS = Object.freeze({
  telegram: 'telegram', twitter: 'Twitter', discord: 'Discord', instagram: 'Meta', facebook: 'Meta', whatsapp: 'Meta',
  roblox: 'roblox', cloudflare: 'cloudflare',
});
const IPNAMES_SERVICES = Object.freeze({
  openai: 'openai', tiktok: 'tiktok', twitter: 'twitter', github: 'github', google: 'google', youtube: 'youtube',
  instagram: 'facebook', facebook: 'facebook',
});

/** Union of the opencck `json` answer (`{ site: [values] }`) over the asked domains. */
const parseOpencck = (text) => {
  const doc = JSON.parse(text);
  const out = new Set();
  for (const list of Object.values(doc && typeof doc === 'object' ? doc : {})) {
    if (Array.isArray(list)) for (const v of list) out.add(String(v).trim());
  }
  return [...out].filter(Boolean).sort();
};

const parseLines = (text) => String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

/**
 * The share of `reference` IPv4 addresses that `cidrs` cover.
 * @returns {{ reference: number, covered: number, share: number|null }}
 */
const coverageOf = (reference, cidrs) => {
  const routed = routeMatcher(cidrs);
  const addresses = Array.from(new Set(reference.map((a) => a.replace(/\/32$/, '')).filter((a) => net.isIPv4(a))));
  const covered = addresses.filter((a) => routed(a)).length;
  return { reference: addresses.length, covered, share: addresses.length ? covered / addresses.length : null };
};

/** The comparison data of one preset; a source that fails is null, never an error. */
const reconcilePreset = async (get, key, domains) => {
  const safe = async (fn) => { try { return await fn(); } catch { return null; } };
  return {
    opencckIp4: domains.length ? await safe(async () => parseOpencck(await get(opencckUrl(domains, 'ip4')))) : null,
    opencckCidr4: domains.length ? await safe(async () => parseOpencck(await get(opencckUrl(domains, 'cidr4')))) : null,
    itdoginfo: ITDOGINFO_LISTS[key] ? await safe(async () => parseLines(await get(itdoginfoUrl(ITDOGINFO_LISTS[key])))) : null,
    ipnames: IPNAMES_SERVICES[key] ? await safe(async () => parseLines(await get(ipnamesUrl(IPNAMES_SERVICES[key])))) : null,
  };
};

module.exports = {
  opencckUrl, itdoginfoUrl, ipnamesUrl, ITDOGINFO_LISTS, IPNAMES_SERVICES, parseOpencck, parseLines, coverageOf, reconcilePreset,
};
