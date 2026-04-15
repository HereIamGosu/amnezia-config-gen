const nacl = require('tweetnacl');
const { Buffer } = require('buffer');
const { randomInt } = require('crypto');
const https = require('https');
const fs = require('fs').promises;
const path = require('path');
const { expandPresetsToSites, parsePresetKeysFromRequest, getDnsString, parseDnsKeyFromRequest, DNS_DEFAULT_KEY } = require('./routePresets');
const { fetchCidrsForDomains } = require('./ipListFetch');
const { createRateLimiter } = require('./_rateLimit');

/** 10 generations per minute per IP — prevents Cloudflare WARP registration abuse. */
const warpLimiter = createRateLimiter({ windowMs: 60_000, maxHits: 10 });

const { pickRandomCpsPayload } = require('./warpCpsPayloads');

const DEFAULT_ALLOWED_IPS = ['0.0.0.0/0', '::/0'];

/** WARP server peer public key (Cloudflare); used if registration JSON omits it. */
const KNOWN_WARP_PEER_PUBLIC_KEY = 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=';
/**
 * DNS name used by wgcf and Amnezia exports instead of raw API endpoint IPs.
 * WireGuard resolves `Endpoint` at connect time; keeping the hostname avoids stale anycast IPs in the file.
 */
const ENGAGE_CLOUDFLARE_HOST = 'engage.cloudflareclient.com';
/**
 * Fixed UDP port for `engage.cloudflareclient.com` in this generator (no rotation).
 * Aligns with typical working Amnezia 1.5 WARP exports. Standard wgcf profiles often use **2408**;
 * override with query/body `warpPort` if your network requires it.
 * @see https://developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/deployment/firewall/
 */
const WARP_DEFAULT_ENGAGE_UDP_PORT = 4500;

/** Tried when Cloudflare omits endpoint in JSON (best-effort anycast fallbacks). */
const FALLBACK_ENDPOINT_HOSTS = ['188.114.97.66', '162.159.192.1'];
/** Max length of I1 CPS payload (AmneziaWG); avoids huge query/body abuse. */
const MAX_I1_LEN = 512 * 1024;
const I1_REF_SAFE = /^[a-zA-Z0-9._-]+$/;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const API_PREFIX = '/v0i1909051800';
const CLOUDFLARE_API_HOST = 'api.cloudflareclient.com';

const RETRY_MAX_ATTEMPTS = 6;
const RETRY_BASE_DELAY_MS = 450;
const RETRY_MAX_DELAY_MS = 12000;

/**
 * AmneziaWG 2.0 H1–H4: amneziawg-go parses decimal uint32 (device/magic-header.go) and
 * checks non-overlap (device/uapi.go mergeWithDevice). Many desktop clients and installers
 * (e.g. wiresock/amneziawg-install README) constrain values to 5..2147483647 so headers fit
 * signed int32 and avoid 1..4 (WireGuard message type constants). We partition that span only.
 */
const AWG2_H_MIN = 5;
const AWG2_H_MAX = 0x7fffffff;
/** Minimum width of each H1..H4 band (non-overlapping partition inside [AWG2_H_MIN, AWG2_H_MAX]). */
const AWG2_MIN_H_BAND = 65536;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Validate IPv4 address (e.g. 172.16.0.2). */
const isValidIPv4 = (s) => {
  if (typeof s !== 'string') return false;
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const n = Number(p);
    return /^\d{1,3}$/.test(p) && n >= 0 && n <= 255;
  });
};

/** Validate IPv6 address (simplified: 2-8 hex groups separated by colons, allows ::). */
const isValidIPv6 = (s) => {
  if (typeof s !== 'string') return false;
  return /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/.test(s) || /^::$/.test(s);
};

/**
 * Random non-overlapping H1..H4 ranges; runtime each packet uses a random value inside its band.
 */
const generateAwg2MagicHeaderRanges = () => {
  const c1Min = AWG2_H_MIN + AWG2_MIN_H_BAND - 1;
  const c1Max = AWG2_H_MAX - 3 * AWG2_MIN_H_BAND;
  const c1 = randomInt(c1Min, c1Max + 1);
  const c2Min = c1 + AWG2_MIN_H_BAND;
  const c2Max = AWG2_H_MAX - 2 * AWG2_MIN_H_BAND;
  const c2 = randomInt(c2Min, c2Max + 1);
  const c3Min = c2 + AWG2_MIN_H_BAND;
  const c3Max = AWG2_H_MAX - AWG2_MIN_H_BAND;
  const c3 = randomInt(c3Min, c3Max + 1);
  return {
    H1: `${AWG2_H_MIN}-${c1}`,
    H2: `${c1 + 1}-${c2}`,
    H3: `${c2 + 1}-${c3}`,
    H4: `${c3 + 1}-${AWG2_H_MAX}`,
  };
};

