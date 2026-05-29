const https = require('https');

const COMMUNITY_HOST = 'raw.githubusercontent.com';
const COMMUNITY_BASE_PATH = '/itdoginfo/allow-domains/main/Subnets/IPv4';
const COMMUNITY_TIMEOUT_MS = 10000;
const MAX_LIST_RESPONSE_BYTES = 4 * 1024 * 1024;
const COMMUNITY_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

/**
 * Whitelist of allowed itdoginfo list names (exact file basenames, case-sensitive).
 * Anything not here is silently ignored — guards against arbitrary path / SSRF.
 */
const ALLOWED_LISTS = new Set([
  'Discord',
  'Meta',
  'Twitter',
  'telegram',
  'roblox',
  'google_meet',
  'cloudflare',
  'cloudfront',
  'digitalocean',
  'hetzner',
  'ovh',
]);

/** @param {string} cidr */
const isIpv4Cidr = (cidr) => /^\d{1,3}(\.\d{1,3}){3}\/\d+$/.test(cidr);

/** Per-list in-memory cache: name -> { cidrs, ts }. */
const listCache = new Map();

const fetchListOnce = (name) =>
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
      done(new Error(`community list ${name} timeout`));
    }, COMMUNITY_TIMEOUT_MS);

    const req = https.request(
      {
        hostname: COMMUNITY_HOST,
        port: 443,
        path: `${COMMUNITY_BASE_PATH}/${name}.lst`,
        method: 'GET',
        agent: false,
        headers: { 'User-Agent': 'amnezia-config-gen/1.0', Accept: 'text/plain' },
      },
      (res) => {
        let buf = '';
        let n = 0;
        res.on('data', (c) => {
          n += c.length;
          if (n > MAX_LIST_RESPONSE_BYTES) {
            req.destroy();
            done(new Error(`community list ${name} too large`));
            return;
          }
          buf += c;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            done(new Error(`community list ${name} HTTP ${res.statusCode}`));
            return;
          }
          const cidrs = buf
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#') && isIpv4Cidr(l));
          done(null, cidrs);
        });
      },
    );
    req.on('error', (e) => done(e));
    req.end();
  });

const getList = async (name) => {
  const cached = listCache.get(name);
  if (cached && Date.now() - cached.ts < COMMUNITY_CACHE_TTL_MS) {
    return cached.cidrs;
  }
  const cidrs = await fetchListOnce(name);
  listCache.set(name, { cidrs, ts: Date.now() });
  return cidrs;
};

/**
 * Fetch IPv4 CIDRs for the given itdoginfo list names.
 * Unknown names are ignored; per-list network failures don't fail the others.
 * @param {string[]} listNames
 * @returns {Promise<string[]>} unique IPv4 CIDRs
 */
const fetchCommunityCidrs = async (listNames) => {
  const names = Array.from(
    new Set((listNames || []).filter((n) => ALLOWED_LISTS.has(n))),
  );
  if (!names.length) return [];

  const results = await Promise.allSettled(names.map((n) => getList(n)));
  const out = new Set();
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const c of r.value) out.add(c);
    }
  }
  return Array.from(out);
};

module.exports = {
  fetchCommunityCidrs,
  ALLOWED_LISTS,
};
