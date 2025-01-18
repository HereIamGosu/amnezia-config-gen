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
  '35.255.255.0/32'
];

const CACHE_EXPIRY_TIME = 5 * 60 * 1000; // 5 минут
const FALLBACK_IP = '188.114.97.66';
const WARP_PORT = 3138;

let cachedEndpointIP = null;
let cacheExpiry = null;

async function getEndpointFromAPI() {
  try {
    // Генерация ключевой пары
    const { pubKey } = generateKeys();

    // Отправка запроса на регистрацию устройства
    const response = await handleApiRequest('POST', 'reg', {
      install_id: uuidv4(),
      tos: new Date().toISOString(),
      key: pubKey, // Используем реальный публичный ключ
      fcm_token: '',
      type: 'windows', // Возможно, измените на 'windows', если целевая ОС Windows
      locale: 'en_US',
    });

    // Проверка ответа API
    if (response && response.result && response.result.config && response.result.config.peers) {
      const peers = response.result.config.peers;
      if (peers.length > 0 && peers[0].endpoint) {
        const [ip] = peers[0].endpoint.split(':');
        return ip; // Возвращаем только IP-адрес
      }
    }
    throw new Error('Не удалось получить Endpoint из API.');
  } catch (error) {
    console.error('Ошибка при получении Endpoint из API:', error.message || error);
    throw error;
  }
}

async function resolveEndpoint() {
  if (cachedEndpointIP && Date.now() < cacheExpiry) {
    return cachedEndpointIP;
  }

  try {
    const endpointIP = await getEndpointFromAPI();
    cacheExpiry = Date.now() + CACHE_EXPIRY_TIME;
    cachedEndpointIP = endpointIP;
    return endpointIP;
  } catch (err) {
    console.error('Ошибка при получении Endpoint:', err);
    return FALLBACK_IP;
  }
}

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
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
};

const handleApiRequest = (method, endpoint, body = null, token = null) => new Promise((resolve, reject) => {
  const headers = generateHeaders(token);
  const data = body ? JSON.stringify(body) : null;

  const options = {
    hostname: 'api.cloudflareclient.com',
    port: 443,
    path: `/v0i1909051800/${endpoint}`,
    method,
    headers: {
      ...headers,
      'Content-Length': data ? Buffer.byteLength(data) : 0,
    },
  };

  const req = https.request(options, (res) => {
    let responseData = '';

    res.on('data', (chunk) => {
      responseData += chunk;
    });

    res.on('end', () => {
      try {
        const parsedData = JSON.parse(responseData);
        if (res.statusCode === 200) {
          resolve(parsedData);
        } else {
          const errorMessage = parsedData.message || `Ошибка с кодом ${res.statusCode}`;
          reject(new Error(errorMessage));
        }
      } catch (error) {
        reject(new Error('Не удалось обработать ответ сервера.'));
      }
    });
  });

  req.on('error', (e) => {
    reject(new Error(`Ошибка запроса: ${e.message}`));
  });

  if (data) {
    req.write(data);
  }

  req.end();
});

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
  const { config } = regResponse.result;

  if (!config?.peers?.length || !config.peers[0].public_key) {
    throw new Error('Ошибка: недостающие данные для формирования конфигурации WARP');
  }

  const { public_key: peerPub } = config.peers[0];
  const { v4: clientIPv4, v6: clientIPv6 } = config.interface.addresses;
  const endpointIP = await resolveEndpoint();
  const peerEndpoint = `${endpointIP}:${WARP_PORT}`;

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