/** AmneziaWG 2.0 spec: S1–S3 are 0..64 bytes, S4 is 0..32 bytes. */
const AWG2_S123_MAX = 64;
const AWG2_S4_MAX = 32;
/** AmneziaWG 2.0 spec: Jmin/Jmax are 64..1024 bytes. Jc upper bound raised to 25 per user feedback (optimal range 15–25). */
const AWG2_JC_MAX = 25;
const AWG2_JMIN_MIN = 64;
const AWG2_JMAX_MAX = 1024;

/**
 * S1+56 ≠ S2 (init vs response clash), S1+56 ≠ S3 (init vs cookie clash),
 * S2+92 ≠ S3 (response vs cookie clash) — prevents DPI from deriving packet boundaries
 * across types via arithmetic relationship. All three constraints validated per competitor analysis.
 */
const pickAwg2PaddingDocCompliant = () => {
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  for (let k = 0; k < 128; k += 1) {
    s1 = randomInt(0, AWG2_S123_MAX + 1);
    s2 = randomInt(0, AWG2_S123_MAX + 1);
    s3 = randomInt(0, AWG2_S123_MAX + 1);
    if (s1 + 56 !== s2 && s1 + 56 !== s3 && s2 + 92 !== s3) break;
  }
  // Deterministic safe fallback if loop exhausted (10+56=66≠20, 66≠30, 20+92=112≠30)
  if (s1 + 56 === s2 || s1 + 56 === s3 || s2 + 92 === s3) {
    s1 = 10; s2 = 20; s3 = 30;
  }
  return {
    s1,
    s2,
    s3,
    s4: randomInt(0, AWG2_S4_MAX + 1),
  };
};

/** Junk train parameters within AWG 2.0 bounds (Jc 1..25; range 15–25 per user feedback). */
const pickAwg2JunkDocCompliant = () => {
  const jc = randomInt(1, AWG2_JC_MAX + 1);
  const jmin = randomInt(AWG2_JMIN_MIN, 801);
  // Gap ≥ 64 (up from 32): wider spread makes junk train harder to fingerprint by size.
  const jmax = randomInt(Math.max(jmin + 64, AWG2_JMIN_MIN + 1), AWG2_JMAX_MAX + 1);
  return { jc, jmin, jmax };
};

/**
 * Router mode: aggressive parameter caps for embedded devices (MikroTik, GL.iNet, Keenetic, OpenWrt).
 * High Jc / large junk sizes flood low-memory WireGuard stacks and cause silent tunnel failure.
 */
const ROUTER_JC_MAX = 2;
const ROUTER_JMIN_MIN = 40;
const ROUTER_JMIN_MAX = 128;
const ROUTER_JMAX_MAX = 128;

/** Apply router mode caps to AWG 2.0 obfuscation params. S/H fields are unchanged. */
const applyRouterModeCaps = (obf) => ({
  ...obf,
  Jc: Math.min(obf.Jc, ROUTER_JC_MAX),
  Jmin: Math.max(ROUTER_JMIN_MIN, Math.min(obf.Jmin, ROUTER_JMIN_MAX)),
  Jmax: Math.min(Math.max(obf.Jmax, ROUTER_JMIN_MIN + 1), ROUTER_JMAX_MAX),
});

/**
 * S4 prepends random bytes to each transport packet (not keepalive). Reduce TUN MTU so IPv4+UDP
 * payloads stay under path MTU (see amneziawg-go RoutineSequentialSender + user docs).
 * Peers that send stock WireGuard (no S4 prefix) require S4=0 in config; see buildAwg2WarpSafeObfuscation.
 */
const AWG2_TUN_MTU_BASE = 1280;
const AWG2_TUN_MTU_FLOOR = 1280;
/**
 * WARP-safe MTU for stock WireGuard peer (Cloudflare).
 * WireGuard overhead is ~60 bytes (IPv4+UDP+WG header); 1280 is standard for WG tunnels
 * over typical 1500-byte MTU links. 1280 was overly conservative and cost ~140 bytes/pkt.
 * Cloudflare WARP clients (wgcf, official 1.1.1.1 app) use 1280 by default.
 */
const AWG2_MTU_STOCK_PEER = 1280;

/**
 * @param {number} s4
 * @param {{ stockWireGuardPeer?: boolean }} [opts] If true, peer is stock WG (e.g. Cloudflare): omit S4-based math; use fixed MTU.
 */
const computeAwg2InterfaceMtu = (s4, opts = {}) => {
  if (opts.stockWireGuardPeer) return AWG2_MTU_STOCK_PEER;
  const pad = Math.max(0, Number(s4) | 0);
  return Math.max(AWG2_TUN_MTU_FLOOR, AWG2_TUN_MTU_BASE - pad);
};

