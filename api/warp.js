const nacl = require('tweetnacl');
const { Buffer } = require('buffer');
const { v4: uuidv4 } = require('uuid');
const https = require('https');

const FIXED_ALLOWED_IPS = [
  '138.128.136.0/21', '162.158.0.0/15', '172.64.0.0/13', '34.0.0.0/15',
  '34.2.0.0/16', '34.3.0.0/23', '34.3.2.0/24', '35.192.0.0/12',
  '35.208.0.0/12', '35.224.0.0/12', '35.240.0.0/13', '5.200.14.128/25',
  '66.22.192.0/18', '13.32.0.0/32', '13.35.0.0/32', '13.48.0.0/32',
  '13.64.0.0/32', '13.128.0.0/32', '13.192.0.0/32', '13.224.0.0/32',
  '13.240.0.0/32', '13.248.0.0/32', '13.252.0.0/32', '13.254.0.0/32',
  '13.255.0.0/32', '18.67.0.0/32', '23.20.0.0/32', '23.40.0.0/32',
  '23.64.0.0/32', '23.128.0.0/32', '23.192.0.0/32', '23.224.0.0/32',
  '23.240.0.0/32', '23.248.0.0/32', '23.252.0.0/32', '23.254.0.0/32',
  '23.255.0.0/32', '34.200.0.0/32', '34.224.0.0/32', '34.240.0.0/32',
  '35.255.255.0/32',
];

const FALLBACK_IP = '188.114.97.66';
const WARP_PORT = 3138;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const API_PREFIX = '/v0i1909051800';

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

const handleApiRequest = (method, endpointPath, body = null, token = null) =>
  new Promise((resolve, reject) => {
    const headers = generateHeaders(token);
    const data = body ? JSON.stringify(body) : null;

    const options = {
      hostname: 'api.cloudflareclient.com',
      port: 443,
      path: `${API_PREFIX}/${endpointPath}`,
      method,
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
          finish(new Error(errorMessage));
        } catch {
          finish(new Error('Не удалось обработать ответ сервера.'));
        }
      });
    });

    req.on('error', (e) => {
      finish(new Error(`Ошибка запроса: ${e.message}`));
    });

    if (data) req.write(data);
    req.end();
  });

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

const generateWarpConfig = async () => {
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

  let endpointHost = pickEndpointHost(config);
  if (!endpointHost) {
    endpointHost = FALLBACK_IP;
  }

  const peerEndpoint = `${endpointHost}:${WARP_PORT}`;

  return `[Interface]
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
DNS = 1.1.1.1, 2606:4700:4700::1111, 1.0.0.1, 2606:4700:4700::1001

[Peer]
PublicKey = ${peerPub}
AllowedIPs = ${FIXED_ALLOWED_IPS.join(', ')}
Endpoint = ${peerEndpoint}`;
};

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, message: 'Метод не поддерживается.' });
    return;
  }

  try {
    const conf = await generateWarpConfig();
    const confEncoded = Buffer.from(conf).toString('base64');
    res.status(200).json({ success: true, content: confEncoded });
  } catch (error) {
    console.error('Ошибка генерации конфигурации:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};
