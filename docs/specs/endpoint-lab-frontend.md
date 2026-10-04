# Endpoint Lab — публичная страница и публичный контракт v1

Страница `/lab` (`/en/lab`) показывает состояние пула проверенных endpoint'ов Cloudflare WARP. Только чтение:
операторских действий (обновить, перепроверить, исключить, discovery, сброс identity) нет ни на странице, ни в API.
Страница появляется раньше, чем генератор начнёт брать адреса из Lab (Phase D): генератор работает по своей
текущей стратегии, shadow-режим EndpointProvider не меняется.

## Граница данных

```text
lab.db (хост Lab, root)                       ← сайт к нему доступа не имеет
  ↓ endpoint_lab.export_web(), после COMMIT в publish()
/var/lib/amnezia-endpoint-lab/public/          ← только безопасные файлы
  active-pool.json   (schema 2, провайдер генератора — не меняется)
  lab-status.json    (schema 1, мониторинг — не меняется)
  web-overview.json  (контракт v1, сводка)
  web-endpoints/<sha256(endpoint_id)[:32]>.json  (детали endpoint'а)
  ↓ read-only bind mount deploy controller'а: /run/endpoint-lab
api/lab.js + src/server/labPublic.js           ← читает, проверяет, проецирует на контракт; БД не видит
  ↓ GET /api/lab, GET /api/lab?endpoint=<id>&range=<r>   (same-origin, no-store)
public/lab/lab-data.js → lab-core.js (проверка) → lab.js (отрисовка)
```

Бизнес-метрики считает только экспортёр Lab (Python, там есть БД). Node ничего не агрегирует: читает файл с
лимитом размера, проверяет каркас, пропускает только известные поля, отбрасывает negative control. Браузер
проверяет ответ ещё раз (`LabCore.normalizeOverview` / `normalizeEndpointDetails`). Одна схема — контракт v1;
схема БД и схема `active-pool.json` наружу не выходят.

Путь к каталогу: `/run/endpoint-lab`, для локального запуска и тестов — `ENDPOINT_LAB_PUBLIC_DIR` (абсолютный
путь, окружение процесса при старте). Запрос путь не выбирает никогда; имя файла детали — хеш от проверенного
идентификатора, а в самом файле лежит id, который API сверяет с запросом.

## Файлы

| Файл | Назначение |
|---|---|
| `api/lab.js` | HTTP: GET/HEAD, коды ошибок, `no-store`, `Retry-After` |
| `src/server/labPublic.js` | чтение публичных файлов, проверка, проекция, режим совместимости |
| `public/lab/index.html`, `lab.css` | страница (RU); `public/en/lab/index.html` генерирует `npm run seo:en` |
| `public/lab/lab-core.js` | проверка данных, модель представления, форматирование, состояние Lab; без DOM |
| `public/lab/lab-data.js` | **единственный адаптер данных**: `LAB_API`, запрос, таймаут, коды ошибок, опрос |
| `public/lab/lab.js` | отрисовка, тикер «… назад», URL-состояние `?endpoint=` |
| `public/lab/lab-quick.js` | окно быстрого просмотра для страницы генератора (пока не подключено) |
| `public/lab/lab-fixtures.js` | демо-данные дизайна и состояний; грузятся только на localhost |
| `__tests__/fixtures/lab-public/` | настоящий вывод экспортёра Lab (см. «Тестовые данные») |

Экспортёр — `deploy/endpoint-lab/endpoint_lab.py` ветки `feat/endpoint-lab` (`WebModel`, `export_web`, тесты
`WebExportTests`).

## Контракт v1: сводка (`GET /api/lab`)

