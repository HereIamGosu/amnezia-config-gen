# 🌐🔧 Генератор конфигурации AmneziaWG

[English](./README.md) | [Русский](./README.ru.md)

Веб-интерфейс и HTTP API для сборки файлов `.conf` под клиент **AmneziaWG** (WireGuard с расширениями Amnezia). Основной сценарий — профиль **Cloudflare WARP**: регистрация через официальный API, выдача ключа и параметров туннеля, опционально сужение `AllowedIPs` по выбранным пресетам доменов. С версии 3.0 endpoint можно взять и из **Endpoint Lab** — собственной проверки WARP endpoint'ов проекта.

| | |
| --- | --- |
| **Генератор** | <https://awgconfig.com/> |
| **Telegram-канал** | <https://t.me/amnezia_config> |
| **Исходный код** | <https://github.com/HereIamGosu/amnezia-config-gen> |

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js 22](https://img.shields.io/badge/node-22.x-brightgreen)](https://nodejs.org/)
[![CI](https://github.com/HereIamGosu/amnezia-config-gen/actions/workflows/ci.yml/badge.svg)](https://github.com/HereIamGosu/amnezia-config-gen/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/HereIamGosu/amnezia-config-gen)](https://github.com/HereIamGosu/amnezia-config-gen/releases/latest)
[![Last Commit](https://img.shields.io/github/last-commit/HereIamGosu/amnezia-config-gen)](https://github.com/HereIamGosu/amnezia-config-gen/commits/main)
[![Open Issues](https://img.shields.io/github/issues/HereIamGosu/amnezia-config-gen)](https://github.com/HereIamGosu/amnezia-config-gen/issues)

![Генератор конфигов AmneziaWG 3.0: выбор профиля, сводка параметров и статус системы](docs/images/awgconfig-3.0-ru.png)

## Возможности

- Явный выбор режима маршрутизации: полный туннель (весь трафик) или выборочная маршрутизация (только выбранные направления)
- Четыре формата: **Legacy**, **AWG 2.0**, **AWG 3.0** и **AWG 3.1** (`mode=legacy|awg2|awg3|awg31`). Для AWG 3.x применяется WARP-safe клиентский профиль.
- До трёх конфигов за один запрос (`count=1..3`), у каждого своя регистрация WARP и свои ключи.
- **Endpoint Lab** (`/lab`, `/en/lab`, `GET /api/lab`): публичный просмотр WARP endpoint'ов (`IP:UDP-порт`), которые сервер проекта проверяет настоящим WireGuard handshake и HTTPS-трафиком через туннель. Прошедший проверку endpoint считается ACTIVE 7 минут, дальше он должен пройти её снова. Проверки идут с сервера проекта: они показывают, что endpoint работает оттуда, а не из любой сети.
- **Lab Auto** (`endpointMode=lab`): каждый конфиг получает свой свежий ACTIVE endpoint из Lab, IP не повторяются. Без свежих данных Lab конфиг не создаётся (`503 lab_*`), молчаливой подмены нет. В веб-интерфейсе это endpoint по умолчанию, пока пул Lab свежий; иначе интерфейс выбирает hostname `engage.cloudflareclient.com` и объясняет почему, а при отказе Lab предлагает явную кнопку «Сгенерировать через hostname». В API по умолчанию по-прежнему hostname.
- Тёмный интерфейс на русском (`/`) и английском (`/en`); язык определяется адресом. Карточка «Статус системы» показывает API генератора, регистрацию WARP, WARP endpoint, списки маршрутов (каталог сайта и iplist.opencck.org) и Endpoint Lab.
- Пресеты маршрутов в десяти категориях; плитка показывает цену в строках `AllowedIPs` и точность адресов. Пресеты каталога берут сети из каталога адресов сайта `src/server/ipCatalog/snapshot.json`: он собирается заранее из официальных списков сервисов, анонсов их автономных систем и собственного резолва их доменов. Переходные пресеты (YouTube, Instagram, Facebook, WhatsApp, Discord и пресеты, чей рецепт каталога не прошёл проверку покрытия) при запросе читают iplist.opencck.org и списки itdoginfo, с запасом из каталога. Из IPv4-части исключаются четыре подсети WARP `162.159.192.0/24`, `162.159.193.0/24`, `162.159.195.0/24`, `162.159.204.0/24`, остальное объединяется в наименьшее число блоков с тем же множеством адресов; выборочный конфиг никогда не направляет в туннель собственный `Endpoint`. Без выбора — `0.0.0.0/0`; `::/0` добавляется только при явно включённом IPv6.
- Несколько пресетов DNS для строки `DNS` в конфиге.
- Скачивание `.conf` для импорта в AmneziaWG и совместимые клиенты.
- После генерации карточка результата объясняет формат AWG, число вариантов, источники endpoint и маршрутов, профили, IPv6, наличие `vpn://`, уровни риска и первые шаги диагностики.
- Опциональные расширения `cps5`, `mobile`, `link` (см. [Опциональные расширения](#опциональные-расширения)).
- Запросы к Cloudflare WARP API с повторными попытками при сетевых ошибках и ответах 429 / 502 / 503 / 504.

## Telegram-канал

В Telegram-канале **[Amnezia Config](https://t.me/amnezia_config)** публикуются разборы обновлений генератора, диагностика проблем с endpoint, DNS, UDP, AllowedIPs, mobile profile и импортом конфигов.

Канал не обещает универсальную работу конфига в любой сети. Материалы объясняют, как устроены настройки и где искать причину, если подключение ведёт себя по-разному на разных устройствах или сетях.

## Требования

- **Node.js 22** (`engines` в `package.json`).
- **Vercel CLI** нужен только для `npm start` (`vercel dev`): `npm i -g vercel` или `npx vercel dev`.

Отдельного `.env` для работы API не требуется — обращение идёт к публичному `api.cloudflareclient.com`.

## Локальный запуск

```bash
npm install
npm start          # vercel dev → http://localhost:3000
# или тот же runtime, что в production, без Vercel:
node server.js     # http://localhost:3000 (PORT, HOST)
```

Если открыть только статические файлы из `public/` без сервера, интерфейс подгрузит каталог пресетов с ценой каждого из `public/static/presets-fallback.json` и покажет счётчик маршрутов как оценку (сумму цен плиток), но вызовы `/api/iplist` и `/api/warp` работать не будут.

Данных Endpoint Lab в репозитории нет. Локально `/lab` сообщает, что данных Lab нет, `/api/lab` отвечает `503 lab_not_available`, Lab Auto — `503 lab_unavailable`; режим hostname работает. Чтобы увидеть Lab локально, укажите в `ENDPOINT_LAB_PUBLIC_DIR` (абсолютный путь, читается при старте) копию публичного каталога Lab.

## Деплой

Официальный сайт <https://awgconfig.com/> размещён на собственном сервере: каждый push в `main`,
прошедший CI, собирается один раз, проверяется и публикуется в GHCR по digest; сервер сам забирает
проверенный образ и переключает трафик blue/green с автоматическим откатом. Подробности:
[`deploy/CI_CD.md`](deploy/CI_CD.md), [`deploy/CONTROLLER.md`](deploy/CONTROLLER.md).

Endpoint Lab работает на том же сервере отдельной хостовой службой (`deploy/endpoint-lab/`);
веб-контейнер получает только публичный каталог Lab без секретов, смонтированный только для чтения.
Подробности: [`deploy/ENDPOINT_LAB.md`](deploy/ENDPOINT_LAB.md).

Форки по-прежнему работают на **Vercel**: подключите репозиторий в панели Vercel или выполните
`vercel` / `vercel --prod` из каталога проекта. У форка нет Endpoint Lab: генератор работает в
режиме hostname, `/lab` сообщает, что данных Lab нет.

## Privacy-safe telemetry

Продуктовые события отправляются через существующую Yandex.Metrika с помощью no-op-safe adapter `public/static/analytics.js`. Если аналитика недоступна или заблокирована, генерация и остальные действия продолжают работать без ошибок.

События: `generation_started`, `generation_succeeded`, `generation_partially_succeeded`, `generation_failed`, `config_downloaded`, `config_preview_opened`, `vpn_link_copied`, `history_item_previewed`, `history_item_downloaded`, `healthcheck_opened`, `status_modal_opened`.

Разрешены только ограниченные продуктовые метаданные: режим, количества конфигов, категории источников endpoint/маршрутов, предупреждения, full/split, mobile/router, CPS, безопасные boolean-флаги WARP-safe/timing/experimental padding, длительность и категория ошибки. Adapter **не собирает** содержимое `.conf`, ключи, WARP-токены, полные endpoint-строки, `AllowedIPs`, custom CIDR, исходные сообщения ошибок и полный user agent.

## Структура репозитория

| Путь | Назначение |
|---|---|
| `public/index.html` | Точка входа UI (русская версия, `/`) |
| `public/en/index.html`, `public/en/lab/index.html` | Английские страницы (`/en`, `/en/lab`), генерируются `npm run seo:en` — не править вручную |
| `public/lab/` | Страница Endpoint Lab (`/lab`): разметка, стили и скрипты |
| `public/404.html`, `robots.txt`, `sitemap.xml`, `llms.txt`, `.well-known/security.txt` | Страница ошибки и файлы для поисковиков, ИИ-поиска и сообщений об уязвимостях |
| `public/static/*.js`, `styles.css` | Фронтенд: `script.js` (генерация и связка) плюс `i18n.js`, `common.js`, `status.js`, `live-status.js`, `result.js`, `result-explanation.js`, `settings.js`, `settings-link.js`, `history.js`, `share-link.js`, `ui-shell.js`, `analytics.js`, `metrika.js`, `status-page.js`; стили |
| `public/locales/{ru,en}.json` | Строки интерфейса на двух языках |
| `public/static/presets-fallback.json` | Запасной каталог пресетов без API |
| `api/warp.js` | Эндпоинт генерации WARP-конфига (режим hostname и Lab Auto) |
| `api/iplist.js` | Список пресетов и предпросмотр CIDR |
| `api/status.js`, `api/healthcheck.js` | Данные для карточки «Статус системы» |
| `api/lab.js` | Данные Endpoint Lab для `/lab`, только чтение |
| `src/server/awg/` | AWG-профили, строгие ranges, WARP safety и финальная сериализация |
| `src/server/routePresets.js` | Каталог пресетов и DNS (источник правды) |
| `src/server/ipCatalog/` | Каталог адресов пресетов: `snapshot.json` (собирает `npm run ipcatalog:build`), ленивая загрузка, резолвер `/api/warp` и `/api/iplist`, проверки `npm run ipcatalog:check` |
| `src/server/ipListFetch.js` | Живые списки маршрутов переходных пресетов: iplist.opencck.org, затем itdoginfo (кэш непустых ответов в памяти на 10 минут) |
| `src/server/presetStats.js` | Строка `[preset-stats]`: успешные выборочные генерации по пресетам раз в 10 минут, без IP |
| `src/server/warpCpsPayloads.js`, `src/server/cps/` | Пул верифицированных WARP-совместимых CPS payload'ов и генераторы CPS-пакетов |
| `src/server/cps-presets/` | Текстовые файлы для query-параметра `i1Ref` |
| `src/server/cpsExtraPackets.js` | Генерация I2..I5 для `cps5=1` (runtime-цепочки `<b>`/`<r>`/`<t>`) |
| `src/server/vpnLinkBuilder.js` | Сборка `vpn://...` ссылки для AmneziaVPN |
| `src/server/labPublic.js`, `src/server/endpointProvider.js` | Чтение и проверка публичных файлов Lab; выбор endpoint'ов для Lab Auto |
| `src/server/_rateLimit.js` | Per-IP rate-limit (10 генераций/мин) |
| `server.js` | Self-hosted runtime для production: маршруты и заголовки из `vercel.json` |
| `deploy/` | Docker-образ, nginx, контроллер blue/green-деплоя, хостовая служба Endpoint Lab (`deploy/endpoint-lab/`) |
| `scripts/dump-presets-fallback.js` | Пересборка `presets-fallback.json` из `routePresets.js` и снапшота каталога |
| `scripts/ipcatalog/` | Сборщик каталога (запускает сопровождающий, не в пути запроса и не в CI) и его проверка |
| `__tests__/` | Набор тестов `node:test`, включая тесты критических инвариантов `invariant-*.test.js` |
| `e2e/` | Браузерные тесты в локальном Chrome (`npm run test:e2e`) |

## Критические инварианты

Эти правила нетривиальны, легко нарушить, и сломанный туннель проявляется молча. Они закреплены в `__tests__/invariant-*.test.js`. **При изменении любого инварианта обновляйте и тест, и этот блок.**

| ID | Правило | Почему |
|---|---|---|
| **I1** | Строка в `[Interface]` ОБЯЗАНА быть **uppercase** `I1`, не `i1`. | Lowercase `i1` молча игнорируется AmneziaWG-клиентом для Windows. Источник: [wg-easy/wg-easy#2439](https://github.com/wg-easy/wg-easy/issues/2439). |
| **I2** | Во всех WARP-safe профилях AWG 2/3.x: `S1 = S2 = S3 = S4 = 0`. | Cloudflare — стандартный WireGuard peer и не добавляет AWG-префиксы. |
| **I3** | Во всех WARP-safe профилях AWG 2/3.x: `H1..H4 = 1, 2, 3, 4`. | Cloudflare ожидает стандартные WireGuard message types. |
| **I4** | WARP-safe профили используют `MTU = 1280`; AWG 3.x не выводит `HeaderProtectionKey` и не включает `RandomTrailers`; `DisableCookies` — локальная опция по запросу (`disableCookies=on`), по умолчанию не пишется. | Peer-dependent wire-format несовместим со стандартным Cloudflare peer; локальное cookie-поведение не требует поддержки Cloudflare. |
| **I5** | Порядок полей в `[Interface]` для AmneziaWG 2.0: `PrivateKey → Address → DNS → MTU → Jc → Jmin → Jmax → S1..S4 → H1..H4 → I1`. | Совпадает с порядком, который принимает UAPI `amneziawg-go`. |
| **I6** | `AllowedIPs` по умолчанию **только IPv4**; IPv6 включается по тумблеру в Настройках (`?ipv6=1`). Регистрация без IPv6-адреса даёт конфиг только по IPv4, даже при `ipv6=1`. | Роутеры (GL.iNet, Keenetic, MikroTik) и мобильные клиенты имеют ограниченную ёмкость таблицы маршрутов; удвоение списка через IPv6 приводит к молчаливым отказам. |
| **I7** | `mobile=1` форсит: `Jc=3, Jmin=64, Jmax=128, MTU=1280`, только IPv4 (перекрывает `ipv6=1`, убирает IPv6 из `Address` и `AllowedIPs`). | Мобильный профиль в пределах спецификации AWG 2.0; снижает расход батареи и молчаливые reset'ы на iOS. |
| **I8** | Если одновременно `mobile=1` и `router=1`, сначала применяется `mobile`, потом `router` через `Math.min`/`Math.max`. На пересечении побеждает `router` (например, итог `Jc = 2`). | Правило композиции реализовано в `applyRouterModeCaps` после `applyMobileModeOverrides`. |
| **I9** | `cps5=1` добавляет `I2`–`I5` для AWG 2.0/3.x при непустом `I1`. | Legacy и режимы AWG без `I1` не должны выдавать неполную CPS-цепочку. |
| **I10** | `vpn://` проходит Qt `qCompress` round-trip, помечает payload как готовый сторонний AWG-профиль и несёт структурные поля, которые AmneziaVPN читает при подключении (`hostName`, числовой `port`, `client_priv_key`, `client_ip`, `server_pub_key`, `allowed_ips`, ключи AWG), а не только текст `.conf`. | AmneziaVPN не должна переводить импорт готового конфига в сценарий установки протокола. |
| **I11** | Lab Auto (`endpointMode=lab`) меняет только `Endpoint`: для того же запроса остальные поля, их порядок и метаданные ответа совпадают с hostname-режимом (ключи, размеры junk и CPS-пакеты случайны в обоих). Без пригодных данных Lab — `503 lab_*` до регистрации WARP и никогда не hostname, в том числе когда все свежие endpoint'ы внутри маршрутов выборочного туннеля (`503 lab_endpoints_in_routes`). | Endpoint Lab выбирается на запрос из пула, проверенного минуты назад; молчаливая подмена на hostname скрыла бы, что запрошенной проверки не было. |
| **I14** | IPv4-часть `AllowedIPs` выборочного туннеля покрывает ровно маршруты выбранных пресетов за вычетом E4 — подсетей WARP endpoint'ов `162.159.192.0/24`, `162.159.193.0/24`, `162.159.195.0/24`, `162.159.204.0/24` — и O4, /32 ручного endpoint'а внутри этих маршрутов, и не содержит больше блоков, чем нужно для этого множества. При `ipv6=1` IPv6-часть — IPv6-маршруты пресетов за вычетом E6 (`2606:4700:d0::/48`, `2606:4700:d1::/48`) и O6, /128 ручного endpoint'а; записи, не задевающие вычитаемое, проходят без изменений, IPv6 не объединяется. Одинаково в режимах hostname и Lab Auto; полный туннель не режется. | Маршрут шире пресетов отправляет через WARP чужой трафик; маршрут к собственному WARP endpoint конфига кладёт endpoint внутрь маршрутов туннеля (заворачивает ли клиент тогда свои пакеты в туннель, не проверено). |
| **I15** | `AllowedIPs` выборочного туннеля никогда не покрывает `Endpoint` конфига: для hostname — через E4/E6 (`engage.cloudflareclient.com` = `162.159.192.1`, `2606:4700:d0::a29f:c001`), для Lab Auto и встроенных endpoint'ов — пропуском кандидатов внутри маршрутов, для ручного endpoint'а — вырезом его /32 (/128). | Собственные пакеты туннеля к его endpoint'у не должны уходить в туннель; в `188.114.96.0/22` есть и endpoint'ы, и обычные сайты, поэтому он не вырезается. |

I12 и I13 зарезервированы за запланированными релизами.

## API

### `GET` / `POST` `/api/warp`

Возвращает JSON: `success`, при успехе `content` (тело `.conf` в **base64**; при `count` > 1 — первый конфиг), `configs` (каждый конфиг со своими `content`, `endpointSource`, CPS-полями и `vpnLink`), `count`, `mode` (`legacy` | `awg2` | `awg3` | `awg31`), опционально route metadata, `appliedExtras`, `vpnLink`, `compatibility` и AWG 3.x-only capability metadata `awg`.

Параметры через query (`GET`) или поля JSON-тела (`POST`). Имена в теле совпадают с query (удобно для длинного `i1`).

| Параметр | Описание |
|---|---|
| `mode` | `legacy` (по умолчанию), `awg2`, `awg3` или `awg31`; AWG 3.x aliases: `3`, `3.0`, `awg30`, `v3`, `3.1`, `v3.1` |
| `count` | `1`–`3` конфига в одном ответе (по умолчанию `1`); каждый — отдельная регистрация WARP |
| `presets` | Ключи пресетов через запятую (или массив в JSON-теле). Старый ключ принимается как его пресет (`rutracker_local` → `rutracker`); снятый ключ (российские сервисы, снятые в 3.2.0) пропускается с `warning`; набор, в котором не осталось пресета с маршрутами, → `400 empty_split_tunnel`; неизвестный ключ → 400 |
| `dns` | Ключ пресета DNS; в UI по умолчанию `cloudflare` |
| `template` | См. [Шаблоны](#шаблоны) |
| `peerEndpoint`, `endpoint` | `IPv4:порт` или `[IPv6]:порт` для `Endpoint`, как есть. Значение такой формы с недопустимым адресом или портом вне 1–65535 → `400 peer_endpoint_invalid` до регистрации; другое значение игнорируется. Если адрес внутри маршрутов выборочного туннеля, его /32 (/128 при `ipv6=1`) исключается из `AllowedIPs`, а в `warning` добавляется `Endpoint override inside routes: <адрес>` (I15) |
| `warpPort` | UDP-порт для `engage…` или IP-fallback; один из **2408, 500, 4500, 1701, 880, 8854**, иначе HTTP 400 (для WARP-шаблонов по умолчанию **4500**; для классического wgcf часто **2408**) |
| `endpointMode` | `hostname` (по умолчанию, поведение не меняется) или `lab` — Lab Auto: каждый конфиг получает отдельный свежий ACTIVE endpoint Endpoint Lab. Запрошенный порт — предпочтение: Lab проверяет 2408/500/1701/4500, нехватка на этом порту добирается другими проверенными портами с предупреждением. Разных endpoint'ов меньше, чем `count` → меньше конфигов и предупреждение, без повторов. Только для WARP-шаблонов; несовместим с `peerEndpoint`. |
| `persistentKeepalive`, `keepalive` | Для старых режимов integer; для AWG 3.x строгий integer или `min-max` (default `25-35`) |
| `rekeyAfterTime`, `rekeyTimeout`, `rejectAfterTime`, `keepaliveTimeout`, `maxHandshakeAttempts` | Строгие AWG 3.x integer/range overrides; defaults: `100-120`, `3-7`, `150-180`, `5-15`, `15-20` |
| `contentPaddingAddition` | Padding внутри шифрованного AWG 3.x payload; default `10-100`; `off`, `0` или `0-0` отключает; допустим строгий integer/range `0..65535` |
| `experimentalContentPadding` | Deprecated-флаг совместимости; `true` по-прежнему принимается, но padding теперь управляется напрямую через `contentPaddingAddition` |
| `disableCookies` | Строгий AWG 3.1-only toggle `on/off` (также `true/false/1/0`); по умолчанию не пишется, включается по запросу (AmneziaWG iOS/macOS до v3.1.3 отвергают ключ) |
| `i1` … `i5` | Свои CPS-цепочки для `I1`–`I5` (query или JSON-тело POST). Теги `<b 0x…>`, `<r N>`, `<rd N>`, `<rc N>`, `<t>`; N 1–1000, один `<t>` на поле, до 1472 байт в пакете. Проверяет `public/static/cps-chain.js` (тот же разбор, что у редактора в интерфейсе), в конфиг идёт канонический вид; некорректная цепочка — HTTP 400 `cps_chain_invalid` с `field` до регистрации WARP. Своя `I2`–`I5` заменяет это поле шаблона `cps5`; без `cps5` пишутся только заданные поля. `I2`–`I5` по-прежнему требуют `I1` и режим AWG 2.0/3.x и не должны оставлять пропуск (`I3` без `I2` и без `cps5` — HTTP 400 `cps_chain_gap`: amneziawg-go до v0.2.16 отвергает такой конфиг). |
| `cpsCompat` | `all` — только `<b>`/`<r>`/`<t>` (все клиенты с I1–I5, amneziawg-go v0.2.13+); `modern` (по умолчанию) — ещё `<rd>`/`<rc>` (v0.2.15+). |
| `i1Ref` | Имя файла из `src/server/cps-presets/` |
| `cps` | `auto` (только стабильные `static` / `sip` / `stun`) либо явный `static`, `sip`, `stun`, `quic`, `dns`, `dtls`; последние три экспериментальны. `tls` и неизвестные идентификаторы возвращают HTTP 400. |
| `plainAddress` | `1` / `true` — в `Address` без `/32` и `/128` |
| `ipv6` | `1` — добавить и IPv6 CIDR пресетов (без /48 WARP endpoint'ов, см. I14) |
| `cps5` | `1` — добавить CPS-цепочки `I2`..`I5` в `[Interface]` (для `mode=awg2`, `awg3`, `awg31`; требует непустой `I1`) |
| `mobile` | `1` — мобильный профиль (см. I7) |
| `router` | `1` — профиль с router-капами |
| `link` | `1` — добавить в JSON-ответ поле `vpnLink: "vpn://..."` для импорта в AmneziaVPN одним тапом |

Ошибки: JSON `{ success: false, message }`; коды 4xx/5xx по ситуации.

Отказ регистрации Cloudflare WARP отвечает по классу: фиксированный `message`, в котором нет ничего из ответа Cloudflare, и без поля `error` (с 3.1.8):

| Исход у Cloudflare | HTTP | `Retry-After` |
|---|---|---|
| 429 (после повторов) | 429 | значение Cloudflare, если это целое 1–3600, иначе 60 |
| 408, 500, 502–504 и прочие 5xx, кроме 501; сетевой сбой; таймаут (20 с) | 503 | 60 |
| 3xx, 4xx, кроме 408 и 429, 501 | 502 | — |
| 2xx не JSON, без `id`/`token`/пиров или с непригодным IPv4-адресом; ответ больше 2 МБ | 502 | — |

Сетевые ошибки `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `EPIPE`, «socket hang up», таймауты и ответы 429 / 502 / 503 / 504 повторяются (всего три попытки); другой сетевой код (например, `EHOSTUNREACH`) и любой другой исход — одна попытка. Собственный лимит запросов остаётся `429` с `Retry-After` и сообщением «Слишком много запросов. Попробуйте позже.»

Регистрация без пригодного IPv6-адреса больше не даёт ошибку: конфиг строится только по IPv4 (как при `ipv6=0`, даже если запрошен `ipv6=1`), а в `warning` добавляется `WARP registration returned no IPv6 address for config(s) N: the config is IPv4-only.` При `mobile=1` конфиг и так только IPv4, такого предупреждения нет.

Маршруты выборочного туннеля (`presets`) разрешаются один раз на запрос и до регистрации WARP, а все конфиги запроса с `count` > 1 получают один и тот же список. С 3.2.0 пресеты каталога берут сети из `src/server/ipCatalog/snapshot.json` без сетевых запросов; переходный пресет спрашивает iplist.opencck.org и свои списки itdoginfo отдельным вызовом и, если тот не дал ни одной IPv4-сети, берёт запас из снапшота, а в `warning` добавляется `Route source fallback: <ключи>`. Подстановки antifilter из прежних версий больше нет. Снятый пресет пропускается (`Presets retired: <ключи>`), пресет без данных тоже (`Presets without data: <ключи>`); набор, в котором не осталось пресета с маршрутами, получает `400 empty_split_tunnel` до Lab Auto и регистрации, с `routeMode` и без него. Из IPv4-маршрутов исключаются подсети WARP endpoint'ов `162.159.192.0/24`, `162.159.193.0/24`, `162.159.195.0/24`, `162.159.204.0/24`, одинаково в режимах hostname и Lab Auto, а остальное объединяется в наименьшее число выровненных блоков с тем же множеством адресов (I14); при `ipv6=1` из IPv6-маршрутов исключаются `2606:4700:d0::/48` и `2606:4700:d1::/48`. Список, в котором после выреза ничего не осталось, даёт `502` («Сервис списков IP вернул пустой ответ…»). `188.114.96.0/22`, где тоже есть WARP endpoint'ы, делят с ним обычные сайты, и он не вырезается; вместо этого выбор `Endpoint` пропускает кандидатов, которых покрывают маршруты, — у Lab Auto и у встроенных endpoint'ов шаблонов `awg2_random` и `awg2_dpi` (I15). Полный туннель остаётся `0.0.0.0/0` (`::/0` при `ipv6=1`). Если в `AllowedIPs` больше 1000 IPv4-маршрутов, конфиг всё равно выдаётся, а в `warning` добавляется `Route budget: N IPv4 routes in AllowedIPs (M in the source lists) is above the limit of 1000; …`; отказа нет. Если снапшот каталога прочитать нельзя, выборочный запрос получает `503` с фиксированным текстом до регистрации; полный туннель его не читает. Интерфейс считает `routes4` из `/api/iplist` — IPv4-строки конфига: предупреждение с 800, невыбранные плитки отключаются на 1000, превышение — выше 1000. Двух вырезов, сделанных при запросе, он не знает: IPv4-фильтра регистрации без IPv6 и выреза ручного endpoint'а.

Lab Auto добавляет `endpointSource: "lab"` каждому конфигу и `lab: { requested, selected, requestedPort, portMatched, ports }`. Его отказы — `{ success: false, error, message }`: `400 invalid_endpoint_mode`, `400 endpoint_mode_conflict` (вместе с `peerEndpoint`), `400 lab_template_unsupported` (шаблон не для WARP); `503 lab_unavailable` (данных Lab нет, они непригодны или Lab сам сообщает о недоступности), `503 lab_stale`, `503 lab_no_endpoints`, `503 lab_endpoints_in_routes` (все свежие endpoint'ы внутри маршрутов выборочного туннеля) с `Retry-After: 60`. Порядок: готовность Lab (Lab без пригодных данных отвечает сразу, до списков маршрутов), маршруты, выбор, пропускающий endpoint'ы внутри маршрутов, регистрация. Свежесть решает выбор, один раз и до регистрации; дальше запрос использует именно эти endpoint'ы.

### `GET` `/api/iplist`

Без `?presets=...`: каталог — `presets` (у каждого `id`, `label`, `category`, `sitesCount` = число доменов и из снапшота `routes4`, `precision` = `exact` | `approx` | `wide`, `noData`, `source` = `catalog` | `live`; у переходного пресета `routes4` — число строк его живых списков на момент сборки), `categories` (порядок блоков), `groupRfPopular` (быстрый выбор), `aliases`, `retired`, `catalogBuiltAt`, `dnsPresets`, `dnsDefault`.

С `?presets=key1,key2` (и `ipv6=1`): `{ presets, sites, sitesQueried, count, count4, count6, cidrs, cidrSource, routes4, routes6, presetStatus, warnings, catalogBuiltAt }`. `cidrs`, `count4`, `count6` и `count` сохраняют смысл: сырое объединение источников без выреза и без объединения между пресетами (с 3.2.0 IPv4-часть остаётся в `cidrs` при `ipv6=1`, а `count6` считает только IPv6-записи). `routes4` и `routes6` — то, что попадёт в конфиг после выреза подсетей WARP endpoint'ов и точного объединения. `cidrSource` — `catalog`, если в наборе нет переходных пресетов или все они ушли на запас, иначе источник живой части (`opencck`, `community`, `mixed`). `presetStatus` даёт по ключу `source` (`catalog`, `live`, `catalog-fallback`, `retired`, `noData`) с `routes4` и `precision`. Только снятые или только пресеты без данных → 200 с нулём маршрутов и `warnings`; после выреза ничего не осталось → 200 с `routes4: 0` и `Empty after endpoint cut`; неизвестные ключи → 400 со списком отсутствующих; снапшот каталога прочитать нельзя → 503.

### `GET` `/api/lab`

Данные Endpoint Lab для `/lab`, только чтение: эндпоинт ничем в Lab не управляет. Без параметров — обзор (`status`, `generatedAt`, `freshness`, события и `endpoints` с публичными состояниями `ACTIVE`, `VERIFIED`, `SUSPECT`). С `?endpoint=<ip:port>&range=24h|7d|30d|all` (по умолчанию `all`) — история одного endpoint'а.

Ошибки — `{ success: false, code }`: `400 endpoint_invalid`, `400 range_invalid`, `404 endpoint_not_found`, `405 method_not_allowed`; `503 lab_not_available`, если публичных файлов Lab нет (Vercel, форки, Lab не смонтирован), и `503 lab_malformed`, если они не прошли проверку, оба с `Retry-After`. Ответы идут с `Cache-Control: no-store` и `X-Robots-Tag: noindex, nofollow`.

### `GET` `/api/status`

Сводка реестра endpoint'ов для карточки «Статус системы»: `status`, `updated_at`, `active_endpoints`, по портам `ports` и `candidates` (только количества, без IP), `health_source`, `message` и `lab: { available }` — есть ли данные Endpoint Lab.

### `GET` `/api/healthcheck`

TCP-доступность `api.cloudflareclient.com:443`, `engage.cloudflareclient.com:443` и `iplist.opencck.org:443` (его читают переходные пресеты при запросе): `{ services: { api, engage, cidr }, checkedAt, catalogBuiltAt }`, где `catalogBuiltAt` — время сборки снапшота каталога (null, если его нельзя прочитать). Результат проб кэшируется на 30 секунд.

## Шаблоны

| Значение | Поведение |
|---|---|
| *(нет)* + `mode=legacy` | Как `warp_amnezia` |
| *(нет)* + `mode=awg2` | Как `warp_amnezia_awg2` |
| *(нет)* + `mode=awg3` / `mode=awg31` | WARP-safe профиль AWG 3.0 / 3.1 |
| `warp_amnezia`, `amnezia`, `amnezia_warp` | Legacy WARP с engage-хостом, встроенный `I1` при отсутствии пользовательского, `plainAddress`, keepalive 25 |
| `warp_amnezia_awg2`, `amnezia_awg2`, `awg2_amnezia`, `warp_awg2_amnezia` | AWG 2.0 WARP — те же peer/DNS/Address/I1 что и Legacy WARP, с WARP-safe S=0 / H=1..4 / MTU=1280 |
| `warp_amnezia_awg3`, `warp_awg3_amnezia` | AWG 3.0 WARP-safe профиль |
| `warp_amnezia_awg31`, `warp_awg31_amnezia` | AWG 3.1 WARP-safe профиль с явными безопасными 3.1-флагами |
| `wgcf` | `engage.cloudflareclient.com`, UDP 4500, без встроенного I1 |
| `awg2_random`, `awg2_dpi` | Случайные H-полосы — **НЕ** для Cloudflare WARP; свой endpoint задаёте сами |

## Опциональные расширения

### Статус CPS-протоколов

| Протокол | Статус | Auto | Примечание |
|---|---|---:|---|
| Static | stable | да | Проверенный проектный пул WARP payload |
| SIP | stable | да | Согласованный рандомизированный SIP INVITE |
| STUN | stable | да | Binding Request с корректным FINGERPRINT |
| QUIC | experimental | нет | Защищённый пакет в форме QUIC v1 Initial; interop не подтверждён |
| DNS | experimental | нет | Пакет в форме DNS response; interop не подтверждён |
| DTLS | experimental | нет | Пакет в форме DTLS 1.2 ClientHello; interop не подтверждён |
| TLS | unsupported | нет | Отклоняется с HTTP 400 |

| Параметр | Эффект |
|---|---|
| `cps5=1` | Когда `mode` — `awg2`, `awg3` или `awg31` и `I1` непустой, сервер добавляет в `[Interface]` `I2..I5`: четыре цепочки разной формы из `<b 0x…>`, `<r N>` и `<t>` (примерно 50–150 байт каждая). Байты `<r>` и `<t>` клиент генерирует при каждой отправке handshake initiation, поэтому пакеты одного конфига меняются от handshake к handshake; фиксированы на конфиг только несколько байт `<b>`. `<rc>`/`<rd>` не используются: amneziawg-go до v0.2.15 отвергает их вместе со всей конфигурацией. Аудит источников: [docs/research/cps-runtime-tags-audit.md](docs/research/cps-runtime-tags-audit.md). Для Legacy и пустого `I1` молча игнорируется. |
| `mobile=1` | Мобильный профиль по инварианту **I7**. |
| `router=1` | Router-капы (`Jc≤2`, `Jmin∈[40,64]`, `Jmax∈[Jmin+64,128]`) во всех режимах, включая Legacy; компонуется с `mobile` по инварианту **I8**. |
| `link=1` | В ответе появляется `vpnLink: vpn://<base64url(qCompress(JSON))>` для импорта в AmneziaVPN одним тапом. |

`appliedExtras: { cps5, mobile, customCps }` в ответе сообщает что фактически применилось (`cps5` может быть `false` даже когда запрошено — Legacy-режим его молча игнорирует; `customCps` — поля I1–I5 со своими цепочками, у которых нет evidence-статуса протокола).

Успешный ответ также содержит безопасные метаданные `cpsRequested`, `cpsResolved`, `cpsStability` и дополнительное поле `cpsEvidenceStatus`. При `count=1..3` каждый элемент `configs[]` сообщает собственный результат; Auto разрешается независимо для каждого конфига. QUIC формирует защищённый 1200-байтный пакет в форме QUIC v1 Initial и делит его на соседние fixed-byte CPS-теги без усечения, но остаётся экспериментальным до подтверждения совместимости с WARP. Static/SIP/STUN имеют статус stable и проектное evidence verified; QUIC/DNS/DTLS экспериментальны, TLS не поддерживается, Auto выбирает только stable.

## Совместимость

Начиная с 2.7.0 ответ `/api/warp` содержит опциональное additive-поле `compatibility`
(`recommended` / `experimental` / `notRecommended` / `warnings`). Это только метадата: она не
содержит ключей, текста `.conf` или `vpn://` payload и не меняет существующие поля ответа. После
генерации UI показывает карточку совместимости — куда можно попробовать импортировать профиль.

Модель совместимости — [`src/server/clientCompatibility.js`](src/server/clientCompatibility.js),
функция `getCompatibilityForGeneration({ mode, exportType, mobile, router, link })`.

### AWG 2.0 и Cloudflare WARP

AWG 2.0 означает **параметры клиентской конфигурации**. Cloudflare WARP peer остаётся стандартным
WireGuard peer, поэтому часть параметров для WARP фиксирована намеренно. Выбор AWG 2.0 **не**
означает, что сервер Cloudflare поддерживает AWG 2.0.

### AWG 3.0 / 3.1 и Cloudflare WARP

Cloudflare остаётся стандартным WireGuard peer. Генератор включает клиентские AWG 3.x механизмы: junk/CPS packets, рандомизированные интервалы rekey/handshake/keepalive, диапазон `PersistentKeepalive` и шифрованный `ContentPaddingAddition` (`10-100` по умолчанию; `off`, `0` или `0-0` отключают его). AWG 3.1 пишет `DisableCookies` только по запросу (`disableCookies=on`): параметр подавляет локальную ветку Cookie Reply при нагрузке и ослабляет локальную защиту от DoS, а AmneziaWG iOS/macOS до v3.1.3 ключ отвергают. Клиентский конфиг WARP только инициирует рукопожатия, поэтому на туннель параметр, вероятно, не влияет. `H1..H4` остаются `1..4`, `S1..S4` — нулевыми; Header Protection недоступен, а `RandomTrailers=on` отклоняется: допуск трейлеров Cloudflare не документирован, а механизм зависит от поведения принимающего peer. См. [актуальные протокольные доказательства](docs/protocol-evidence.md); исторические release notes описывают состояние своих выпусков.

Нужен современный AWG 3.x-compatible parser. Для AWG 3.1 рекомендуется AmneziaVPN 5.0.1.5+ или совместимый AWG 3.1 client. Совместимость роутеров зависит от их реализации. `vpn://` для AWG 3.0 намеренно недоступен, потому что исторический `protocol_version` не подтверждён; AWG 3.1 использует подтверждённый envelope `3.1`.

### Export targets

[`src/server/exportTargets.js`](src/server/exportTargets.js) — реестр v0 форматов вывода и их
статусов:

| Target | Статус |
|---|---|
| `.conf` | stable |
| `vpn://` | stable для прежних режимов и AWG 3.1; AWG 3.0 отключён до появления подтверждения protocol mapping |
| QR | experimental |
| sing-box / Mihomo / Clash | experimental |
| Throne | research |
| OpenWrt | documentation |

Experimental и research форматы **не** являются стабильными экспортерами — они помечены честно,
чтобы их не приняли за рабочий путь импорта. Генератор снижает количество ручной настройки, но не
гарантирует работу в любой сети и любом клиенте.

## NPM-скрипты

| Команда | Действие |
|---|---|
| `npm start` | `vercel dev` |
| `npm run lint` | ESLint (`--max-warnings 0`) |
| `npm test` | Все тесты через встроенный `node:test` |
| `npm run test:e2e` | Браузерные тесты в локальном Chrome (`e2e/`) |
| `npm run test:coverage` | Тесты с экспериментальным coverage |
| `npm run presets:fallback` | Пересобрать `public/static/presets-fallback.json` из `src/server/routePresets.js` и снапшота каталога |
| `npm run ipcatalog:build` | Пересобрать снапшот каталога `src/server/ipCatalog/snapshot.json` (нужна сеть; `-- --report <файл>` пишет сводку сборки); перед каждым релизом |
| `npm run ipcatalog:check` | Проверить закоммиченный снапшот без сети (входит и в `npm test`) |
| `npm run evidence:check` | Проверить, что протокольные доказательства (`docs/protocol-evidence.md`) актуальны; `evidence:generate` пересобирает их |
| `npm run release:check` | Согласованность релиза: `package.json`, CHANGELOG, ключи `?v=` у ассетов, упоминания версии в README |
| `npm run indexnow` | Отправить адреса из sitemap в IndexNow (Bing, Яндекс и другие); `--wait-revision <sha>` ждёт выкладки, `--since <commit>` пропускает релизы без изменений, `--dry-run` |
| `npm run seo:en` | Пересобрать английские страницы `public/en/index.html` и `public/en/lab/index.html` из русских и `public/locales/en.json` (`seo:check` проверяет) |
| `npm run assets:build -- <dir>` | Минифицировать и предварительно сжать статические файлы в `<dir>`; Docker-сборка запускает его на копии `public/` |
| `npm run build` | Заглушка (сборка не нужна) |

Запустить один файл тестов: `node --test __tests__/invariant-i1-uppercase.test.js`.

Fallback smoke-покрытие релиза 2.4.1 находится в `__tests__/fallback-smoke.test.js`: генерация без KV, частичная недоступность endpoint-кандидатов, fallback CIDR-источника, источник реестра в `/api/status` и источник маршрутов в `/api/iplist`.

Ручная проверка импорта `vpn://` на iOS: [docs/manual-checks/vpn-link-ios.md](docs/manual-checks/vpn-link-ios.md).

## Участие

См. [CONTRIBUTING.md](./CONTRIBUTING.md). Для security-репортов: [SECURITY.md](./SECURITY.md). Все участники подчиняются [Code of Conduct](./CODE_OF_CONDUCT.md).

## Лицензия

[AGPL-3.0-only](./LICENSE) — © 2026 HereIamGosu.

## Star History

<a href="https://star-history.com/#HereIamGosu/amnezia-config-gen&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=HereIamGosu/amnezia-config-gen&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=HereIamGosu/amnezia-config-gen&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=HereIamGosu/amnezia-config-gen&type=Date" />
 </picture>
</a>

## Контакты

- Discord: <https://discord.gg/sZTgtD7SyB>
- Сайт сервера: <https://valokda.vercel.app/>
