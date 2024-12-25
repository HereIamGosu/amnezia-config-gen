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
  const regResponse = await handleApiRequest('POST', 'reg', regBody);
  const { id, token } = regResponse.result;

  // Включение WARP
  const warpResponse = await handleApiRequest('PATCH', `reg/${id}`, { warp_enabled: true }, token);
  const peer = warpResponse.result.config.peers[0];

  const { public_key: peerPub, endpoint, allowed_ips } = peer;
  const [host, port] = typeof endpoint === 'string' ? endpoint.split(':') : [endpoint.host, endpoint.port];

  const interfaceConfig = warpResponse.result.config.interface;
  const clientIPv4 = interfaceConfig.addresses.v4;
  const clientIPv6 = interfaceConfig.addresses.v6;

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
AllowedIPs = ${allowed_ips.join(', ')}
Endpoint = ${host}:${port}`;

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