const buildAwg2Obfuscation = () => {
  const headers = generateAwg2MagicHeaderRanges();
  const pad = pickAwg2PaddingDocCompliant();
  const junk = pickAwg2JunkDocCompliant();
  return {
    ...headers,
    S1: pad.s1,
    S2: pad.s2,
    S3: pad.s3,
    S4: pad.s4,
    Jc: junk.jc,
    Jmin: junk.jmin,
    Jmax: junk.jmax,
  };
};

/**
 * WARP-safe AWG 2.0: H1–H4 stay WireGuard types 1–4 (Cloudflare peer is stock WG).
 * S1/S2/S3/S4 must stay 0: stock WireGuard sends handshake/cookie/transport without AWG padding; the
 * AmneziaWG receive path strips S2/S3/S4 from incoming packets — non-zero values desync parsing and
 * break the tunnel. Junk (Jc/Jmin/Jmax) only affects pre-handshake UDP noise client→server; keep
 * within doc bounds. Optional i1 CPS still runs before Init (server ignores until valid handshake).
 */
const buildAwg2WarpSafeObfuscation = () => {
  const junk = pickAwg2JunkDocCompliant();
  return {
    H1: '1',
    H2: '2',
    H3: '3',
    H4: '4',
    S1: 0,
    S2: 0,
    S3: 0,
    S4: 0,
    Jc: junk.jc,
    Jmin: junk.jmin,
    Jmax: junk.jmax,
  };
};

const resolveGenerationMode = (req) => {
  let raw = '';
  if (req.query && typeof req.query === 'object') {
    raw = String(req.query.mode || req.query.awg || '').toLowerCase();
  }
  if (!raw && req.url) {
    try {
      const u = new URL(req.url, 'http://localhost');
      raw = String(u.searchParams.get('mode') || u.searchParams.get('awg') || '').toLowerCase();
    } catch {
      raw = '';
    }
  }
  if (raw === 'awg2' || raw === '2' || raw === 'v2') return 'awg2';
  return 'legacy';
};

const resolveModeFromInput = (raw) => {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'awg2' || s === '2' || s === 'v2') return 'awg2';
  return 'legacy';
};

/**
 * Legacy profile: field order and explicit S1/S2=0 match common WARP/Amnezia exports (Jc/Jmin/Jmax + H1..4).
 * @param {string} i1Optional full value after `I1 = ` (e.g. `<b 0x...>`), or empty to omit
 * @param {boolean} plainAddress if true, omit /32 and /128 (some exports use bare IPs)
 */
const buildInterfaceLegacy = (privKey, clientIPv4, clientIPv6, dnsLine, i1Optional = '', plainAddress = false) => {
  const addrLine = plainAddress
    ? `Address = ${clientIPv4}, ${clientIPv6}`
    : `Address = ${clientIPv4}/32, ${clientIPv6}/128`;
  const lines = [
    '[Interface]',
    `PrivateKey = ${privKey}`,
    addrLine,
    `DNS = ${dnsLine}`,
    'MTU = 1280',
    'S1 = 0',
    'S2 = 0',
    'Jc = 120',
    'Jmin = 23',
    'Jmax = 911',
    'H1 = 1',
    'H2 = 2',
    'H3 = 3',
    'H4 = 4',
  ];
  if (i1Optional) lines.push(`I1 = ${i1Optional}`);
  return lines.join('\n');
};

/**
 * @param {boolean} plainAddress if true, omit /32 and /128 (Amnezia WARP exports often use bare IPs)
 */
const buildInterfaceAwg2 = (privKey, clientIPv4, clientIPv6, obf, dnsLine, plainAddress = false, i1Optional = '') => {
  const addrLine = plainAddress
    ? `Address = ${clientIPv4}, ${clientIPv6}`
    : `Address = ${clientIPv4}/32, ${clientIPv6}/128`;
  const mtu = computeAwg2InterfaceMtu(obf.S4);
  const lines = [
    '[Interface]',
    `PrivateKey = ${privKey}`,
    addrLine,
    `DNS = ${dnsLine}`,
    `MTU = ${mtu}`,
    `Jc = ${obf.Jc}`,
    `Jmin = ${obf.Jmin}`,
    `Jmax = ${obf.Jmax}`,
    `S1 = ${obf.S1}`,
    `S2 = ${obf.S2}`,
    `S3 = ${obf.S3}`,
    `S4 = ${obf.S4}`,
    `H1 = ${obf.H1}`,
    `H2 = ${obf.H2}`,
    `H3 = ${obf.H3}`,
    `H4 = ${obf.H4}`,
  ];
  if (i1Optional) lines.push(`I1 = ${i1Optional}`);
  return lines.join('\n');
};

/**
 * AWG 2.0 [Interface] layout per Amnezia docs (Address, keys, DNS, junk, S1–S4, H1–H4, CPS line `i1`).
 * WARP preset: H1–H4 = 1..4; S1–S4 = 0 (stock peer); MTU 1280 like legacy WARP.
 */
