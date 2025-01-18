// Импорт необходимых модулей
const nacl = require('tweetnacl'); // Модуль для криптографических операций
const { Buffer } = require('buffer'); // Модуль для работы с бинарными данными
const { v4: uuidv4 } = require('uuid'); // Модуль для генерации уникальных идентификаторов
const https = require('https'); // Модуль для выполнения HTTPS-запросов
const dns = require('dns'); // Модуль для разрешения DNS-запросов

// Фиксированный список IP-адресов, которые будут разрешены через WARP
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

// Время жизни кэша для IP-адреса Endpoint (30 минут)
const CACHE_EXPIRY_TIME = 30 * 60 * 1000;

// Запасной IP-адрес на случай, если DNS-запрос не удастся
const FALLBACK_IP = '188.114.97.66';

// Порт, используемый для подключения к WARP
const WARP_PORT = 3138;

// Переменные для кэширования IP-адреса Endpoint и времени его истечения
let cachedEndpointIP = null;
let cacheExpiry = null;

/**
 * Функция для разрешения IP-адреса Endpoint через DNS.
 * Если IP-адрес уже закэширован и не истёк, возвращает его.
 * В противном случае выполняет DNS-запрос и кэширует результат.
 * @returns {Promise<string>} IP-адрес Endpoint.
 */
async function resolveEndpoint() {
  // Если IP-адрес закэширован и не истёк, возвращаем его
  if (cachedEndpointIP && Date.now() < cacheExpiry) {
    return cachedEndpointIP;
  }

  try {
    // Выполняем DNS-запрос для разрешения IP-адреса
    const addresses = await dns.promises.resolve4('warp.cloudflare.com');
    if (addresses.length === 0) {
      throw new Error('No IP addresses resolved.');
    }

    // Кэшируем первый полученный IP-адрес и устанавливаем время истечения кэша
    cachedEndpointIP = addresses[0];
    cacheExpiry = Date.now() + CACHE_EXPIRY_TIME;
    return cachedEndpointIP;
  } catch (err) {
    // В случае ошибки DNS-запроса возвращаем запасной IP-адрес
    console.error('DNS resolution failed:', err);
    return FALLBACK_IP;
  }
}

/**
 * Генерация ключевой пары для WireGuard с использованием библиотеки TweetNaCl.
 * @returns {Object} Объект с приватным и публичным ключами в формате base64.
 */
const generateKeys = () => {
  // Генерация ключевой пары
  const { secretKey, publicKey } = nacl.box.keyPair();

  // Преобразование ключей в base64
  const privKey = Buffer.from(secretKey).toString('base64');
  const pubKey = Buffer.from(publicKey).toString('base64');

  return { privKey, pubKey };
};

/**
 * Формирование заголовков для HTTP-запросов.
 * @param {string|null} token Токен авторизации, если есть.
 * @returns {Object} Объект с заголовками.
 */
const generateHeaders = (token = null) => {
  const headers = {
    'Content-Type': 'application/json', // Указываем, что данные в формате JSON
  };

  // Если передан токен, добавляем его в заголовки
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return headers;
};

/**
 * Выполнение HTTP-запроса к API Cloudflare.
 * @param {string} method HTTP-метод (GET, POST, PATCH и т.д.).
 * @param {string} endpoint Конечная точка API.
 * @param {Object|null} body Тело запроса.
 * @param {string|null} token Токен авторизации.
 * @returns {Promise<Object>} Ответ API в формате JSON.
 */
