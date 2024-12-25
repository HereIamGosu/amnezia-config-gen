// api/warp.js

const nacl = require('tweetnacl');
const { Buffer } = require('buffer');
const { v4: uuidv4 } = require('uuid');
const https = require('https');

/**
 * Генерация ключевой пары с использованием TweetNaCl.
 * @returns {Object} Объект с приватным и публичным ключами в формате base64.
 */
function generateKeys() {
  const keyPair = nacl.box.keyPair();
  const privKey = Buffer.from(keyPair.secretKey).toString('base64');
  const pubKey = Buffer.from(keyPair.publicKey).toString('base64');
  return { privKey, pubKey };
}

/**
 * Формирование заголовков для HTTP-запросов.
 * @param {string|null} token Токен авторизации, если есть.
 * @returns {Object} Объект с заголовками.
 */
function generateHeaders(token = null) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Выполнение HTTP-запроса к API Cloudflare.
 * @param {string} method HTTP-метод (GET, POST, PATCH и т.д.).
 * @param {string} endpoint Конечная точка API.
 * @param {Object|null} body Тело запроса.
 * @param {string|null} token Токен авторизации.
 * @returns {Promise<Object>} Ответ API в формате JSON.
 */
function handleApiRequest(method, endpoint, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const headers = generateHeaders(token);
    const data = body ? JSON.stringify(body) : null;

    const options = {
      hostname: 'api.cloudflareclient.com',
      port: 443,
      path: `/v0i1909051800/${endpoint}`,
      method: method,
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
        console.log(`Response from API (${method} ${endpoint}):`, responseData);
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
}

/**
 * Фиксированный список AllowedIPs.
 */
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

/**
 * Генерация конфигурационного файла WARP.
 * @returns {Promise<string>} Конфигурация WireGuard в формате строки.
 */
async function generateWarpConfig() {
  const { privKey, pubKey } = generateKeys();

  const regBody = {
    install_id: uuidv4(),
    tos: new Date().toISOString(),
    key: pubKey,
    fcm_token: "",
    type: "ios",
    locale: "en_US",
  };

  // Регистрация устройства
  let regResponse;
  try {
    regResponse = await handleApiRequest('POST', 'reg', regBody);
    console.log('Регистрация устройства успешна:', regResponse);
  } catch (error) {
    console.error('Ошибка при регистрации устройства:', error);
    throw new Error(`Ошибка при регистрации устройства: ${error.message}`);
  }

  if (!regResponse.result || !regResponse.result.id || !regResponse.result.token) {
    console.error('Недостаточные данные в ответе регистрации:', regResponse);
    throw new Error('Ошибка: отсутствуют id или token в ответе регистрации');
  }

  const { id, token } = regResponse.result;
  console.log(`Данные регистрации получены: id = ${id}, token = ${token}`);

  // Включение WARP
  let warpResponse;
  try {
    warpResponse = await handleApiRequest('PATCH', `reg/${id}`, { warp_enabled: true }, token);
    console.log('Включение WARP успешна:', warpResponse);
  } catch (error) {
    console.error('Ошибка при включении WARP:', error);
    throw new Error(`Ошибка при включении WARP: ${error.message}`);
  }

  if (!warpResponse.result || !warpResponse.result.config || !warpResponse.result.config.peers || !Array.isArray(warpResponse.result.config.peers) || warpResponse.result.config.peers.length === 0) {
    console.error('Недостаточные данные в ответе включения WARP:', warpResponse);
    throw new Error('Ошибка: отсутствуют данные для формирования конфигурации WARP');
  }

  const peer = warpResponse.result.config.peers[0];
  const { public_key: peerPub, endpoint } = peer;

  if (!peerPub || !endpoint) {
    console.error('Недостающие данные для формирования конфигурации WARP:', peer);
    throw new Error('Ошибка: недостающие данные для формирования конфигурации WARP');
  }

  console.log('Данные для конфигурации получены:', { peerPub, endpoint });

  let host, port;
  if (typeof endpoint === 'string') {
    [host, port] = endpoint.split(':');
  } else if (typeof endpoint === 'object') {
    host = endpoint.host;
    port = endpoint.port;
  }

  if (!host || !port) {
    console.error('Недостающие данные в endpoint:', endpoint);
    throw new Error('Ошибка: недостающие данные в endpoint');
  }

  const peerEndpoint = `${host}:${port}`;
  console.log('Данные для Peer:', { peerEndpoint });

  const interfaceConfig = warpResponse.result.config.interface;
  const clientIPv4 = interfaceConfig.addresses.v4;
  const clientIPv6 = interfaceConfig.addresses.v6;

  if (!clientIPv4 || !clientIPv6) {
    console.error('Отсутствуют клиентские IP-адреса:', interfaceConfig);
    throw new Error('Ошибка: отсутствуют клиентские IP-адреса');
  }

  console.log('Клиентские IP-адреса:', { clientIPv4, clientIPv6 });

  // Используем фиксированный список AllowedIPs
  const conf = `[Interface]
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

  console.log('Сформирована конфигурация WireGuard:', conf);
  return conf;
}

/**
 * Обработчик HTTP-запросов к API.
 * @param {Object} req Объект запроса.
 * @param {Object} res Объект ответа.
 */
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
