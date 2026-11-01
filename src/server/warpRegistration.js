// src/server/warpRegistration.js
// Registration of a Cloudflare WARP device (profile `legacy`): POST reg, PATCH reg/{id} with warp_enabled,
// GET reg/{id} for the refreshed config. The requests are those of 3.1.7 byte for byte
// (__tests__/warp-registration-request.test.js). Moved out of api/warp.js in 3.1.8.

const https = require('https');
const { randomInt } = require('crypto');

const REQUEST_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const API_PREFIX = '/v0i1909051800';
const CLOUDFLARE_API_HOST = 'api.cloudflareclient.com';

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 450;
const RETRY_MAX_DELAY_MS = 4000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Failure classes (3.1.8, R5 4.D without the `error` field) ────────────────
// rate_limited: 429. unavailable: 408, 5xx but 501, network, timeout. rejected: 3xx, other 4xx, 501.
// malformed: a 2xx that is not JSON, lacks id/token/peers or has an unusable IPv4, an answer over 2 MB.
const RETRY_AFTER_DEFAULT_S = 60;
const RETRY_AFTER_MAX_S = 3600;
const REFUSALS = {
  rate_limited: { status: 429, message: 'Cloudflare временно ограничил создание устройств WARP. Повторите через минуту; если ошибка держится, это сбой на стороне Cloudflare, а не вашего подключения.' },
  unavailable: { status: 503, message: 'Сервис регистрации Cloudflare WARP сейчас не отвечает. Повторите позже.' },
  rejected: { status: 502, message: 'Cloudflare не принял запрос регистрации WARP. Это сбой на стороне сервиса, а не ваших настроек.' },
};
REFUSALS.malformed = REFUSALS.rejected;

/**
 * Every error of this module. `message` is internal (server log); /api/warp answers by `registrationClass`.
 * @param {'rate_limited'|'unavailable'|'rejected'|'malformed'} klass
 */
const registrationError = (klass, message, { upstreamStatus = null, retryAfterS = null, code } = {}) => {
  const err = new Error(message);
  err.source = 'cloudflare';
  err.registrationClass = klass;
  err.upstreamStatus = upstreamStatus;
  err.retryAfterS = retryAfterS;
  if (code) err.code = code;
  return err;
};

/** Decimal seconds 1..3600 from a Cloudflare `Retry-After`, anything else 60. */
const parseRetryAfter = (value) => {
  const s = String(value ?? '').trim();
  const n = /^\d+$/.test(s) ? Number(s) : 0;
  return n >= 1 && n <= RETRY_AFTER_MAX_S ? n : RETRY_AFTER_DEFAULT_S;
};

/** A non-2xx answer. `res.headers` only through `?.`: the test fakes answer without headers. */
const statusError = (res, message) => {
  const status = res.statusCode;
  if (status === 429) {
    return registrationError('rate_limited', message, { upstreamStatus: status, retryAfterS: parseRetryAfter(res.headers?.['retry-after']) });
  }
  if (status === 408 || (status >= 500 && status < 600 && status !== 501)) {
    return registrationError('unavailable', message, { upstreamStatus: status, retryAfterS: RETRY_AFTER_DEFAULT_S });
  }
  return registrationError('rejected', message, { upstreamStatus: status });
};

/** HTTP status, `Retry-After` seconds or null, and the fixed text of /api/warp for a registration error. */
const refusalFor = (err) => ({ ...REFUSALS[err.registrationClass], retryAfterS: err.retryAfterS });

// ── Outcome counters (3.1.8, R5 4.D "Лог на сервере") ────────────────────────
// One outcome per registration, in memory of this process. Every 10 minutes with at least one registration in
// the window, and at shutdown (server.js), one line of numbers and the profile name: no IP, id, token, key or text.
const STATS_WINDOW_MS = 10 * 60 * 1000;
const STATS_KEYS = ['ok', 'ok_ipv4_only', 'rate_limited', 'unavailable', 'rejected', 'malformed'];
const emptyStats = () => Object.fromEntries(STATS_KEYS.map((key) => [key, 0]));
let stats = emptyStats();
let statsTimer = null;

/** Logs the window's line and starts a new window; nothing when the window had no registration. */
const flushRegistrationStats = (log = console.log) => {
  if (!STATS_KEYS.some((key) => stats[key] > 0)) return null;
  const line = `[warp-registration-stats] window=600s profile=legacy ${STATS_KEYS.map((key) => `${key}=${stats[key]}`).join(' ')}`;
  stats = emptyStats();
  log(line);
  return line;
};