const buildInterfaceAwg2WarpSafe = (privKey, clientIPv4, clientIPv6, obf, dnsLine, plainAddress, i1Optional = '') => {
  const addrLine = plainAddress
    ? `Address = ${clientIPv4}, ${clientIPv6}`
    : `Address = ${clientIPv4}/32, ${clientIPv6}/128`;
  const mtu = computeAwg2InterfaceMtu(obf.S4, { stockWireGuardPeer: true });
  const lines = [
    '[Interface]',
    `PrivateKey = ${privKey}`,
    addrLine,
    `DNS = ${dnsLine}`,
    `MTU = ${mtu}`,
    `Jc = ${obf.Jc}`,
    `Jmin = ${obf.Jmin}`,
    `Jmax = ${obf.Jmax}`,
    `S1 = ${obf.S1}`,
    `S2 = ${obf.S2}`,
    `S3 = ${obf.S3}`,
    `S4 = ${obf.S4}`,
    `H1 = ${obf.H1}`,
    `H2 = ${obf.H2}`,
    `H3 = ${obf.H3}`,
    `H4 = ${obf.H4}`,
  ];
  if (i1Optional) lines.push(`I1 = ${i1Optional}`);
  return lines.join('\n');
};

/**
 * @param {{ i1?: string, persistentKeepalive?: number|null, awg2WarpSafe?: boolean }} ifaceExtras
 */
const buildFullConfig = (mode, privKey, peerPub, clientIPv4, clientIPv6, peerEndpoint, awg2Obf, allowedIpList, dnsLine, ifaceExtras = {}) => {
  const i1 = ifaceExtras.i1 || '';
  const plainAddress = Boolean(ifaceExtras.plainAddress);
  const iface =
    mode === 'awg2'
      ? ifaceExtras.awg2WarpSafe
        ? buildInterfaceAwg2WarpSafe(privKey, clientIPv4, clientIPv6, awg2Obf, dnsLine, plainAddress, i1)
        : buildInterfaceAwg2(privKey, clientIPv4, clientIPv6, awg2Obf, dnsLine, plainAddress, i1)
      : buildInterfaceLegacy(privKey, clientIPv4, clientIPv6, dnsLine, i1, plainAddress);
  const allowed = (allowedIpList && allowedIpList.length ? allowedIpList : DEFAULT_ALLOWED_IPS).join(', ');
  let peerBlock = `[Peer]
PublicKey = ${peerPub}
AllowedIPs = ${allowed}
Endpoint = ${peerEndpoint}`;
  const ka = ifaceExtras.persistentKeepalive;
  if (ka != null && ka > 0) peerBlock += `\nPersistentKeepalive = ${ka}`;
  return `${iface}\n\n${peerBlock}`;
};

/**
 * Extract WireGuard endpoint host from Cloudflare peer.endpoint (same registration as keys).
 * @param {object} peer config.peers[0]
 * @returns {string|null} host IP or IPv6 literal (no brackets)
 */
const extractEndpointHostFromPeer = (peer) => {
  const endpoint = peer?.endpoint;
  if (!endpoint) return null;

  if (endpoint.v4) {
    const host = String(endpoint.v4).split(':')[0];
    return host || null;
  }

  if (endpoint.host) {
    const raw = String(endpoint.host).trim();
    if (raw.startsWith('[')) {
      const end = raw.indexOf(']');
      if (end > 1) return raw.slice(1, end);
    }
    const lastColon = raw.lastIndexOf(':');
    if (lastColon > 0 && /^\d{1,3}(\.\d{1,3}){3}$/.test(raw.slice(0, lastColon))) {
      return raw.slice(0, lastColon);
    }
    if (lastColon > 0 && raw.slice(lastColon + 1).length > 0 && /^\d+$/.test(raw.slice(lastColon + 1))) {
      return raw.slice(0, lastColon);
    }
    return raw;
  }

  return null;
};

const pickEndpointHost = (config) => {
  const peer = config?.peers?.[0];
  return extractEndpointHostFromPeer(peer);
};

const resolveEndpointHostWithFallback = (config) => {
  const fromPeer = pickEndpointHost(config);
  if (fromPeer) return fromPeer;
  const idx = randomInt(0, FALLBACK_ENDPOINT_HOSTS.length);
  return FALLBACK_ENDPOINT_HOSTS[idx];
};

/**
 * @param {import('http').IncomingMessage} req
 * @param {string} key
 * @returns {string|undefined}
 */
