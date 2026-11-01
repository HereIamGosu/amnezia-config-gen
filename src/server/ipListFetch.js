const https = require('https');
const { randomInt } = require('crypto');
const { URLSearchParams } = require('url');
const { fetchCommunityCidrs } = require('./communityIpFetch');

const IP_LIST_HOST = 'iplist.opencck.org';
const IP_LIST_TIMEOUT_MS = 25000;
const MAX_IP_LIST_RESPONSE_BYTES = 8 * 1024 * 1024;
const RETRY_MAX = 5;
const RETRY_BASE_MS = 400;
const RETRY_MAX_MS = 10000;

/**
 * In-memory CIDR cache: keyed by sorted comma-joined hostnames + ip version flag + community lists, TTL 10 min.
 * Only answers with routes are cached (3.2.0): an empty answer after a source failure is asked again next time.
 */
const CIDR_CACHE_TTL_MS = 10 * 60 * 1000;
const CIDR_CACHE_MAX_ENTRIES = 200;
/** @type {Map<string, { cidrs: string[], ts: number }>} */
const cidrCache = new Map();

const cidrCacheKey = (sites, includeIpv6, communityLists) =>
  `${sites.slice().sort().join(',')}_${includeIpv6 ? '46' : '4'}` +
  `_c:${(communityLists || []).slice().sort().join('|')}`;

const cidrCacheGet = (key) => {
  const entry = cidrCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CIDR_CACHE_TTL_MS) {
    cidrCache.delete(key);
    return null;
  }
  return entry.cidrs;
};

/** @param {string} cidr */
const isIpv4Cidr = (cidr) => /^\d{1,3}(\.\d{1,3}){3}\/\d+$/.test(cidr);

const cidrCacheSet = (key, cidrs) => {
  if (cidrCache.size >= CIDR_CACHE_MAX_ENTRIES) {
    const oldest = cidrCache.keys().next().value;
    cidrCache.delete(oldest);
  }
  cidrCache.set(key, { cidrs, ts: Date.now() });
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isTransient = (err) => {
  if (!err) return false;
  const c = err.statusCode;
  if (c === 429 || c === 502 || c === 503 || c === 504) return true;
  const sys = err.code;
  if (sys && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(sys)) {
    return true;
  }
  return /таймаут|timeout|Timeout/i.test(String(err.message || ''));
};

/**
 * Build query path: multiple site= parameters (JSON CIDR map per data type).
 * @param {string[]} sites hostnames
 * @param {'cidr4'|'cidr6'} dataType
 */
const buildIpListPath = (sites, dataType = 'cidr4') => {
  const params = new URLSearchParams();
  params.set('format', 'json');
  params.set('data', dataType);
  for (const s of sites) {
    const h = String(s).trim().toLowerCase();
    if (h) params.append('site', h);
  }
  return `/?${params.toString()}`;
};

const flattenCidrMap = (obj) => {
  const out = new Set();
  if (!obj || typeof obj !== 'object') return out;
  for (const arr of Object.values(obj)) {
    if (!Array.isArray(arr)) continue;
    for (const c of arr) {
      const x = String(c).trim();
      if (x) out.add(x);
    }
  }
  return out;
};

/** Returns true if any domain key in the opencck response has an empty CIDR array. */
const hasEmptyDomains = (obj, sites) => {
  if (!obj || typeof obj !== 'object') return true;
  return sites.some((s) => {
    const arr = obj[s];
    return !Array.isArray(arr) || arr.length === 0;
  });
};

const httpsJsonOnce = (path) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };

    const req = https.request(
      {
        hostname: IP_LIST_HOST,
        port: 443,
        path,
        method: 'GET',
        agent: false,
        headers: { Accept: 'application/json', 'User-Agent': 'amnezia-config-gen/1.0' },
      },
      (res) => {
        let buf = '';
        let n = 0;
        res.on('data', (chunk) => {
          n += chunk.length;
          if (n > MAX_IP_LIST_RESPONSE_BYTES) {
            req.destroy();
            done(new Error('Ответ сервиса списков IP слишком большой'));
            return;
          }
          buf += chunk;
        });
        res.on('end', () => {
          try {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              const e = new Error(`Сервис списков IP вернул HTTP ${res.statusCode}`);
              e.statusCode = res.statusCode;
              done(e);
              return;
            }
            const parsed = buf ? JSON.parse(buf) : {};
            done(null, parsed);
          } catch (e) {
            const err = new Error('Некорректный JSON от сервиса списков IP');
            err.cause = e;
            done(err);
          }
        });
      },
    );
    req.on('error', (e) => {
      const err = new Error(e.message);
      err.code = e.code;
      done(err);
    });
    // Armed only once the request exists: if https.request throws synchronously, no timer is left to touch an
    // uninitialised `req`.
    timer = setTimeout(() => {
      req.destroy();
      done(new Error('Таймаут запроса к сервису списков IP.'));
    }, IP_LIST_TIMEOUT_MS);
    req.end();
  });