const recordOutcome = (key) => {
  stats[key] += 1;
  if (!statsTimer) {
    // unref: the window timer never keeps a process (a test, a CLI) alive.
    statsTimer = setInterval(() => flushRegistrationStats(), STATS_WINDOW_MS);
    statsTimer.unref();
  }
};

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
  const code = err.upstreamStatus;
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
    let timer = null;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      let totalBytes = 0;

      res.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          req.destroy();
          // No upstreamStatus: an oversized answer is not repeated whatever its code, as in 3.1.7.
          finish(registrationError('malformed', 'Ответ Cloudflare API слишком большой.'));
          return;
        }
        responseData += chunk;
      });

      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        try {
          const parsedData = responseData ? JSON.parse(responseData) : {};
          if (ok) {
            finish(null, parsedData);
            return;
          }
          finish(statusError(res, parsedData.message || `Ошибка с кодом ${res.statusCode}`));
        } catch {
          const message = 'Не удалось обработать ответ сервера.';
          finish(ok ? registrationError('malformed', message, { upstreamStatus: res.statusCode }) : statusError(res, message));
        }
      });
    });

    req.on('error', (e) => {
      finish(registrationError('unavailable', `Ошибка запроса: ${e.message}`, { code: e.code, retryAfterS: RETRY_AFTER_DEFAULT_S }));
    });

    // Armed only once the request exists: https.request throws synchronously for a path or header value Node
    // refuses (an id or token from Cloudflare), and a timer armed earlier would then touch an uninitialised `req`.
    timer = setTimeout(() => {
      req.destroy();
      finish(registrationError('unavailable', 'Таймаут запроса к Cloudflare API.', { retryAfterS: RETRY_AFTER_DEFAULT_S }));
    }, REQUEST_TIMEOUT_MS);

    if (data) req.write(data);
    req.end();
  });

const handleApiRequest = async (method, endpointPath, body = null, token = null) => {
  let lastErr;
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await httpRequestOnce(method, endpointPath, body, token);
    } catch (caught) {
      // Without a class only a synchronous refusal of https.request: a path or header value Node cannot send
      // (an id or token from Cloudflare). The request never left, so it is not repeated.
      const err = caught.registrationClass
        ? caught
        : registrationError('malformed', `Запрос к Cloudflare API не построен: ${caught.message}`, { code: caught.code });
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
    if (process.env.NODE_ENV !== 'production') {
      console.warn('GET reg/{id} after PATCH failed, using POST reg config:', e.message || e);
    }
  }
  return initialConfig;
};

/**
 * Registers a new device for `publicKey` and returns what the config needs from the registration.
 * `clientIPv6` is null when the answer has no usable IPv6 address (absent, empty or invalid): the config is then
 * IPv4-only (3.1.8); an unusable IPv4 address is an error.
 * @param {string} publicKey base64 X25519 public key of the config's PrivateKey
 * @returns {Promise<{ peerPublicKey: string|undefined, clientIPv4: string, clientIPv6: string|null }>}
 */
const registerDevice = async (publicKey) => {
  try {
    const registration = await register(publicKey);
    recordOutcome(registration.clientIPv6 ? 'ok' : 'ok_ipv4_only');
    return registration;
  } catch (err) {
    if (err.registrationClass) recordOutcome(err.registrationClass);
    throw err;
  }
};

const register = async (publicKey) => {
  const regBody = {
    install_id: '',
    tos: new Date().toISOString(),
    key: publicKey,
    fcm_token: '',
    type: 'ios',
    locale: 'en_US',
  };

  const regResponse = await handleApiRequest('POST', 'reg', regBody);
  const { id, token } = regResponse?.result ?? {};

  if (typeof id !== 'string' || !id || typeof token !== 'string' || !token) {
    throw registrationError('malformed', 'Ошибка: отсутствуют id или token в ответе регистрации');
  }

  await handleApiRequest('PATCH', `reg/${id}`, { warp_enabled: true }, token);

  const initialConfig = regResponse.result?.config;
  if (!initialConfig?.peers?.length) {
    throw registrationError('malformed', 'Ошибка: недостающие данные для формирования конфигурации WARP');
  }

  const config = await mergeConfigAfterWarp(id, token, initialConfig);
  const { v4: clientIPv4, v6: clientIPv6 } = config.interface?.addresses ?? {};
  if (!clientIPv4 || !isValidIPv4(clientIPv4)) {
    throw registrationError('malformed', `Cloudflare вернул некорректный IPv4 адрес: ${clientIPv4 || '(пусто)'}`);
  }
  return { peerPublicKey: config.peers[0]?.public_key, clientIPv4, clientIPv6: isValidIPv6(clientIPv6) ? clientIPv6 : null };
};

module.exports = {
  isValidIPv4,
  isValidIPv6,
  registerDevice,
  refusalFor,
  flushRegistrationStats,
  /** Tests only: the window timer, and a fresh window without a timer. */
  __stats: {
    timer: () => statsTimer,
    reset: () => {
      clearInterval(statsTimer);
      statsTimer = null;
      stats = emptyStats();
    },
  },
};