const pickQuery = (req, key) => {
  if (req.query && typeof req.query === 'object' && req.query[key] != null) {
    const v = req.query[key];
    return Array.isArray(v) ? String(v[0]) : String(v);
  }
  if (req.url) {
    try {
      const got = new URL(req.url, 'http://localhost').searchParams.get(key);
      return got == null ? undefined : got;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const readRequestJson = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });

const normalizeI1Payload = (s) => {
  const t = String(s ?? '').trim();
  if (!t) return '';
  if (t.length > MAX_I1_LEN) {
    const err = new Error('Поле I1 слишком большое.');
    err.statusCode = 413;
    throw err;
  }
  return t;
};

const loadI1FromRef = async (ref) => {
  const raw = String(ref ?? '').trim();
  if (!I1_REF_SAFE.test(raw)) {
    const err = new Error('Некорректный i1Ref (только буквы, цифры, . _ -).');
    err.statusCode = 400;
    throw err;
  }
  const baseName = raw.endsWith('.txt') ? raw : `${raw}.txt`;
  const safeFile = path.basename(baseName);
  const fp = path.join(__dirname, 'cps-presets', safeFile);
  try {
    const text = await fs.readFile(fp, 'utf8');
    return text.trim();
  } catch {
    const err = new Error('Файл пресета I1 не найден (api/cps-presets/).');
    err.statusCode = 404;
    throw err;
  }
};

/**
 * @param {unknown} presets
 * @returns {string[]}
 */
const parsePresetKeysFromBody = (presets) => {
  if (Array.isArray(presets)) {
    const seen = new Set();
    return presets
      .map((x) => String(x).trim().toLowerCase())
      .filter((x) => {
        if (!x || seen.has(x)) return false;
        seen.add(x);
        return true;
      });
  }
  if (typeof presets === 'string' && presets.trim()) {
    const out = [];
    const seen = new Set();
    presets.split(/[,;]+/).forEach((p) => {
      const x = p.trim().toLowerCase();
      if (x && !seen.has(x)) {
        seen.add(x);
        out.push(x);
      }
    });
    return out;
  }
  return [];
};

const parseWarpPort = (v) => {
  if (v == null || v === '') return null;
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return null;
  return n;
};

const parsePersistentKeepalive = (v) => {
  if (v == null || v === '') return null;
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n) || n < 0 || n > 65535) return null;
  return n === 0 ? null : n;
};

const parsePeerEndpointOverride = (v) => {
  const s = String(v ?? '').trim();
  if (!s || !s.includes(':')) return null;
  return s;
};

/**
 * Merge query + JSON body options for WARP config extras.
 * @param {import('http').IncomingMessage} req
 * @param {Record<string, unknown>} body
 */
const collectWarpGenExtras = (req, body) => {
  const b = body && typeof body === 'object' ? body : {};
  const peerEndpoint = parsePeerEndpointOverride(
    b.peerEndpoint ?? b.endpoint ?? pickQuery(req, 'peerEndpoint') ?? pickQuery(req, 'endpoint'),
  );
  const warpPort = parseWarpPort(b.warpPort ?? pickQuery(req, 'warpPort'));
  const persistentKeepalive = parsePersistentKeepalive(
    b.persistentKeepalive ?? b.keepalive ?? pickQuery(req, 'persistentKeepalive') ?? pickQuery(req, 'keepalive'),
  );
  const i1RefRaw = b.i1Ref ?? pickQuery(req, 'i1Ref');
  const i1Ref = i1RefRaw != null && String(i1RefRaw).trim() !== '' ? String(i1RefRaw).trim() : null;
  const i1Raw = b.i1 != null ? String(b.i1) : null;
  const pa = b.plainAddress ?? pickQuery(req, 'plainAddress');
  const plainAddress =
    pa === true ||
    String(pa ?? '')
      .toLowerCase() === '1' ||
    String(pa ?? '')
      .toLowerCase() === 'true';
  return { peerEndpoint, warpPort, persistentKeepalive, i1Ref, i1Raw, plainAddress };
};

/**
 * High-level presets: fixed engage host/ports and optional embedded I1 (AmneziaWG obfuscation chain; not from CF API).
 * @param {string} name query/body `template`
 * @returns {{ engageHost: string|null, defaultEngagePort: number|null, defaultKeepalive: number|null, useEmbeddedAmneziaI1: boolean, plainAddress: boolean, forceLegacy: boolean, awg2WarpSafe?: boolean }}
 */
