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

    // Armed only once the request exists: https.request throws synchronously for a path or header value Node
    // refuses (an id or token from Cloudflare), and a timer armed earlier would then touch an uninitialised `req`.
    timer = setTimeout(() => {
      req.destroy();
      finish(new Error('Таймаут запроса к Cloudflare API.'));
    }, REQUEST_TIMEOUT_MS);

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
    if (process.env.NODE_ENV !== 'production') {
      console.warn('GET reg/{id} after PATCH failed, using POST reg config:', e.message || e);
    }
  }
  return initialConfig;
};

/**
 * Registers a new device for `publicKey` and returns what the config needs from the registration.
 * @param {string} publicKey base64 X25519 public key of the config's PrivateKey
 * @returns {Promise<{ peerPublicKey: string|undefined, clientIPv4: string, clientIPv6: string }>}
 */
const registerDevice = async (publicKey) => {
  const regBody = {
    install_id: '',
    tos: new Date().toISOString(),
    key: publicKey,
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
  const { v4: clientIPv4, v6: clientIPv6 } = config.interface?.addresses ?? {};
  if (!clientIPv4 || !isValidIPv4(clientIPv4)) {
    throw new Error(`Cloudflare вернул некорректный IPv4 адрес: ${clientIPv4 || '(пусто)'}`);
  }
  if (!clientIPv6 || !isValidIPv6(clientIPv6)) {
    throw new Error(`Cloudflare вернул некорректный IPv6 адрес: ${clientIPv6 || '(пусто)'}`);
  }
  return { peerPublicKey: config.peers[0]?.public_key, clientIPv4, clientIPv6 };
};

module.exports = {
  isValidIPv4,
  isValidIPv6,
  registerDevice,
};
