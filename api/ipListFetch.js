const https = require('https');
const { randomInt } = require('crypto');
const { URLSearchParams } = require('url');

const IP_LIST_HOST = 'iplist.opencck.org';
const IP_LIST_TIMEOUT_MS = 25000;
const MAX_IP_LIST_RESPONSE_BYTES = 8 * 1024 * 1024;
const RETRY_MAX = 5;
const RETRY_BASE_MS = 400;
const RETRY_MAX_MS = 10000;

// ── Antifilter fallback ───────────────────────────────────────────────────────
const ANTIFILTER_HOST = 'antifilter.download';
const ANTIFILTER_PATH = '/list/subnet.lst';
const ANTIFILTER_TIMEOUT_MS = 10000;
const ANTIFILTER_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min (matches their update cadence)
/** @type {{ cidrs: string[], ts: number } | null} */
let antifilterCache = null;

const fetchAntifilterOnce = () =>
  new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };
    const timer = setTimeout(() => { req.destroy(); done(new Error('antifilter timeout')); }, ANTIFILTER_TIMEOUT_MS);
    const req = https.request(
      { hostname: ANTIFILTER_HOST, port: 443, path: ANTIFILTER_PATH, method: 'GET', agent: false,
        headers: { 'User-Agent': 'amnezia-config-gen/1.0' } },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            done(new Error(`antifilter HTTP ${res.statusCode}`));
            return;
          }
          const cidrs = buf.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
          done(null, cidrs);
        });
      },
    );
    req.on('error', (e) => done(e));
    req.end();
  });

const getAntifilterCidrs = async () => {
  if (antifilterCache && Date.now() - antifilterCache.ts < ANTIFILTER_CACHE_TTL_MS) {
    return antifilterCache.cidrs;
  }
  const cidrs = await fetchAntifilterOnce();
  antifilterCache = { cidrs, ts: Date.now() };
  return cidrs;
};

/** In-memory CIDR cache: keyed by sorted comma-joined hostnames + ip version flag, TTL 10 min. */
const CIDR_CACHE_TTL_MS = 10 * 60 * 1000;
const CIDR_CACHE_MAX_ENTRIES = 200;
/** @type {Map<string, { cidrs: string[], ts: number }>} */
const cidrCache = new Map();

const cidrCacheKey = (sites, includeIpv6) =>
  `${sites.slice().sort().join(',')}_${includeIpv6 ? '46' : '4'}`;

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

const httpsJsonOnce = (path) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };

    const timer = setTimeout(() => {
      req.destroy();
      done(new Error('Таймаут запроса к сервису списков IP.'));
    }, IP_LIST_TIMEOUT_MS);

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
 * Fetch CIDRs for hostnames (with in-memory cache, TTL 10 min).
 * Falls back to antifilter.download/list/subnet.lst when opencck is unavailable or returns 0 CIDRs.
 * By default only IPv4 CIDRs are returned. Pass { includeIpv6: true } to also include IPv6.
 * @param {string[]} sites unique hostnames
 * @param {{ includeIpv6?: boolean }} [opts]
 * @returns {Promise<{ cidrs: string[], source: 'opencck' | 'antifilter' }>}
 */
const fetchCidrsForDomains = async (sites, { includeIpv6 = false } = {}) => {
  if (!sites.length) return { cidrs: [], source: 'opencck' };

  const cacheKey = cidrCacheKey(sites, includeIpv6);
  const cached = cidrCacheGet(cacheKey);
  if (cached) return { cidrs: cached, source: cached._source || 'opencck' };

  let merged = new Set();
  let source = 'opencck';

  try {
    const path4 = buildIpListPath(sites, 'cidr4');
    const data4 = await fetchWithRetry(path4);
    merged = flattenCidrMap(data4);

    if (includeIpv6) {
      try {
        const path6 = buildIpListPath(sites, 'cidr6');
        const data6 = await fetchWithRetry(path6);
        for (const c of flattenCidrMap(data6)) merged.add(c);
      } catch { /* IPv6 optional */ }
    }
  } catch {
    // opencck unavailable — fall through to antifilter
    merged = new Set();
  }

  // Fallback: if opencck returned nothing, use antifilter aggregate list (IPv4 only)
  if (merged.size === 0) {
    try {
      const afCidrs = await getAntifilterCidrs();
      for (const c of afCidrs) if (isIpv4Cidr(c)) merged.add(c);
      source = 'antifilter';
    } catch { /* antifilter also failed — return empty */ }
  }

  const result = Array.from(merged).sort();
  result._source = source;
  cidrCacheSet(cacheKey, result);
  return { cidrs: result, source };
};

module.exports = {
  IP_LIST_HOST,
  fetchCidrsForDomains,
  buildIpListPath,
  isIpv4Cidr,
};