const resolveTemplateOptions = (name) => {
  const n = String(name ?? '')
    .trim()
    .toLowerCase();
  if (n === 'warp_amnezia' || n === 'amnezia' || n === 'amnezia_warp') {
    return {
      engageHost: ENGAGE_CLOUDFLARE_HOST,
      defaultEngagePort: WARP_DEFAULT_ENGAGE_UDP_PORT,
      defaultKeepalive: 25,
      useEmbeddedAmneziaI1: true,
      plainAddress: true,
      forceLegacy: true,
    };
  }
  /**
   * Same peer/DNS/Address and embedded CPS as warp_amnezia; AWG 2.0 layout with `i1`, doc-bounded S3/S4 and Jc/Jmin/Jmax;
   * H1–H4 stay 1–4 for Cloudflare stock WireGuard (random H bands break WARP).
   */
  if (
    n === 'warp_amnezia_awg2' ||
    n === 'amnezia_awg2' ||
    n === 'awg2_amnezia' ||
    n === 'warp_awg2_amnezia'
  ) {
    return {
      engageHost: ENGAGE_CLOUDFLARE_HOST,
      defaultEngagePort: WARP_DEFAULT_ENGAGE_UDP_PORT,
      defaultKeepalive: 25,
      useEmbeddedAmneziaI1: true,
      plainAddress: true,
      forceLegacy: false,
      awg2WarpSafe: true,
    };
  }
  /** Random H1–H4 bands (DPI-oriented); not usable with Cloudflare WARP — for self-hosted AWG peers only. */
  if (n === 'awg2_random' || n === 'awg2_dpi') {
    return {
      engageHost: null,
      defaultEngagePort: null,
      defaultKeepalive: null,
      useEmbeddedAmneziaI1: false,
      plainAddress: false,
      forceLegacy: false,
      awg2WarpSafe: false,
    };
  }
  if (n === 'wgcf') {
    return {
      engageHost: ENGAGE_CLOUDFLARE_HOST,
      defaultEngagePort: WARP_DEFAULT_ENGAGE_UDP_PORT,
      defaultKeepalive: null,
      useEmbeddedAmneziaI1: false,
      plainAddress: false,
      forceLegacy: false,
    };
  }
  return {
    engageHost: null,
    defaultEngagePort: null,
    defaultKeepalive: null,
    useEmbeddedAmneziaI1: false,
    plainAddress: false,
    forceLegacy: false,
  };
};

/**
 * @param {ReturnType<typeof collectWarpGenExtras>} extras
 * @param {ReturnType<typeof resolveTemplateOptions>} tmpl
 */
const mergeTemplateIntoExtras = (extras, tmpl) => {
  const out = { ...extras };
  if (tmpl.engageHost) out.engageHost = tmpl.engageHost;
  if (tmpl.engageHost && out.warpPort == null) {
    out.warpPort =
      tmpl.defaultEngagePort != null ? tmpl.defaultEngagePort : WARP_DEFAULT_ENGAGE_UDP_PORT;
  }
  if (tmpl.defaultKeepalive != null && out.persistentKeepalive == null) {
    out.persistentKeepalive = tmpl.defaultKeepalive;
  }
  if (
    tmpl.useEmbeddedAmneziaI1 &&
    !out.i1Ref &&
    (out.i1Raw == null || String(out.i1Raw).trim() === '')
  ) {
    out.useEmbeddedAmneziaI1 = true;
  }
  if (tmpl.plainAddress) out.plainAddress = true;
  out.forceLegacy = Boolean(tmpl.forceLegacy);
  if (tmpl.awg2WarpSafe) out.awg2WarpSafe = true;
  return out;
};

const resolvePeerEndpointForConfig = (config, extras) => {
  if (extras.peerEndpoint) return extras.peerEndpoint;
  if (extras.engageHost) {
    const port =
      extras.warpPort != null
        ? extras.warpPort
        : extras.defaultEngagePort != null
          ? extras.defaultEngagePort
          : WARP_DEFAULT_ENGAGE_UDP_PORT;
    return `${extras.engageHost}:${port}`;
  }
  const host = resolveEndpointHostWithFallback(config);
  const port = extras.warpPort != null ? extras.warpPort : WARP_DEFAULT_ENGAGE_UDP_PORT;
  return `${host}:${port}`;
};

const resolveI1ForGeneration = async (extras) => {
  if (extras.i1Raw != null && String(extras.i1Raw).trim() !== '') {
    return normalizeI1Payload(extras.i1Raw);
  }
  if (extras.i1Ref) return normalizeI1Payload(await loadI1FromRef(extras.i1Ref));
  if (extras.useEmbeddedAmneziaI1) {
    // Pick a verified CPS payload from the pool. Random bytes are NOT valid replacements —
    // Cloudflare WARP requires a structured CPS binary header (0xCx 00 00 00 01...).
    // Rotating across the pool provides DPI variety without breaking the handshake.
    return normalizeI1Payload(pickRandomCpsPayload());
  }
  return '';
};

const generateKeys = () => {
  const { secretKey, publicKey } = nacl.box.keyPair();
  const privKey = Buffer.from(secretKey).toString('base64');
  const pubKey = Buffer.from(publicKey).toString('base64');
  return { privKey, pubKey };
};

const generateHeaders = (token = null) => {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'okhttp/3.12.1',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
};

const isTransientApiFailure = (err) => {
  if (!err) return false;
  const code = err.statusCode;
  if (code === 429 || code === 502 || code === 503 || code === 504) return true;
  const sys = err.code;
  if (sys && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'].includes(sys)) {
    return true;
  }
  const msg = String(err.message || '');
  if (/таймаут|timeout|Timeout|socket hang up/i.test(msg)) return true;
  return false;
};

