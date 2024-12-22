// api/warp.js
const nacl = require('tweetnacl');
const { Buffer } = require('buffer');
const { v4: uuidv4 } = require('uuid');
const https = require('https');

// Генерация ключей
function generateKeys() {
    const keyPair = nacl.box.keyPair();
    return {
        privKey: Buffer.from(keyPair.secretKey).toString('base64'),
        pubKey: Buffer.from(keyPair.publicKey).toString('base64')
    };
}

// Формирование заголовков для запросов
function generateHeaders(token = null) {
    const headers = {
        'Content-Type': 'application/json',
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
}

// Централизованная обработка ошибок и запросов
function handleApiRequest(method, endpoint, body = null, token = null) {
    return new Promise((resolve, reject) => {
        // Генерация заголовков для запроса
        const headers = generateHeaders(token);

        // Опции для запроса
        const options = {
            hostname: 'api.cloudflareclient.com',
            port: 443,
            path: `/v0i1909051800/${endpoint}`,
            method: method,
            headers: headers,
        };

        // Добавляем тело запроса, если оно есть
        if (body) {
            options.body = JSON.stringify(body);
        }

        // Выполнение запроса
        const req = https.request(options, (res) => {
            let data = '';

            // Слушаем поступающие данные
            res.on('data', (chunk) => {
                data += chunk;
            });

            // После получения всех данных
            res.on('end', () => {
                console.log('API response:', data);  // Логируем ответ от API

                try {
                    const parsedData = JSON.parse(data);  // Парсим JSON ответ

                    // Проверка статуса ответа
                    if (res.statusCode === 200) {
                        resolve(parsedData);
                    } else {
                        // Обработка ошибок на уровне API
                        const errorMessage = parsedData.message || `Ошибка с кодом ${res.statusCode}`;
                        reject(new Error(`API Error: ${errorMessage}`));
                    }
                } catch (error) {
                    // Ошибка при парсинге JSON
                    reject(new Error(`Ошибка при парсинге ответа: ${error.message}`));
                }
            });
        });

        // Обработка ошибок запроса
        req.on('error', (e) => {
            reject(new Error(`Ошибка запроса: ${e.message}`));
        });

        // Если есть тело, отправляем его в запросе
        if (body) {
            req.write(options.body);
        }

        // Завершаем запрос
        req.end();
    });
}



// Генерация конфигурации для WARP
async function generateWarpConfig() {
    try {
        const { privKey, pubKey } = generateKeys();
        console.log('Сгенерированные ключи:', { privKey, pubKey });

        const regBody = {
            install_id: uuidv4(),
            tos: new Date().toISOString(),
            key: pubKey,
            fcm_token: "",
            type: "ios",
            locale: "en_US"
        };

        let regResponse;
        try {
            regResponse = await handleApiRequest('POST', 'reg', regBody);
            console.log('Ответ регистрации:', regResponse);
        } catch (error) {
            console.error('Ошибка при регистрации устройства:', error);
            throw new Error(`Ошибка при регистрации устройства: ${error.message}`);
        }

        // Проверка наличия id и token
        if (!regResponse.result || !regResponse.result.id || !regResponse.result.token) {
            throw new Error('Ошибка: отсутствуют id или token в ответе регистрации');
        }

        const { id, token } = regResponse.result;

        let warpResponse;
        try {
            warpResponse = await handleApiRequest('PATCH', `reg/${id}`, { warp_enabled: true }, token);
            console.log('Ответ WARP:', warpResponse);
        } catch (error) {
            console.error('Ошибка при включении WARP:', error);
            throw new Error(`Ошибка при включении WARP: ${error.message}`);
        }

        // Проверка наличия данных для конфигурации
        if (!warpResponse.result || !warpResponse.result.config || !warpResponse.result.config.peers || !warpResponse.result.config.peers[0]) {
            throw new Error('Ошибка: отсутствуют данные для формирования конфигурации WARP');
        }

        const peer = warpResponse.result.config.peers[0];
        const { public_key: peer_pub, endpoint, allowed_ips: allowed_ips_raw } = peer;

        // Проверка наличия необходимых полей
        if (!peer_pub || !endpoint) {
            throw new Error('Ошибка: недостающие данные для формирования конфигурации WARP');
        }

        // Извлечение хоста и порта из endpoint
        let host, port;
        if (typeof endpoint === 'string') {
            [host, port] = endpoint.split(':');
        } else if (typeof endpoint === 'object') {
            host = endpoint.host;
            port = endpoint.port;
        }

        if (!host || !port) {
            throw new Error('Ошибка: недостающие данные в endpoint');
        }

        const peer_endpoint = `${host}:${port}`;

        // Извлечение адресов из интерфейса
        const interfaceConfig = warpResponse.result.config.interface;
        const client_ipv4 = interfaceConfig.addresses.v4;
        const client_ipv6 = interfaceConfig.addresses.v6;

        if (!client_ipv4 || !client_ipv6) {
            throw new Error('Ошибка: отсутствуют клиентские IP-адреса');
        }

        console.log('Информация о Peer:', { peer_pub, peer_endpoint, client_ipv4, client_ipv6 });

        // Формируем конфигурацию WireGuard
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
Address = ${client_ipv4}/32, ${client_ipv6}/128
DNS = 1.1.1.1, 2606:4700:4700::1111, 1.0.0.1, 2606:4700:4700::1001

[Peer]
PublicKey = ${peer_pub}
AllowedIPs = 138.128.136.0/21, 162.158.0.0/15, 172.64.0.0/13, 34.0.0.0/15, 34.2.0.0/16, 34.3.0.0/23, 34.3.2.0/24, 35.192.0.0/12, 35.208.0.0/12, 35.224.0.0/12, 35.240.0.0/13, 5.200.14.128/25, 66.22.192.0/18, 13.32.0.0/32, 13.35.0.0/32, 13.48.0.0/32, 13.64.0.0/32, 13.128.0.0/32, 13.192.0.0/32, 13.224.0.0/32, 13.240.0.0/32, 13.248.0.0/32, 13.252.0.0/32, 13.254.0.0/32, 13.255.0.0/32, 18.67.0.0/32, 23.20.0.0/32, 23.40.0.0/32, 23.64.0.0/32, 23.128.0.0/32, 23.192.0.0/32, 23.224.0.0/32, 23.240.0.0/32, 23.248.0.0/32, 23.252.0.0/32, 23.254.0.0/32, 23.255.0.0/32, 34.200.0.0/32, 34.224.0.0/32, 34.240.0.0/32, 35.255.255.0/32
Endpoint = ${peer_endpoint}`;

        return conf;
    } catch (error) {
        console.error('Ошибка в generateWarpConfig:', error);
        throw error;
    }
}

// Основная функция для генерации ссылки на скачивание конфигурации
async function getWarpConfigLink() {
    try {
        const conf = await generateWarpConfig();
        const confBase64 = Buffer.from(conf).toString('base64');
        return { success: true, content: confBase64 };
    } catch (error) {
        console.error('Ошибка при генерации конфигурации:', error);
        return { success: false, message: error.message };
    }
}

// Экспортируем функцию для использования в Vercel API Route
module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        res.status(405).json({ success: false, message: 'Method not allowed' });
        return;
    }

    try {
        const result = await getWarpConfigLink();
        res.status(200).json(result);
    } catch (error) {
        console.error('Необработанная ошибка в API:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка на сервере: ' + (error.message || 'Неизвестная ошибка')
        });
    }
};
