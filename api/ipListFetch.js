const https = require('https');
const { randomInt } = require('crypto');
const { URLSearchParams } = require('url');

const IP_LIST_HOST = 'iplist.opencck.org';
const IP_LIST_TIMEOUT_MS = 25000;
const MAX_IP_LIST_RESPONSE_BYTES = 8 * 1024 * 1024;
const RETRY_MAX = 5;
const RETRY_BASE_MS = 400;
const RETRY_MAX_MS = 10000;

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
 * Fetch and merge IPv4+IPv6 CIDRs for hostnames.
 * @param {string[]} sites unique hostnames
 * @returns {Promise<string[]>}
 */
const fetchCidrsForDomains = async (sites) => {
  if (!sites.length) {
    return [];
  }
  const path4 = buildIpListPath(sites, 'cidr4');
  const data4 = await fetchWithRetry(path4);
  const merged = flattenCidrMap(data4);
  let path6;
  try {
    path6 = buildIpListPath(sites, 'cidr6');
    const data6 = await fetchWithRetry(path6);
    for (const c of flattenCidrMap(data6)) merged.add(c);
  } catch {
    /* IPv6 optional — many configs work with IPv4-only AllowedIPs */
  }
  return Array.from(merged).sort();
};

module.exports = {
  IP_LIST_HOST,
  fetchCidrsForDomains,
  buildIpListPath,
};