```json
{
  "schemaVersion": 1,
  "status": "ok",
  "generatedAt": "2026-10-04T18:29:40Z",
  "coverage": "full",
  "counts": { "active": 24, "verified": 44, "suspect": 1, "quarantine": 3, "dead": 12 },
  "freshness": { "lastSuccessAt": "…", "oldestActiveVerifiedAt": "…", "activeTtlSec": 420 },
  "sessions": { "firstSession": 0.73, "retryRescued": 0.25, "failed": 0.02, "window": "15m" },
  "activeHistory": [{ "at": "…", "active": 24 }],
  "events": [{ "type": "restored", "endpoint": "162.159.192.18:2408", "at": "…" },
             { "type": "discovery", "count": 3, "at": "…" }],
  "endpoints": [{ "ip": "162.159.192.18", "port": 2408, "state": "ACTIVE", "source": "consumer_official_seed",
                  "lastVerifiedAt": "…", "expiresAt": "…", "session": "first", "https": "ok", "reliability": 0.994 }],
  "retryAfterSec": 60
}
```

Обязательны `schemaVersion`, `status`, `generatedAt`. Публичны только endpoint'ы, у которых `source ≠
negative_control`, адрес вне `192.0.2.0/24` и нет ручного blacklist (`web_publishable`). Время — ISO-8601 UTC.

| Поле | Смысл и формула |
|---|---|
| `status` | `lab_meta.lab_health` в нижнем регистре (`OK`/`DEGRADED`/`UNAVAILABLE`), как в `active-pool.json` |
| `generatedAt` | момент экспорта (часы Lab) |
| `coverage` | `full` — экспортёр; `active-only` — режим совместимости (ниже) |
| `counts.*` | число публичных endpoint'ов в состоянии `ACTIVE`/`VERIFIED`/`SUSPECT`/`QUARANTINE`/`DEAD` по зафиксированному состоянию БД. `active` считает и ACTIVE с истёкшим сроком: страница сама считает свежие по `expiresAt` |
| `freshness.lastSuccessAt` | `max(last_traffic_ok_at)` по публичным endpoint'ам — последняя успешная глубокая проверка |
| `freshness.oldestActiveVerifiedAt` | `min(last_traffic_ok_at)` по eligible ACTIVE (`is_eligible`: ACTIVE, не blacklist, срок не истёк) |
| `freshness.activeTtlSec` | константа Lab `ACTIVE_TTL_S` (сейчас 420) |
| `sessions` | окно 15 минут, наблюдения `traffic` публичных endpoint'ов (без negative control по source и по `192.0.2.0/24`, без blacklist): `firstSession = ok ∧ sessions≠2` (ok без числа сессий считается первой, как в корзинах истории), `retryRescued = ok ∧ sessions=2`, `failed = fail` (сбой, засчитанный endpoint'у), каждая доля делится на их сумму; `samples` — эта сумма. Inconclusive, suppressed и сбои самого Lab не входят — в отличие от `both_sessions_failed` в `lab-status.json`. Нет наблюдений — `null`, а не 0/0/0 |
| `activeHistory` | `run.active_after` за 24 ч (refresh, discovery, manual), по `finished_at`; ≤ 1500 точек, при избытке — равномерное прореживание с сохранением последней |
| `events` | `transition` за 24 ч, ≤ 100, новые первыми; правила ниже |
| `retryAfterSec` | `REFRESH_INTERVAL_S` (60): чаще опрашивать бессмысленно |

Состояния endpoint'а: `ACTIVE`, `VERIFIED`, `SUSPECT`, `QUARANTINE`, `DEAD`, `DISCOVERED`; переходные `PROBING`,
`HANDSHAKE_OK`, `VERIFYING` публикуются как `CHECKING`. Порядок списка: ACTIVE, VERIFIED, SUSPECT, CHECKING,
QUARANTINE, DEAD, DISCOVERED, внутри — по IP и порту; не больше 500.

| Поле endpoint'а | Смысл |
|---|---|
| `lastVerifiedAt` | `last_traffic_ok_at` — последняя успешная глубокая проверка (handshake + TLS-проверенный HTTPS через туннель) |
| `expiresAt` | только у ACTIVE: `expires_at` (= `lastVerifiedAt + ACTIVE_TTL_S`) |
| `session` | по последнему значимому результату глубокой проверки: `first` — traffic ok с первой туннельной сессии, `retry` — ok со второй, `failed` — сбой, засчитанный endpoint'у (traffic fail или failed handshake); `null` — проверок не было или число сессий неизвестно |
| `https` | по тому же результату: `ok` — HTTPS прошёл (для ACTIVE это следует из определения), `fail` — traffic fail, `null` — handshake не удался и HTTPS не пробовали |
| `reliability` | доля успешных значимых глубоких проверок за последний час: `traffic ok / (traffic ok + traffic fail + handshake fail)`; при выборке меньше 3 — `null` |

«Значимый результат» (`WEB_MEANINGFUL_SQL`): наблюдение `traffic` с результатом `ok`/`fail` или `handshake` с
`fail`. Suppressed, inconclusive и `lab_failure` ничего не доказывают про endpoint и не учитываются.

События (`_web_event`):

| Переход | Событие |
|---|---|
| `SUSPECT`/`QUARANTINE`/`DEAD` → `ACTIVE` | `restored` |
| другое → `ACTIVE` | `promoted` |
| → `SUSPECT` | `suspect` |
| `ACTIVE` → `VERIFIED` с причиной `pool_cap` | `demoted` |
| → `QUARANTINE` | `excluded` |
| → `DEAD` | `dead` |
| переходы в ACTIVE внутри завершённого discovery-прогона | одно событие `discovery` с числом адресов |

Причины оператора (`operator`, `unblacklisted`, `unquarantined`, `reimported`) не публикуются, текст причин и
кто их ввёл — тоже.

## Контракт v1: endpoint (`GET /api/lab?endpoint=<id>&range=all|24h|7d|30d`)

`id` — `ip:port` (IPv4) или `[ipv6]:port`; неверный — 400 `endpoint_invalid`, неизвестный диапазон — 400
`range_invalid`, по умолчанию `all`.

```json
{
  "schemaVersion": 1,
  "generatedAt": "…",
  "endpoint": { "…": "как элемент endpoints[]" },
  "checks": { "handshake": { "result": "ok", "at": "…" }, "tunnel": { "result": "ok", "at": "…" },
              "https": { "result": "ok", "at": "…" } },
  "stability": { "h1": 0.992, "h24": 0.988, "observations": 214 },
  "timeline": [{ "at": "…", "state": "ACTIVE" }],
  "lastError": { "code": "traffic_failed", "at": "…" },
  "history": { "range": "24h", "buckets": [{ "at": "…", "first": 5, "retry": 1, "fail": 0 }],
               "events": [{ "at": "…", "result": "fail", "error": "handshake_no_response" }] }
}
```

| Поле | Смысл |
|---|---|
| `checks` | последняя значимая глубокая проверка: `handshake` — её результат; `tunnel` — `ok` только если через туннель прошёл HTTPS, иначе `null` (отдельно Lab туннель не проверяет); `https` — `ok`/`fail`, `null` после неудачного handshake |
| `stability.h1`, `h24` | формула `reliability` за 1 ч и 24 ч (минимум 3 проверки, иначе `null`); `observations` — число значимых проверок за 24 ч |
| `timeline` | состояние на 96 моментах через 15 минут (24 ч) по таблице `transition`; моменты до появления endpoint'а пропускаются |
| `lastError` | `null` — ошибок не было; `{code, at}` — код из allowlist (`timeout`, `handshake_no_response`, `handshake_invalid`, `dns_failed`, `https_timeout`, `https_tls_failed`, `traffic_failed`, `targets_unreachable`), всё прочее — `unknown`. Сырые сообщения не экспортируются: в них бывают детали хоста. Поля нет — неизвестно (режим совместимости), страница пишет «нет данных», а не «нет» |
| `history.buckets` | значимые проверки по корзинам: 24h — 15 минут, 7d — 2 часа, 30d и all — 12 часов; `first`/`retry`/`fail` как в `session`; корзины только от первой проверки до сейчас, без выдуманных нулей до неё; ≤ 120 |
| `history.events` | до 100 последних значимых проверок в пределах диапазона; у `fail` — `error`-код |

Наблюдения на хосте хранятся 14 дней (`OBSERVATION_RETENTION_S`), поэтому `30d` и `all` показывают не больше 14 дней.

## Режим совместимости

Если `web-overview.json` нет, но есть `active-pool.json` и `lab-status.json` (Lab ещё без экспортёра), API
собирает сводку только из того, что эти файлы доказывают:

- `status` — `lab.health`; `generatedAt` — более ранний из двух `generated_at` (честная устарелость);
- `counts` — `pool.states`, но только при `pool.blacklisted = 0` (иначе в них попали бы blacklist), иначе `null`;
- `freshness` — `generated_at − newest/oldest_active_verified_s`; `activeTtlSec` — `expires_at − lab_verified_at`,
  если он одинаков у всех endpoint'ов пула, иначе `null`;
- `sessions` — `stats_15m.sessions` (там `both_sessions_failed` включает inconclusive: это семантика Lab-status);
- `endpoints` — только свежие ACTIVE из `active-pool.json` (проверка `validateLabSnapshot` провайдера):
  `https = ok` (ACTIVE ставится только после TLS-проверенного HTTPS через туннель), `session` и `reliability` — `null`;
- `activeHistory`, `events` не отдаются; `coverage: "active-only"` — страница пишет над списком «Подробный список
  пока доступен только для ACTIVE endpoint'ов»;
- детали — только для endpoint'а из свежего пула: `endpoint` и три `checks` со временем `lab_verified_at`; без
  `stability`, `timeline`, `history`, `lastError`. Остальные — 404, страница пишет «больше недоступны».

Поля `identity`, `scheduler`, `db`, `code`, `controls` из `lab-status.json` наружу не выходят.

## Ошибки и устаревание

| Ситуация | Ответ | Страница |
|---|---|---|
| файлов Lab нет (Vercel, форк, Lab не смонтирован) | 503 `{ "success": false, "code": "lab_not_available" }`, `Retry-After: 60` | «Данные Endpoint Lab пока недоступны» |
| файл не JSON, больше лимита, неверная схема/статус, массив сверх лимита, только один файл пары, деталь с чужим id | 503 `lab_malformed`, `Retry-After: 60` | «Данные Lab пришли в неожиданном формате» |
| endpoint не публичен | 404 `endpoint_not_found` | «Подробные данные по этому endpoint'у больше недоступны» |
| снимок старый, но валидный | **200** со старыми данными | STALE: данные видны, свежих ACTIVE 0 (истёкшие не считаются ACTIVE) |
| метод не GET/HEAD | 405 `method_not_allowed`, `Allow: GET, HEAD` | — |

STALE определяет страница: `generatedAt` старше 5 минут или `lastSuccessAt` старше `activeTtlSec`. Отдельного
`expiresAt` в контракте нет: этих двух полей и сроков endpoint'ов достаточно.

Все ответы `/api/lab`: `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`,
`X-Robots-Tag: noindex, nofollow`. Опрос страницы — раз в 30 с, в скрытой вкладке остановлен; `Retry-After` и
`retryAfterSec` удлиняют паузу, но не ускоряют опрос.

## Лимиты и замеры

| Что | Лимит | Замер |
|---|---|---|
| `web-overview.json` | 2 МБ (экспортёр и API), 500 endpoint'ов, 100 событий, 1500 точек | 158 КБ на 500 endpoint'ов |
| деталь | 256 КБ, 96 точек, 120 корзин, 100 событий | ≤ 24 КБ |
| экспорт на хосте | — | синтетическая БД 372 тыс. наблюдений: тёплый 187 мс, первый 1,2 с (Windows, с fsync) |
| `/api/lab` в Node | — | образец: холодный 0,3 мс, тёплый 0,1–0,2 мс (кеш по mtime+размеру) |

Детали пишутся инкрементально: изменённые с прошлого экспорта, отсутствующие и до 12 нетронутых старше часа
за прогон; файлы endpoint'ов, переставших быть публичными, удаляются. Каждый файл записан атомарно (temp,
fsync, `os.replace`, fsync каталога); сбой экспорта не валит задание Lab, старые файлы остаются и стареют, в
`lab_meta` — только `WEB_EXPORT_FAILED: <тип>`.

## Тестовые данные

`__tests__/fixtures/lab-public/` — настоящий вывод экспортёра и `publish()` Lab на тестовой БД:

```sh
# в ветке feat/endpoint-lab, каталог deploy/endpoint-lab
WEB_SAMPLE_OUT=<путь>/__tests__/fixtures/lab-public \
  python -m unittest test_endpoint_lab.WebExportTests.test_write_contract_sample_for_the_website
