# 🌐🔧Генератор конфигурации AmneziaWG

Веб-интерфейс и HTTP API для сборки файлов `.conf` под клиент **AmneziaWG** (WireGuard с расширениями Amnezia). Основной сценарий — профиль **Cloudflare WARP**: регистрация через официальный API, выдача ключа и параметров туннеля, опционально сужение `AllowedIPs` по выбранным пресетам доменов.

Публичный инстанс: [valokda-amnezia.vercel.app](https://valokda-amnezia.vercel.app/).

![Интерфейс приложения](https://i.imgur.com/xjgNNQX.png)

## Возможности

- Два формата конфига: **Legacy** (`mode=legacy`) и **AmneziaWG 2.0** (`mode=awg2`).
- Пресеты маршрутов: наборы доменов → агрегированные IPv4/IPv6 CIDR в `AllowedIPs`; без выбора — `0.0.0.0/0`, `::/0`.
- Несколько пресетов DNS для строки `DNS` в конфиге.
- Скачивание `.conf` и вспомогательного `SchedulerAmnezia.bat` (Windows, автозапуск через планировщик; путь к конфигу внутри bat нужно проверить под свою установку).
- Запросы к Cloudflare WARP API с повторными попытками при сетевых ошибках и ответах 429 / 502 / 503 / 504.

## Требования

- **Node.js** (LTS достаточно).
- **Vercel CLI** для локального запуска серверных функций: `npm i -g vercel` или использование `npx vercel dev`.

Отдельного `.env` для работы API не требуется: обращение идёт к публичному `api.cloudflareclient.com`.

## Локальный запуск

```bash
npm install
npm start
```

`npm start` вызывает `vercel dev`: поднимаются маршруты из `vercel.json` (`/api/*` → функции в `api/`, статика из `public/`).

Открыть в браузере корень сайта (порт покажет CLI, обычно `http://localhost:3000`).

Если открыть только статические файлы из `public/` без `vercel dev`, интерфейс подгрузит список пресетов из `public/static/presets-fallback.json`, но вызовы `/api/iplist` и `/api/warp` работать не будут.

## Деплой

Проект рассчитан на **Vercel**: в корне `vercel.json` (сборка `@vercel/node` для `api/**/*.js`, `@vercel/static` для `public/**/*`, переписывание `/api/(.*)` на `/api/$1.js`).

Подключите репозиторий в панели Vercel или выполните `vercel` / `vercel --prod` из каталога проекта.

## Структура репозитория

| Путь | Назначение |
|------|------------|
| `public/index.html` | Точка входа UI |
| `public/static/script.js`, `styles.css` | Логика и стили |
| `public/static/presets-fallback.json` | Запасной каталог пресетов без API |
| `api/warp.js` | Генерация WARP-конфига |
| `api/iplist.js` | Список пресетов и предпросмотр CIDR |
| `api/routePresets.js` | Каталог пресетов и DNS |
| `api/ipListFetch.js` | Получение CIDR по доменам |
| `api/warpAmneziaCpsPayload.js` | Встроенная цепочка для поля obfuscation (шаблоны `warp_amnezia*`) |
| `api/cps-presets/` | Текстовые файлы для `i1Ref` |
| `scripts/dump-presets-fallback.js` | Обновление `presets-fallback.json` из `routePresets.js` |
| `SchedulerAmnezia.bat` | Шаблон планировщика Windows |

## API

### `GET` / `POST` `/api/warp`

Возвращает JSON: `success`, при успехе — `content` (тело `.conf` в **base64**), `mode` (`legacy` | `awg2`), опционально `routesSource`, `routesPresets`, `presetSitesCount`.

Параметры задаются query-строкой (`GET`) или полями JSON-тела (`POST`). Имена в теле совместимы с query (удобно для длинного `i1`).

| Параметр | Описание |
|----------|----------|
| `mode` | `legacy` (по умолчанию) или `awg2` (алиасы: `2`, `v2`; также query `awg`) |
| `presets` | Ключи пресетов через запятую или массив в JSON |
| `dns` | Ключ пресета DNS; по умолчанию как в UI — cloudflare |
| `template` | См. раздел «Шаблоны» |
| `peerEndpoint`, `endpoint` | Полная строка `хост:порт` для `Endpoint` (если задана — используется как есть) |
| `warpPort` | Порт UDP для `engage…` или IP-fallback (по умолчанию для WARP-шаблонов **4500**; для классического wgcf часто **2408**) |
| `persistentKeepalive`, `keepalive` | Например `25`; `0` — строка keepalive не пишется |
| `i1` | Сырая строка для CPS / obfuscation (AWG 2.0) |
| `i1Ref` | Имя файла из `api/cps-presets/` |
| `plainAddress` | `1` / `true` — в `Address` без `/32` и `/128` |

Ошибки: JSON с `success: false`, `message`; коды 4xx/5xx по ситуации.

### `GET` `/api/iplist`

Без query-параметра `presets`: ответ со списком пресетов (`presets`, категории, `dnsPresets`, `dnsDefault` и т.д.).

С `?presets=key1,key2`: разрешение доменов, затем `cidrs`, `sites`, счётчики. Неизвестные ключи — `400` с перечислением.

## Шаблоны (`template`)

| Значение | Назначение |
|----------|------------|
| *(нет)* + `mode=legacy` | Как `warp_amnezia` |
| *(нет)* + `mode=awg2` | Как `warp_amnezia_awg2` |
| `warp_amnezia`, `amnezia`, `amnezia_warp` | Legacy, engage-хост, встроенный I1 при отсутствии `i1`/`i1Ref`, `plainAddress`, keepalive 25 |
| `warp_amnezia_awg2`, … | То же для peer/DNS/Address/i1, формат AWG 2.0, H1–H4 фиксированы 1..4 (совместимость с пиром Cloudflare) |
| `wgcf` | `engage.cloudflareclient.com`, UDP **4500** (как в экспорте Amnezia 1.5 здесь), без встроенного I1 |
| `awg2_random`, `awg2_dpi` | Случайные полосы H — **не** для WARP Cloudflare; свой endpoint задаёте сами |

Поле **I1** / цепочка obfuscation в ответ Cloudflare не входит; источники: `i1`, `i1Ref` или встроенный payload для шаблонов `warp_amnezia*`.

## Endpoint и порты

- Если в JSON регистрации есть данные пира — приоритет у них (хост/порт), пока не переопределено `peerEndpoint` / `endpoint`.
- Для шаблонов **`warp_amnezia`*** и **`wgcf`** по умолчанию фиксированно **`engage.cloudflareclient.com:4500`** (без ротации портов), как в типичном рабочем конфиге Amnezia 1.5. Нужен **2408** (как у чистого wgcf) — задайте **`warpPort=2408`**.
- Если хост берётся из запасных IP (редкий случай), порт WireGuard по умолчанию **4500** (не путать с HTTPS **443** к API регистрации).

### Симптомы «нет интернета» / «подключился, сайты не грузятся»

При **`AllowedIPs = 0.0.0.0/0`** весь трафик идёт в туннель. Если handshake не установился (неверный порт, блокировка UDP, несовместимый клиент), на Windows AmneziaWG может сработать **kill-switch** — сеть «пропадает» до отключения туннеля. На мобильных похожий эффект при полном туннеле и неработающем DNS через туннель. Сужение маршрутов (пресеты доменов в UI/API) снижает риск. Убедитесь, что в конфиге есть строка **`Endpoint = …:порт`** и клиент поддерживает выбранный режим (Legacy vs AWG 2.0).

## Ограничения AWG 2.0 для WARP

Пир Cloudflare — **обычный WireGuard**: он не добавляет префиксы **S1–S4** к пакетам. Клиент AmneziaWG при ненулевых **S2/S3/S4** на приёме снимает лишние байты с входящих пакетов (cookie reply, transport и т.д.), поэтому конфиг с ненулевыми **S3/S4** против stock-пира **ломает туннель**. В шаблоне **`warp_amnezia_awg2`** поэтому **S1 = S2 = S3 = S4 = 0**, **H1–H4 = 1..4**, **MTU = 1280** (как у legacy WARP в этом проекте). **Jc/Jmin/Jmax** остаются в допустимых для AWG 2.0 диапазонах (Jc 1–10, Jmin/Jmax 64–1024) — это только UDP-шум до handshake; опционально **i1** (CPS) перед Init. В секции `[Interface]` для AWG 2.0 используется ключ **`i1`**, не `I1`.

Для **self-hosted** пира AmneziaWG (шаблоны `awg2_random` / `awg2_dpi`, не WARP) **S1–S4** и диапазоны **H1–H4** генерируются полностью по правилам 2.0; **MTU** = **max(1280, 1420 − S4)**.

Для любого ответа с `mode=awg2` порядок полей в `[Interface]`: **PrivateKey**, **Address**, **DNS**, **MTU**, затем **Jc, Jmin, Jmax**, **S1–S4**, **H1–H4**, при необходимости **i1** (порядок как в UAPI amneziawg-go: `jc`…`i1`).

## Скрипты npm

| Команда | Действие |
|---------|----------|
| `npm start` | `vercel dev` |
| `npm run build` | Заглушка (сборка фронта не требуется) |
| `npm run presets:fallback` | Пересобрать `public/static/presets-fallback.json` после правок `api/routePresets.js` |
| `npm run lint` | `eslint .` (в монорепозитории с лишними каталогами может затронуть не только проект) |

Для проверки одного файла: `npx eslint api/warp.js`.

## Участие

1. Форк репозитория.
2. Ветка: `git checkout -b feature/краткое-описание`.
3. Коммиты и push в форк.
4. Pull request в основной репозиторий.

## Контакты

- Discord: [сервер](https://discord.gg/XGNtYyGbmM)
- Веб-сайт сервера: [valokda.vercel.app](https://valokda.vercel.app/)

## Star History

<a href="https://star-history.com/#HereIamGosu/amnezia-config-gen&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=HereIamGosu/amnezia-config-gen&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=HereIamGosu/amnezia-config-gen&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=HereIamGosu/amnezia-config-gen&type=Date" />
 </picture>
</a>