const httpRequestOnce = (method, endpointPath, body = null, token = null) =>
  new Promise((resolve, reject) => {
    const headers = generateHeaders(token);
    const data = body ? JSON.stringify(body) : null;

    const options = {
      hostname: CLOUDFLARE_API_HOST,
      port: 443,
      path: `${API_PREFIX}/${endpointPath}`,
      method,
      agent: false,
      headers: {
        ...headers,
        'Content-Length': data ? Buffer.byteLength(data) : 0,
      },
    };

    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      req.destroy();
      finish(new Error('Таймаут запроса к Cloudflare API.'));
    }, REQUEST_TIMEOUT_MS);

    const req = https.request(options, (res) => {
      let responseData = '';
      let totalBytes = 0;

      res.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          req.destroy();
          finish(new Error('Ответ Cloudflare API слишком большой.'));
          return;
        }
        responseData += chunk;
      });

      res.on('end', () => {
        try {
          const parsedData = responseData ? JSON.parse(responseData) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            finish(null, parsedData);
            return;
          }
          const errorMessage = parsedData.message || `Ошибка с кодом ${res.statusCode}`;
          const err = new Error(errorMessage);
          err.statusCode = res.statusCode;
          finish(err);
        } catch {
          const err = new Error('Не удалось обработать ответ сервера.');
          err.statusCode = res.statusCode;
          finish(err);
        }
      });
    });

    req.on('error', (e) => {
      const err = new Error(`Ошибка запроса: ${e.message}`);
      err.code = e.code;
      finish(err);
    });

    if (data) req.write(data);
    req.end();
  });

