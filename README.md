# 🌐🔧 Генератор конфигурации AmneziaWG

Веб-приложение предназначено для генерации конфигурационных файлов для **AmneziaWG** — клиента WireGuard. Оно позволяет пользователю создать конфигурацию, скачать её и использовать в своей системе, а также получить файл планировщика для автоматического подключения при запуске системы. Проект уже развёрнут и доступен по адресу: [https://valokda-amnezia.vercel.app/](https://valokda-amnezia.vercel.app/).

![Интерфейс приложения](https://i.imgur.com/xjgNNQX.png)

## ✨ Основные особенности

- **Генерация конфигурации** для AmneziaWG с предустановленными маршрутами для Discord: режим **Legacy** (порядок полей как в типичном экспорте WARP: `Address`/`DNS`/`MTU`, явные **`S1 = 0`**, **`S2 = 0`**, затем Jc/Jmin/Jmax и H1=1..H4=4; при необходимости строка **`I1`** для CPS) или **AmneziaWG 2.0** для **WARP** (`template=warp_amnezia_awg2`, в т.ч. по умолчанию для `mode=awg2`): **H1–H4 = 1..4** (пир Cloudflare — обычный WireGuard; случайные полосы H ломают рукопожатие), **`S1`/`S2` = 0**, случайные **`S3`/`S4`** в пределах документации 2.0 (**S1–S3 ≤ 64**, **S4 ≤ 32** байт), **Jc/Jmin/Jmax** в пределах 2.0 (**Jc 1–10**, **Jmin/Jmax 64–1024**), порядок секции `[Interface]` как в примерах AWG 2.0, пять CPS-строк **`i1`–`i5`** (не `I1`), каждая генерируется на сервере при запросе (`api/cpsSignatureGenerator.js`). Для **своего** сервера AmneziaWG 2.0 с произвольными полосами H — **`template=awg2_random`** (без пресета engage; endpoint задаёте сами; те же лимиты S/J по доке; CPS по-прежнему **`i1`–`i5`**).
- **Скачивание сгенерированного конфигурационного файла** в формате `.conf`.
- **Скачивание .bat-файла** для автоматического запуска AmneziaWG при старте системы (только для Windows). По умолчанию в `SchedulerAmnezia.bat` указан конфиг `AmneziaWarp-AWG2.conf` в папке «Загрузки»; для Legacy замените `CONFIG_FILE` на `AmneziaWarp.conf`.
- **Инструкция по установке и настройке** прямо на сайте.
- **Динамическое обновление Endpoint** — приоритетно из ответа Cloudflare; при отсутствии хоста в JSON — случайный выбор из запасных WARP-совместимых адресов.
- **Устойчивость Cloudflare API** — повторные попытки с экспоненциальной задержкой при таймаутах, сбросах соединения, 429 и 502/503/504 (см. `api/warp.js`).
- **DNS** — по умолчанию в UI и в `GET /api/warp` без параметра `dns` используется пресет **Cloudflare** (`dns=cloudflare`), плитка подписана «(по умолчанию)».
- **Пресеты маршрутов** — в настройках (⚙) можно выбрать пресеты по категориям (соцсети, игры, торренты, дополнительно); для них на сервере собираются подсети IPv4 и IPv6 в `AllowedIPs`. Без выбора — полный туннель. В ответе `GET /api/iplist` у каждого пресета есть поле `category`: `social` \| `gaming` \| `torrent` \| `more`. **API WARP:** `GET` или `POST /api/warp` — параметры query дублируются в JSON-теле `POST` (удобно для большого **`i1`**). При **`mode=legacy`** без параметра **`template`** сервер применяет те же настройки, что и **`template=warp_amnezia`** (plain `Address`, `engage.cloudflareclient.com:4500`, `PersistentKeepalive = 25`, сгенерированный **`I1`** при отсутствии **`i1`**/**`i1Ref`** — та же схема CPS, что первая подпись в AWG2). При **`mode=awg2`** без **`template`** — как **`template=warp_amnezia_awg2`**: тот же **`Endpoint`**/keepalive/plain **`Address`**, при отсутствии **`i1`**/**`i1Ref`** — **`i1`–`i5`** генерируются на лету; отдельно можно передать **`i2`**–**`i5`** (query/JSON) для подстановки своих цепочек, **H1–H4 = 1..4**, **S3/S4** и **Jc/Jmin/Jmax** в допустимых для AWG 2.0 диапазонах (см. выше). Шаблоны: **`template=warp_amnezia`** (принудительно Legacy, `Endpoint = engage.cloudflareclient.com:4500` если не задан свой endpoint, **`keepalive=25`** по умолчанию, **`Address`** без `/32` и `/128`, **`I1`** из рантайм-генерации если нет **`i1`**/**`i1Ref`**), **`template=warp_amnezia_awg2`** (то же для peer/Address, **`i1`–`i5`** + S3/S4 + WARP-совместимые H1–H4 и J по доке 2.0), **`template=awg2_random`** / **`awg2_dpi`** (случайные полосы H1–H4, не для Cloudflare WARP) или **`template=wgcf`** (тот же хост, порт **2408**, без встроенного I1). **`plainAddress=1`** или **`true`** — вручную убрать маски с адресов. Поле **`I1`** / **`i1`–`i5`** (CPS в AmneziaWG) **не** выдаётся Cloudflare API; передают в **`i1`**, **`i1Ref`** (`api/cps-presets/*.txt`), **`i2`–`i5`** (только AWG2), или используют шаблон `warp_amnezia` / дефолт AWG2. Поля: `mode`, `presets`, `dns`, **`peerEndpoint`** или **`endpoint`**, **`warpPort`**, **`persistentKeepalive`** или **`keepalive`**, **`i1`**, **`i1Ref`**, **`i2`**–**`i5`**. Примеры: `GET /api/warp?template=warp_amnezia`; `GET /api/warp?mode=legacy&keepalive=25&endpoint=engage.cloudflareclient.com%3A4500`. Предпросмотр CIDR: `GET /api/iplist?presets=...`. Если открыта только статика (`public`), UI подхватывает `public/static/presets-fallback.json` (список пресетов и DNS-плитки); предпросмотр CIDR и генерация с маршрутами по-прежнему требуют `vercel dev` или деплой. После правок в `api/routePresets.js` обновите файл: `npm run presets:fallback`.
- **Совместимость** с операционными системами Windows, Linux и Android (конфигурация работает на всех платформах, файл планировщика — только для Windows).

## 🚀 Как использовать

1. Перейдите на веб-сайт: [https://valokda-amnezia.vercel.app/](https://valokda-amnezia.vercel.app/).
2. Нажмите **«Сгенерировать (Legacy)»** или **«Сгенерировать AmneziaWG 2.0»** в зависимости от версии клиента. API: `GET /api/warp?mode=legacy` или `GET /api/warp?mode=awg2` (в ответе также поле `mode`); при необходимости — `POST` с JSON (см. выше).
3. Скачайте сгенерированный файл и настройте AmneziaWG согласно инструкциям на сайте.
4. Для автоматической настройки запуска AmneziaWG при старте системы:
   - Скачайте **.bat-файл для планировщика**.
   - Запустите его **от имени администратора**.

## 📂 Структура проекта

- **/static** — статические файлы (изображения, стили и скрипты).
- **index.html** — главный HTML-файл, который загружается при посещении страницы.
- **styles.css** — стили для веб-приложения.
- **script.js** — JavaScript-код для взаимодействия с интерфейсом и генерации конфигурации.
- **api/warp.js** — серверless-обработчик Vercel: регистрация WARP через `api.cloudflareclient.com` (пустой `install_id`, `type: ios`, заголовок `User-Agent: okhttp/3.12.1`), ретраи, сборка `.conf` для Legacy или AWG 2.0; шаблоны **`template`**, запасной **`PublicKey`** пира, **`engage.cloudflareclient.com`** с портами 2408/4500; опционально `AllowedIPs` по `presets`, `I1`/`i1`–`i5`/`i1Ref`, `PersistentKeepalive`, `plainAddress`. **`api/cpsSignatureGenerator.js`** — генерация CPS-цепочек **`i1`–`i5`** для AWG2 и первой подписи для Legacy. Каталог **`api/cps-presets/`** — текстовые файлы для `i1Ref` (см. `README.txt` внутри).
- **api/iplist.js** — метаданные пресетов и предпросмотр CIDR для выбранных пресетов.
- **api/ipListFetch.js**, **api/routePresets.js** — запрос CIDR по доменам и каталог пресетов.
- **README.md** — документация проекта.

## 🤝 Вклад

Если вы хотите внести изменения или улучшения в проект, пожалуйста:

1. Создайте **форк** репозитория.
2. Создайте новую ветку для ваших изменений:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. Внесите изменения и закоммитьте их:
   ```bash
   git commit -m "Добавлен новый функционал: ваш_функционал"
   ```
4. Отправьте изменения в ваш форк:
   ```bash
   git push origin feature/your-feature-name
   ```
5. Создайте **пулл-реквест** в основной репозиторий.

## 📞 Контакты

По вопросам и предложениям обращайтесь:
- **Discord**: [Присоединиться к серверу](https://discord.gg/XGNtYyGbmM)
- **Веб-страница**: [Посетить веб-страницу](https://valokda.vercel.app/)

## 🚀 Star History

<a href="https://star-history.com/#HereIamGosu/amnezia-config-gen&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=HereIamGosu/amnezia-config-gen&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=HereIamGosu/amnezia-config-gen&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=HereIamGosu/amnezia-config-gen&type=Date" />
 </picture>
</a>