const handleApiRequest = (method, endpoint, body = null, token = null) => new Promise((resolve, reject) => {
  // Формируем заголовки запроса
  const headers = generateHeaders(token);
  const data = body ? JSON.stringify(body) : null;

  // Настройки для HTTPS-запроса
  const options = {
    hostname: 'api.cloudflareclient.com', // Хост API Cloudflare
    port: 443, // Порт для HTTPS
    path: `/v0i1909051800/${endpoint}`, // Путь к конечной точке API
    method, // HTTP-метод
    headers: {
      ...headers,
      'Content-Length': data ? Buffer.byteLength(data) : 0, // Длина тела запроса
    },
  };

  // Выполняем HTTPS-запрос
  const req = https.request(options, (res) => {
    let responseData = '';

    // Собираем данные из ответа
    res.on('data', (chunk) => {
      responseData += chunk;
    });

    // Когда данные полностью получены
    res.on('end', () => {
      try {
        // Парсим ответ в формате JSON
        const parsedData = JSON.parse(responseData);

        // Если статус ответа 200, возвращаем данные
        if (res.statusCode === 200) {
          resolve(parsedData);
        } else {
          // В случае ошибки возвращаем сообщение об ошибке
          const errorMessage = parsedData.message || `Ошибка с кодом ${res.statusCode}`;
          reject(new Error(errorMessage));
        }
      } catch (error) {
        // Если не удалось распарсить ответ, возвращаем ошибку
        reject(new Error('Не удалось обработать ответ сервера.'));
      }
    });
  });

  // Обработка ошибок при выполнении запроса
  req.on('error', (e) => {
    reject(new Error(`Ошибка запроса: ${e.message}`));
  });

  // Если есть тело запроса, отправляем его
  if (data) {
    req.write(data);
  }

  // Завершаем запрос
  req.end();
});

/**
 * Генерация конфигурационного файла для WireGuard.
 * @returns {Promise<string>} Конфигурация WireGuard в формате строки.
 */
const generateWarpConfig = async () => {
  // Генерация ключевой пары
  const { privKey, pubKey } = generateKeys();

  // Тело запроса для регистрации устройства
  const regBody = {
    install_id: uuidv4(), // Уникальный идентификатор устройства
    tos: new Date().toISOString(), // Дата и время принятия условий использования
    key: pubKey, // Публичный ключ
    fcm_token: '', // Токен Firebase Cloud Messaging (не используется)
    type: 'ios', // Тип устройства (можно изменить на 'windows' для Windows)
    locale: 'en_US', // Локаль устройства
  };

  // Регистрация устройства в API Cloudflare
  const regResponse = await handleApiRequest('POST', 'reg', regBody);
  const { id, token } = regResponse.result ?? {};

  // Проверка наличия ID и токена в ответе
  if (!id || !token) {
    throw new Error('Ошибка: отсутствуют id или token в ответе регистрации');
  }

  // Включение WARP для зарегистрированного устройства
  await handleApiRequest('PATCH', `reg/${id}`, { warp_enabled: true }, token);

  // Получение конфигурации от API
  const { config } = regResponse.result;

  // Проверка наличия данных о пирах и их публичных ключах
  if (!config?.peers?.length || !config.peers[0].public_key) {
    throw new Error('Ошибка: недостающие данные для формирования конфигурации WARP');
  }

  // Извлечение публичного ключа пира и IP-адресов клиента
  const { public_key: peerPub } = config.peers[0];
  const { v4: clientIPv4, v6: clientIPv6 } = config.interface.addresses;

  // Получение IP-адреса Endpoint через DNS
  const endpointIP = await resolveEndpoint();
  const peerEndpoint = `${endpointIP}:${WARP_PORT}`;

  // Формирование конфигурации WireGuard
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

/**
 * Обработчик HTTP-запросов к API.
 * @param {Object} req Объект запроса.
 * @param {Object} res Объект ответа.
 */
module.exports = async (req, res) => {
  // Поддерживается только метод GET
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, message: 'Метод не поддерживается.' });
    return;
  }

  try {
    // Генерация конфигурации WireGuard
    const conf = await generateWarpConfig();

    // Кодирование конфигурации в base64 для передачи в ответе
    const confEncoded = Buffer.from(conf).toString('base64');

    // Возвращаем успешный ответ с конфигурацией
    res.status(200).json({ success: true, content: confEncoded });
  } catch (error) {
    // В случае ошибки возвращаем сообщение об ошибке
    console.error('Ошибка генерации конфигурации:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};