const handleApiRequest = async (method, endpointPath, body = null, token = null) => {
  let lastErr;
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await httpRequestOnce(method, endpointPath, body, token);
    } catch (err) {
      lastErr = err;
      if (!isTransientApiFailure(err) || attempt === RETRY_MAX_ATTEMPTS - 1) {
        throw err;
      }
      const jitter = randomInt(0, 320);
      const delay = Math.min(
        RETRY_MAX_DELAY_MS,
        RETRY_BASE_DELAY_MS * 2 ** attempt + jitter,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
};

const mergeConfigAfterWarp = async (id, token, initialConfig) => {
  try {
    const refreshed = await handleApiRequest('GET', `reg/${id}`, null, token);
    const next = refreshed?.result?.config;
    if (next?.peers?.length && next.peers[0]?.public_key) {
      return next;
    }
  } catch (e) {
    if (process.env.VERCEL_ENV !== 'production') {
      console.warn('GET reg/{id} after PATCH failed, using POST reg config:', e.message || e);
    }
  }
  return initialConfig;
};

/**
 * @param {string[]} presetKeys
 * @param {{ includeIpv6?: boolean }} [opts]
 */
const resolveAllowedIpsFromPresets = async (presetKeys, { includeIpv6 = false } = {}) => {
  if (!presetKeys.length) {
    return { cidrs: null, routesSource: 'default' };
  }
  const { sites, unknown } = expandPresetsToSites(presetKeys);
  if (unknown.length) {
    const err = new Error(`Неизвестные пресеты маршрутов: ${unknown.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
  if (!sites.length) {
    const err = new Error('Не заданы домены для выбранных пресетов.');
    err.statusCode = 400;
    throw err;
  }
  // IPv4-only by default: fewer routes, better compatibility with routers and mobile clients.
  const cidrs = await fetchCidrsForDomains(sites, { includeIpv6 });
  if (!cidrs.length) {
    const err = new Error(
      'Сервис списков IP вернул пустой ответ. Попробуйте другой набор пресетов или повторите позже.',
    );
    err.statusCode = 502;
    throw err;
  }
  return { cidrs, routesSource: 'presets', sitesResolved: sites.length };
};

/**
 * @param {string} mode
 * @param {string[]} presetKeys
 * @param {string} dnsKey
 * @param {object} warpExtras результат collectWarpGenExtras (peerEndpoint, warpPort, persistentKeepalive, i1Ref, i1Raw)
 * @param {{ includeIpv6?: boolean }} [routeOpts]
 */
const generateWarpConfig = async (mode = 'legacy', presetKeys = [], dnsKey = '', warpExtras = {}, routeOpts = {}) => {
  const { privKey, pubKey } = generateKeys();
  const regBody = {
    install_id: '',
    tos: new Date().toISOString(),
    key: pubKey,
    fcm_token: '',
    type: 'ios',
    locale: 'en_US',
  };

  const regResponse = await handleApiRequest('POST', 'reg', regBody);
  const { id, token } = regResponse.result ?? {};

  if (!id || !token) {
    throw new Error('Ошибка: отсутствуют id или token в ответе регистрации');
  }

  await handleApiRequest('PATCH', `reg/${id}`, { warp_enabled: true }, token);

  const initialConfig = regResponse.result?.config;
  if (!initialConfig?.peers?.length) {
    throw new Error('Ошибка: недостающие данные для формирования конфигурации WARP');
  }

  const config = await mergeConfigAfterWarp(id, token, initialConfig);
  let peerPub = config.peers[0]?.public_key;
  if (!peerPub) peerPub = KNOWN_WARP_PEER_PUBLIC_KEY;
  const { v4: clientIPv4, v6: clientIPv6 } = config.interface?.addresses ?? {};
  if (!clientIPv4 || !isValidIPv4(clientIPv4)) {
    throw new Error(`Cloudflare вернул некорректный IPv4 адрес: ${clientIPv4 || '(пусто)'}`);
  }
  if (!clientIPv6 || !isValidIPv6(clientIPv6)) {
    throw new Error(`Cloudflare вернул некорректный IPv6 адрес: ${clientIPv6 || '(пусто)'}`);
  }

  const peerEndpoint = resolvePeerEndpointForConfig(config, warpExtras);

  const awg2WarpSafe = Boolean(warpExtras.awg2WarpSafe);
  let awg2Obf =
    mode === 'awg2' ? (awg2WarpSafe ? buildAwg2WarpSafeObfuscation() : buildAwg2Obfuscation()) : null;
  if (awg2Obf && routeOpts.routerMode) awg2Obf = applyRouterModeCaps(awg2Obf);
  const { cidrs: routeCidrs, routesSource, sitesResolved } = await resolveAllowedIpsFromPresets(presetKeys, routeOpts);
  const dnsLine = getDnsString(dnsKey || DNS_DEFAULT_KEY);
  const i1 = await resolveI1ForGeneration(warpExtras);

  return {
    text: buildFullConfig(
      mode,
      privKey,
      peerPub,
      clientIPv4,
      clientIPv6,
      peerEndpoint,
      awg2Obf,
      routeCidrs,
      dnsLine,
      {
        i1,
        persistentKeepalive: warpExtras.persistentKeepalive,
        plainAddress: warpExtras.plainAddress,
        awg2WarpSafe: warpExtras.awg2WarpSafe,
      },
    ),
    meta: { routesSource, sitesResolved: sitesResolved ?? 0, presetsUsed: presetKeys.length },
  };
};

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ success: false, message: 'Метод не поддерживается.' });
    return;
  }

  const { allowed, remaining, retryAfterMs } = warpLimiter.check(req);
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  if (!allowed) {
    res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    res.status(429).json({ success: false, message: 'Слишком много запросов. Попробуйте позже.' });
    return;
  }

  try {
    let body = {};
    if (req.method === 'POST') {
      if (req.body != null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
        body = req.body;
      } else {
        try {
          body = await readRequestJson(req);
        } catch {
          res.status(400).json({ success: false, message: 'Некорректное JSON-тело запроса.' });
          return;
        }
      }
    }

    let mode =
      body.mode != null ? resolveModeFromInput(body.mode) : resolveGenerationMode(req);
    const fromBody = parsePresetKeysFromBody(body.presets);
    const presetKeys = fromBody.length ? fromBody : parsePresetKeysFromRequest(req);
    const dnsKey =
      body.dns != null && String(body.dns).trim() !== ''
        ? String(body.dns).trim().toLowerCase()
        : parseDnsKeyFromRequest(req);

    const templateFromRequest =
      body.template != null && String(body.template).trim() !== ''
        ? String(body.template).trim()
        : pickQuery(req, 'template');
    const templateRaw =
      templateFromRequest && String(templateFromRequest).trim() !== ''
        ? String(templateFromRequest).trim()
        : mode === 'legacy'
          ? 'warp_amnezia'
          : mode === 'awg2'
            ? 'warp_amnezia_awg2'
            : '';
    const tmpl = resolveTemplateOptions(templateRaw);
    const warpExtras = mergeTemplateIntoExtras(collectWarpGenExtras(req, body), tmpl);
    if (warpExtras.forceLegacy) mode = 'legacy';
    delete warpExtras.forceLegacy;

    const ipv6Param = pickQuery(req, 'ipv6');
    const includeIpv6 = ipv6Param === '1' || ipv6Param === 'true';
    const routerRaw = body.router ?? pickQuery(req, 'router');
    const routerMode = routerRaw === true || routerRaw === 1 || String(routerRaw ?? '').toLowerCase() === '1' || String(routerRaw ?? '').toLowerCase() === 'true';
    const { text: conf, meta } = await generateWarpConfig(mode, presetKeys, dnsKey, warpExtras, { includeIpv6, routerMode });
    const confEncoded = Buffer.from(conf).toString('base64');
    res.status(200).json({
      success: true,
      content: confEncoded,
      mode,
      routesSource: meta.routesSource,
      routesPresets: presetKeys.length ? presetKeys : undefined,
      presetSitesCount: meta.sitesResolved || undefined,
    });
  } catch (error) {
    console.error('Ошибка генерации конфигурации:', error);
    const sc = error.statusCode;
    const code =
      typeof sc === 'number' && sc >= 400 && sc < 600 ? sc : 500;
    res.status(code).json({ success: false, message: error.message });
  }
};