```

Часы Lab в тестах фиксированы, поэтому `__tests__/helpers/lab-public.js` сдвигает все ISO-метки к текущему
времени. Интеграционный e2e (`e2e/lab-api.e2e.js`) кладёт эти файлы в каталог сервера и проверяет страницу на
настоящем `/api/lab`, без `?fixture=`. Фикстуры `lab-fixtures.js` остаются для дизайна и состояний.

## Тексты

Пока генератор не берёт адреса из Lab (до Phase D), страница не пишет «доступны генератору» и «используются
генератором»: «свежие проверенные endpoint'ы», «пул свежих адресов (ACTIVE)». Тест `lab-page.test.js` это
проверяет; вернуть формулировки макета — в том же изменении, которое переключит генератор.

## Локальная проверка

- Демо-состояния: `node server.js`, затем на localhost `/lab?fixture=healthy|degraded|unavailable|stale|empty|mixed|partial|malformed|error|loading`,
  `&endpoint=162.159.192.18:2408` — подробности, `&quick=1` — окно быстрого просмотра. На других хостах
  `fixture` и `quick` игнорируются.
- Настоящий API: `ENDPOINT_LAB_PUBLIC_DIR=<каталог> node server.js`, где каталог — копия публичных файлов Lab.

## Для продакшена

1. Установить на хост Lab коммит `feat/endpoint-lab` с экспортёром (`install.sh <sha>`) — после решения по
   текущему gate Phase B; таймеры и identity установка не трогает. До этого `/api/lab` работает в режиме
   совместимости на уже публикуемых `active-pool.json` и `lab-status.json`.
2. Смонтировать публичный каталог в слоты сайта. Сейчас deploy controller делает это только при включённом
   shadow-флаге (`ENDPOINT_SHADOW_FLAG`); для страницы Lab mount нужен независимо от shadow — это отдельное
   изменение controller'а (не в этой ветке).
3. Слить `feat/endpoint-lab-web` в `main` — вместе с ним уйдут и 8 коммитов тёмного редизайна, которых ещё нет в
   `origin/main` (страница Lab построена на нём).

## Решения и отступления от макетов

- Ширина контейнера страницы — 1320 px (макет), у генератора 1240 px; шапка Lab растягивается вместе с контентом.
- Адреса набраны Inter с табличными цифрами, как в макете, а не моноширинным шрифтом.
- Проценты по правилам языка: `99,4%` в RU, `99.4%` в EN (в макете RU — с точкой).
- «Окно актуальности» берётся из данных (`activeTtlSec`, 7 минут), а не «до 24 часов» из макета.
- Подпись «HTTPS traffic (cloudflare.com)» сокращена до «HTTPS traffic»: целевой хост проверки в контракте не передаётся.
- Подписи про генератор нейтральны до Phase D (см. «Тексты»).
- Иллюстрация hero — астронавт из макета; панель «WARP Endpoints / WireGuard / Tunnel / HTTPS» сверстана текстом.
- Макеты 4–8 (история генераций с Lab endpoint, вкладки настроек генератора с автовыбором Lab, диагностика с
  компонентами «База данных», «Хранилище» и логами) относятся к генератору и операторской части и требуют
  переключения генератора на Lab; не реализованы.
