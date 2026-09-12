# 🌐🔧 Генератор конфигурации AmneziaWG

[English](./README.md) | [Русский](./README.ru.md)

Веб-интерфейс и HTTP API для сборки файлов `.conf` под клиент **AmneziaWG** (WireGuard с расширениями Amnezia). Основной сценарий — профиль **Cloudflare WARP**: регистрация через официальный API, выдача ключа и параметров туннеля, опционально сужение `AllowedIPs` по выбранным пресетам доменов.

| | |
| --- | --- |
| **Генератор** | <https://valokda-amnezia.vercel.app/> |
| **Информационная страница** | <https://hereiamgosu.github.io/amnezia-config-gen/> |
| **Telegram-канал** | <https://t.me/amnezia_config> |
| **Исходный код** | <https://github.com/HereIamGosu/amnezia-config-gen> |

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js ≥20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![CI](https://github.com/HereIamGosu/amnezia-config-gen/actions/workflows/ci.yml/badge.svg)](https://github.com/HereIamGosu/amnezia-config-gen/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/HereIamGosu/amnezia-config-gen)](https://github.com/HereIamGosu/amnezia-config-gen/releases/latest)
[![Last Commit](https://img.shields.io/github/last-commit/HereIamGosu/amnezia-config-gen)](https://github.com/HereIamGosu/amnezia-config-gen/commits/main)
[![Open Issues](https://img.shields.io/github/issues/HereIamGosu/amnezia-config-gen)](https://github.com/HereIamGosu/amnezia-config-gen/issues)

![Интерфейс приложения](https://i.imgur.com/xjgNNQX.png)

## Возможности

- Явный выбор режима маршрутизации: полный туннель (весь трафик) или выборочная маршрутизация (только выбранные направления)
- Четыре формата: **Legacy**, **AWG 2.0**, **AWG 3.0** и **AWG 3.1** (`mode=legacy|awg2|awg3|awg31`). Для AWG 3.x применяется WARP-safe клиентский профиль.
- Пресеты маршрутов: тайл-выбор по категориям доменов → агрегированные IPv4 (или IPv4+IPv6) CIDR в `AllowedIPs`. Без выбора по умолчанию используется `0.0.0.0/0`; `::/0` добавляется только при явном включении IPv6.
- Несколько пресетов DNS для строки `DNS` в конфиге.
- Скачивание `.conf` и два шаблона планировщика Windows: `public/static/SchedulerAmnezia-15.bat` (Legacy 1.5 → `AmneziaWarp.conf`) и `SchedulerAmnezia-20.bat` (AWG 2.0 → `AmneziaWarp-AWG2.conf`); путь к `amneziawg.exe` при необходимости правьте в bat.
- После генерации карточка результата объясняет формат AWG, число вариантов, источники endpoint и маршрутов, профили, IPv6, наличие `vpn://`, уровни риска и первые шаги диагностики.
- Опциональные расширения `cps5`, `mobile`, `link` (см. [Опциональные расширения](#опциональные-расширения)).
- Запросы к Cloudflare WARP API с повторными попытками при сетевых ошибках и ответах 429 / 502 / 503 / 504.

## Telegram-канал

В Telegram-канале **[Amnezia Config](https://t.me/amnezia_config)** публикуются разборы обновлений генератора, диагностика проблем с endpoint, DNS, UDP, AllowedIPs, mobile profile и импортом конфигов.

Канал не обещает универсальную работу конфига в любой сети. Материалы объясняют, как устроены настройки и где искать причину, если подключение ведёт себя по-разному на разных устройствах или сетях.

## Требования

- **Node.js ≥ 20** (LTS).
- **Vercel CLI** для локального запуска серверных функций: `npm i -g vercel` или `npx vercel dev`.

Отдельного `.env` для работы API не требуется — обращение идёт к публичному `api.cloudflareclient.com`.

## Локальный запуск

```bash
npm install
npm start    # vercel dev → http://localhost:3000
```

Если открыть только статические файлы из `public/` без `vercel dev`, интерфейс подгрузит список пресетов из `public/static/presets-fallback.json`, но вызовы `/api/iplist` и `/api/warp` работать не будут.

## Деплой

Проект рассчитан на **Vercel**. Подключите репозиторий в панели Vercel или выполните `vercel` / `vercel --prod` из каталога проекта.

## Privacy-safe telemetry

Продуктовые события отправляются через существующую Yandex.Metrika с помощью no-op-safe adapter `public/static/analytics.js`. Если аналитика недоступна или заблокирована, генерация и остальные действия продолжают работать без ошибок.

События: `generation_started`, `generation_succeeded`, `generation_partially_succeeded`, `generation_failed`, `config_downloaded`, `config_preview_opened`, `vpn_link_copied`, `history_item_previewed`, `history_item_downloaded`, `healthcheck_opened`, `status_modal_opened`.

Разрешены только ограниченные продуктовые метаданные: режим, количества конфигов, категории источников endpoint/маршрутов, предупреждения, full/split, mobile/router, CPS, безопасные boolean-флаги WARP-safe/timing/experimental padding, длительность и категория ошибки. Adapter **не собирает** содержимое `.conf`, ключи, WARP-токены, полные endpoint-строки, `AllowedIPs`, custom CIDR, исходные сообщения ошибок и полный user agent.

## Структура репозитория

| Путь | Назначение |
|---|---|
| `public/index.html` | Точка входа UI |
| `public/static/script.js`, `styles.css` | Логика и стили фронтенда |
| `public/static/presets-fallback.json` | Запасной каталог пресетов без API |
| `api/warp.js` | Эндпоинт генерации WARP-конфига |
| `src/server/awg/` | AWG-профили, строгие ranges, WARP safety и финальная сериализация |
| `api/iplist.js` | Список пресетов и предпросмотр CIDR |
| `api/routePresets.js` | Каталог пресетов и DNS (источник правды) |
| `api/ipListFetch.js` | Получение CIDR по доменам (in-memory кэш 10 мин) |
| `api/warpCpsPayloads.js` | Пул верифицированных WARP-совместимых CPS payload'ов |
| `api/cps-presets/` | Текстовые файлы для query-параметра `i1Ref` |
| `api/cpsExtraPackets.js` | Генерация I2..I5 для `cps5=1` |
| `api/vpnLinkBuilder.js` | Сборка `vpn://...` ссылки для AmneziaVPN |
| `api/_rateLimit.js` | Per-IP rate-limit (10 генераций/мин) |
| `scripts/dump-presets-fallback.js` | Пересборка `presets-fallback.json` из `routePresets.js` |
| `__tests__/invariant-*.test.js` | Регрессионные тесты на критические инварианты |

## Критические инварианты

Эти правила нетривиальны, легко нарушить, и сломанный туннель проявляется молча. Они закреплены в `__tests__/invariant-*.test.js`. **При изменении любого инварианта обновляйте и тест, и этот блок.**

| ID | Правило | Почему |
|---|---|---|
| **I1** | Строка в `[Interface]` ОБЯЗАНА быть **uppercase** `I1`, не `i1`. | Lowercase `i1` молча игнорируется AmneziaWG-клиентом для Windows. Источник: [wg-easy/wg-easy#2439](https://github.com/wg-easy/wg-easy/issues/2439). |
| **I2** | Во всех WARP-safe профилях AWG 2/3.x: `S1 = S2 = S3 = S4 = 0`. | Cloudflare — стандартный WireGuard peer и не добавляет AWG-префиксы. |
| **I3** | Во всех WARP-safe профилях AWG 2/3.x: `H1..H4 = 1, 2, 3, 4`. | Cloudflare ожидает стандартные WireGuard message types. |
| **I4** | WARP-safe профили используют `MTU = 1280`; AWG 3.x не выводит `HeaderProtectionKey` и не включает `RandomTrailers`/`DisableCookies`. | Peer-dependent wire-format несовместим со стандартным Cloudflare peer. |
| **I5** | Порядок полей в `[Interface]` для AmneziaWG 2.0: `PrivateKey → Address → DNS → MTU → Jc → Jmin → Jmax → S1..S4 → H1..H4 → I1`. | Совпадает с порядком, который принимает UAPI `amneziawg-go`. |
| **I6** | `AllowedIPs` по умолчанию **только IPv4**; IPv6 включается по тумблеру в Настройках (`?ipv6=1`). | Роутеры (GL.iNet, Keenetic, MikroTik) и мобильные клиенты имеют ограниченную ёмкость таблицы маршрутов; удвоение списка через IPv6 приводит к молчаливым отказам. |
| **I7** | `mobile=1` форсит: `Jc=3, Jmin=64, Jmax=128, MTU=1280`, только IPv4 (перекрывает `ipv6=1`, убирает IPv6 из `Address` и `AllowedIPs`). | Мобильный профиль в пределах спецификации AWG 2.0; снижает расход батареи и молчаливые reset'ы на iOS. |
| **I8** | Если одновременно `mobile=1` и `router=1`, сначала применяется `mobile`, потом `router` через `Math.min`/`Math.max`. На пересечении побеждает `router` (например, итог `Jc = 2`). | Правило композиции реализовано в `applyRouterModeCaps` после `applyMobileModeOverrides`. |
| **I9** | `cps5=1` добавляет `I2`–`I5` только для AWG 2.0 при непустом `I1`. | Legacy и AWG 2.0 без `I1` не должны выдавать неполную CPS-цепочку. |
| **I10** | `vpn://` проходит Qt `qCompress` round-trip и помечает payload как готовый сторонний AWG-профиль. | AmneziaVPN не должна переводить импорт готового конфига в сценарий установки протокола. |

## API

### `GET` / `POST` `/api/warp`

Возвращает JSON: `success`, при успехе `content` (тело `.conf` в **base64**), `mode` (`legacy` | `awg2` | `awg3` | `awg31`), опционально route metadata, `appliedExtras`, `vpnLink`, `compatibility` и AWG 3.x-only capability metadata `awg`.

Параметры через query (`GET`) или поля JSON-тела (`POST`). Имена в теле совпадают с query (удобно для длинного `i1`).

| Параметр | Описание |
|---|---|
| `mode` | `legacy` (по умолчанию), `awg2`, `awg3` или `awg31`; AWG 3.x aliases: `3`, `3.0`, `awg30`, `v3`, `3.1`, `v3.1` |
| `presets` | Ключи пресетов через запятую (или массив в JSON-теле) |
| `dns` | Ключ пресета DNS; в UI по умолчанию `cloudflare` |
| `template` | См. [Шаблоны](#шаблоны) |
| `peerEndpoint`, `endpoint` | Полная строка `host:port` для `Endpoint` (если задана — используется как есть) |
| `warpPort` | UDP-порт для `engage…` или IP-fallback (для WARP-шаблонов по умолчанию **4500**; для классического wgcf часто **2408**) |
| `persistentKeepalive`, `keepalive` | Для старых режимов integer; для AWG 3.x строгий integer или `min-max` (default `25-35`) |
| `rekeyAfterTime`, `rekeyTimeout`, `rejectAfterTime`, `keepaliveTimeout`, `maxHandshakeAttempts` | Строгие AWG 3.x integer/range overrides; defaults: `100-120`, `3-7`, `150-180`, `5-15`, `15-20` |
| `experimentalContentPadding`, `contentPaddingAddition` | API-only AWG 3.x эксперимент: opt-in обязателен, default `10-100`, в ответ добавляется warning о совместимости |
| `i1` | Сырая строка CPS / obfuscation (AWG 2.0) |
| `i1Ref` | Имя файла из `api/cps-presets/` |
| `plainAddress` | `1` / `true` — в `Address` без `/32` и `/128` |
| `ipv6` | `1` — также включить IPv6 CIDR из пресетов |
| `cps5` | `1` — добавить случайные `I2`..`I5` в `[Interface]` (только `mode=awg2`, требует непустой `I1`) |
| `mobile` | `1` — мобильный профиль (см. I7) |
| `router` | `1` — профиль с router-капами |
| `link` | `1` — добавить в JSON-ответ поле `vpnLink: "vpn://..."` для импорта в AmneziaVPN одним тапом |

Ошибки: JSON `{ success: false, message }`; коды 4xx/5xx по ситуации.

### `GET` `/api/iplist`

Без `?presets=...`: возвращает каталог пресетов целиком (`presets`, категории, `dnsPresets`, `dnsDefault` и т.д.).

С `?presets=key1,key2`: разрешение доменов в CIDR. Ответ: `{ count, count4, count6, cidrs, sites, sitesQueried, cidrSource }`. `cidrSource` сообщает фактический источник маршрутов (`opencck`, `community`, `mixed`, `antifilter` или `static`). Неизвестные ключи → 400 со списком отсутствующих.

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

| Параметр | Эффект |
|---|---|
| `cps5=1` | Когда `mode=awg2` и `I1` непустой, сервер добавляет `I2..I5` (случайный hex 16–64 байт через `crypto.randomBytes`) в `[Interface]`. Для Legacy и пустого `I1` молча игнорируется. |
| `mobile=1` | Мобильный профиль по инварианту **I7**. |
| `router=1` | Router-капы (`Jc≤2`, `Jmin∈[40,128]`, `Jmax∈[Jmin+1,128]`); компонуется с `mobile` по инварианту **I8**. |
| `link=1` | В ответе появляется `vpnLink: vpn://<base64url(qCompress(JSON))>` для импорта в AmneziaVPN одним тапом. |

`appliedExtras: { cps5, mobile }` в ответе сообщает что фактически применилось (`cps5` может быть `false` даже когда запрошено — Legacy-режим его молча игнорирует).

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

Cloudflare остаётся стандартным WireGuard peer. Генератор включает только клиентские AWG 3.x механизмы, не требующие поддержки peer: junk/CPS packets, randomized rekey/handshake/keepalive timing и диапазон `PersistentKeepalive`. `H1..H4` остаются `1..4`, `S1..S4` — нулевыми; Header Protection недоступен, RandomTrailers нельзя включить. `ContentPaddingAddition` доступен только через API как эксперимент, выключен по умолчанию и может ухудшить совместимость.

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
| `npm run test:coverage` | Тесты с экспериментальным coverage |
| `npm run presets:fallback` | Пересобрать `public/static/presets-fallback.json` из `api/routePresets.js` |
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

- Discord: <https://discord.gg/XGNtYyGbmM>
- Сайт сервера: <https://valokda.vercel.app/>
