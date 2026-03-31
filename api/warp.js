const nacl = require('tweetnacl');
const { Buffer } = require('buffer');
const { randomInt } = require('crypto');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const { expandPresetsToSites, parsePresetKeysFromRequest, getDnsString, parseDnsKeyFromRequest, DNS_DEFAULT_KEY } = require('./routePresets');
const { fetchCidrsForDomains } = require('./ipListFetch');

const DEFAULT_ALLOWED_IPS = ['0.0.0.0/0', '::/0'];

/** Tried when Cloudflare omits endpoint in JSON (best-effort anycast fallbacks). */
const FALLBACK_ENDPOINT_HOSTS = ['188.114.97.66', '162.159.192.1'];
const WARP_PORT = 3138;
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

/** S1+56 must not equal S2 (padded init vs response size clash; see AmneziaWG 2.0 notes). */
const pickAwg2Padding = () => {
  let s1;
  let s2;
  for (let k = 0; k < 64; k += 1) {
    s1 = randomInt(40, 129);
    s2 = randomInt(40, 129);
    if (s1 + 56 !== s2) break;
  }
  return {
    s1,
    s2,
    s3: randomInt(32, 129),
    s4: randomInt(48, 161),
  };
};

const pickJunkParams = () => {
  const jc = randomInt(96, 161);
  const jmin = randomInt(16, 36);
  const jmax = randomInt(Math.max(jmin + 300, 550), 1001);
  return { jc, jmin, jmax };
};

const buildAwg2Obfuscation = () => {
  const headers = generateAwg2MagicHeaderRanges();
  const pad = pickAwg2Padding();
  const junk = pickJunkParams();
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

const buildInterfaceLegacy = (privKey, clientIPv4, clientIPv6, dnsLine) => `[Interface]
PrivateKey = ${privKey}
Jc = 120
Jmin = 23
Jmax = 911
H1 = 1
H2 = 2
H3 = 3
H4 = 4
MTU = 1280
Address = ${clientIPv4}/32, ${clientIPv6}/128
DNS = ${dnsLine}`;

const buildInterfaceAwg2 = (privKey, clientIPv4, clientIPv6, obf, dnsLine) => `[Interface]
PrivateKey = ${privKey}
Jc = ${obf.Jc}
Jmin = ${obf.Jmin}
Jmax = ${obf.Jmax}
S1 = ${obf.S1}
S2 = ${obf.S2}
S3 = ${obf.S3}
S4 = ${obf.S4}
H1 = ${obf.H1}
H2 = ${obf.H2}
H3 = ${obf.H3}
H4 = ${obf.H4}
MTU = 1280
Address = ${clientIPv4}/32, ${clientIPv6}/128
DNS = ${dnsLine}`;

const buildFullConfig = (mode, privKey, peerPub, clientIPv4, clientIPv6, peerEndpoint, awg2Obf, allowedIpList, dnsLine) => {
  const iface = mode === 'awg2'
    ? buildInterfaceAwg2(privKey, clientIPv4, clientIPv6, awg2Obf, dnsLine)
    : buildInterfaceLegacy(privKey, clientIPv4, clientIPv6, dnsLine);
  const allowed = (allowedIpList && allowedIpList.length ? allowedIpList : DEFAULT_ALLOWED_IPS).join(', ');
  return `${iface}

[Peer]
PublicKey = ${peerPub}
AllowedIPs = ${allowed}
Endpoint = ${peerEndpoint}`;
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

const generateKeys = () => {
  const { secretKey, publicKey } = nacl.box.keyPair();
  const privKey = Buffer.from(secretKey).toString('base64');
  const pubKey = Buffer.from(publicKey).toString('base64');
  return { privKey, pubKey };
};

const generateHeaders = (token = null) => {
  const headers = {
    'Content-Type': 'application/json',
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

const resolveAllowedIpsFromPresets = async (presetKeys) => {
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
  const cidrs = await fetchCidrsForDomains(sites);
  if (!cidrs.length) {
    const err = new Error(
      'Сервис списков IP вернул пустой ответ. Попробуйте другой набор пресетов или повторите позже.',
    );
    err.statusCode = 502;
    throw err;
  }
  return { cidrs, routesSource: 'presets', sitesResolved: sites.length };
};

const generateWarpConfig = async (mode = 'legacy', presetKeys = [], dnsKey = '') => {
  const { privKey, pubKey } = generateKeys();
  const regBody = {
    install_id: uuidv4(),
    tos: new Date().toISOString(),
    key: pubKey,
    fcm_token: '',
    type: 'windows',
    locale: 'en_US',
  };

  const regResponse = await handleApiRequest('POST', 'reg', regBody);
  const { id, token } = regResponse.result ?? {};

  if (!id || !token) {
    throw new Error('Ошибка: отсутствуют id или token в ответе регистрации');
  }

  await handleApiRequest('PATCH', `reg/${id}`, { warp_enabled: true }, token);

  const initialConfig = regResponse.result?.config;
  if (!initialConfig?.peers?.length || !initialConfig.peers[0].public_key) {
    throw new Error('Ошибка: недостающие данные для формирования конфигурации WARP');
  }

  const config = await mergeConfigAfterWarp(id, token, initialConfig);
  const { public_key: peerPub } = config.peers[0];
  const { v4: clientIPv4, v6: clientIPv6 } = config.interface.addresses;

  const endpointHost = resolveEndpointHostWithFallback(config);
  const peerEndpoint = `${endpointHost}:${WARP_PORT}`;

  const awg2Obf = mode === 'awg2' ? buildAwg2Obfuscation() : null;
  const { cidrs: routeCidrs, routesSource, sitesResolved } = await resolveAllowedIpsFromPresets(presetKeys);
  const dnsLine = getDnsString(dnsKey || DNS_DEFAULT_KEY);

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
    ),
    meta: { routesSource, sitesResolved: sitesResolved ?? 0, presetsUsed: presetKeys.length },
  };
};

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, message: 'Метод не поддерживается.' });
    return;
  }

  try {
    const mode = resolveGenerationMode(req);
    const presetKeys = parsePresetKeysFromRequest(req);
    const dnsKey = parseDnsKeyFromRequest(req);
    const { text: conf, meta } = await generateWarpConfig(mode, presetKeys, dnsKey);
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