const fetchWithRetry = async (path) => {
  let last;
  for (let i = 0; i < RETRY_MAX; i += 1) {
    try {
      return await httpsJsonOnce(path);
    } catch (e) {
      last = e;
      if (!isTransient(e) || i === RETRY_MAX - 1) throw e;
      const jitter = randomInt(0, 280);
      const d = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** i + jitter);
      await sleep(d);
    }
  }
  throw last;
};

/**
 * Resolve CIDRs for hostnames with a targeted cascade (in-memory cache, TTL 10 min):
 *   1. opencck (primary, per-domain)
 *   2. itdoginfo community lists — only when domains have gaps and the preset is mapped
 * There is no third stage (3.2.0, K2): the antifilter list of foreign networks is gone; a preset without an answer
 * takes its reserve from the catalogue snapshot (src/server/ipCatalog/resolvePresets.js).
 * By default only IPv4 CIDRs are returned. Pass { includeIpv6: true } to also include IPv6.
 * Note: includeIpv6 affects only the opencck stage; the community supplement is always IPv4-only
 * (route-table size constraints).
 * @param {string[]} sites unique hostnames
 * @param {{ includeIpv6?: boolean, communityLists?: string[] }} [opts]
 * @returns {Promise<{ cidrs: string[], source: 'opencck' | 'community' | 'mixed' }>}
 */
const fetchCidrsForDomains = async (
  sites,
  { includeIpv6 = false, communityLists = [] } = {},
) => {
  if (!sites.length) return { cidrs: [], source: 'opencck' };

  const cacheKey = cidrCacheKey(sites, includeIpv6, communityLists);
  const cached = cidrCacheGet(cacheKey);
  if (cached) return { cidrs: cached, source: cached._source || 'opencck' };

  let merged = new Set();
  let source = 'opencck';
  let opencckFailed = false;
  let hasGaps = false;

  try {
    const path4 = buildIpListPath(sites, 'cidr4');
    const fetches = [fetchWithRetry(path4)];
    if (includeIpv6) fetches.push(fetchWithRetry(buildIpListPath(sites, 'cidr6')));

    const [res4, res6] = await Promise.allSettled(fetches);

    if (res4.status === 'rejected') {
      throw res4.reason;
    }
    const data4 = res4.value;
    // An IPv6 entry in the cidr4 answer would bypass the IPv4-only default (I6); every other entry passes as before.
    merged = new Set([...flattenCidrMap(data4)].filter((c) => !c.includes(':')));
    hasGaps = hasEmptyDomains(data4, sites);

    if (includeIpv6 && res6 && res6.status === 'fulfilled') {
      for (const c of flattenCidrMap(res6.value)) merged.add(c);
    }
  } catch {
    // opencck unavailable
    merged = new Set();
    opencckFailed = true;
    hasGaps = true;
  }

  const opencckCount = merged.size;

  // Targeted supplement: itdoginfo community lists, only when there are gaps and a mapping exists.
  if ((hasGaps || opencckFailed) && communityLists.length) {
    try {
      const ccCidrs = await fetchCommunityCidrs(communityLists);
      for (const c of ccCidrs) merged.add(c);
      if (merged.size > opencckCount) {
        source = opencckCount > 0 ? 'mixed' : 'community';
      }
    } catch { /* community source failed — ignore */ }
  }

  const result = Array.from(merged).sort();
  result._source = source;
  if (result.length) cidrCacheSet(cacheKey, result);
  return { cidrs: result, source };
};

/**
 * The live routes of one transitional preset (3.2.0, spec 3.2.0 §4.5): opencck for its domains, itdoginfo for its
 * lists, each preset on its own call, so its answer says whether this preset has data. `legacy.cidrs4` (the fixed
 * networks a preset of 3.1.9 added to its lists) join an answer with IPv4 routes, never an empty one: then the
 * resolver takes the snapshot reserve. Called through the module object so tests can replace fetchCidrsForDomains.
 * @param {{ domains?: string[], legacy?: { communityLists?: string[], cidrs4?: string[] } }} def
 * @param {{ includeIpv6?: boolean }} [opts]
 * @returns {Promise<{ cidrs4: string[], cidrs6: string[], source: string }>}
 */
const fetchLegacyCidrs = async (def, { includeIpv6 = false } = {}) => {
  const legacy = def.legacy || {};
  const { cidrs, source } = await module.exports.fetchCidrsForDomains(def.domains || [], {
    includeIpv6,
    communityLists: legacy.communityLists || [],
  });
  const cidrs4 = cidrs.filter((c) => !c.includes(':'));
  const fixed = cidrs4.length ? (legacy.cidrs4 || []).filter((c) => !cidrs4.includes(c)) : [];
  return { cidrs4: [...cidrs4, ...fixed], cidrs6: cidrs.filter((c) => c.includes(':')), source };
};

module.exports = {
  IP_LIST_HOST,
  fetchCidrsForDomains,
  fetchLegacyCidrs,
  buildIpListPath,
  isIpv4Cidr,
};
