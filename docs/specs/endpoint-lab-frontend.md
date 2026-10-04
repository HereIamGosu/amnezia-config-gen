# Endpoint Lab — публичный frontend

Страница `/lab` (`/en/lab`) показывает состояние пула проверенных endpoint'ов Cloudflare WARP. Только чтение:
операторских действий (обновить, перепроверить, исключить, discovery, сброс identity) здесь нет.
Backend Lab (`deploy/endpoint-lab/`, ветка `feat/endpoint-lab`) публичного HTTP пока не отдаёт, поэтому
без подключённого API страница показывает «Данные Endpoint Lab пока недоступны» и ни одного числа.

## Файлы

| Файл | Назначение |
|---|---|
| `public/lab/index.html` | разметка (RU); шапка — та же, что у генератора |
| `public/en/lab/index.html` | генерируется `npm run seo:en` (`scripts/build-lab-page.js`), руками не править |
| `public/lab/lab.css` | стили Lab поверх `/static/styles.css` (те же токены) |
| `public/lab/lab-core.js` | проверка данных, модель представления, форматирование, состояние Lab; без DOM |
| `public/lab/lab-data.js` | **единственный адаптер данных**: адрес API, запрос, таймаут, Retry-After, опрос |
| `public/lab/lab.js` | отрисовка страницы, тикер «… назад», URL-состояние `?endpoint=` |
| `public/lab/lab-quick.js` | окно быстрого просмотра для страницы генератора (пока не подключено) |
| `public/lab/lab-fixtures.js` | демо-данные; грузится только на localhost |
| `public/lab/lab-hero.webp`, `lab-astronaut.webp` | иллюстрации, вырезанные из макета |

Файлы Lab лежат вне `public/static/`: они отдаются с `Cache-Control: public, max-age=0, must-revalidate` и ETag
(правила `/lab`, `/lab/(.*)`, `/en/lab`, `/en/lab/(.*)` в `vercel.json`), поэтому правка Lab не требует
повышения версии. Общие `styles.css`, `ui-shell.js`, шрифты и иконки берутся из `/static` с `?v=` и не меняются.
CSP не менялась: скрипты только свои, без inline-кода и `eval`.

## Контракт данных (предложение для backend)

Все поля — недоверенный ввод: `lab-core.js` проверяет форму, перечисления, границы и время. Испорченный
раздел становится `null` (страница показывает «часть данных не прошла проверку»), испорченный элемент списка
отбрасывается, неверный верхний уровень даёт состояние «данные в неожиданном формате». Время — ISO-8601 UTC;
метки из будущего дальше 5 минут отбрасываются. Доли — числа 0..1.

`GET <overview>` — сводка:

```json
{
  "schemaVersion": 1,
  "status": "ok | degraded | unavailable",
  "generatedAt": "2026-10-04T18:29:40Z",
  "counts": { "active": 24, "verified": 44, "suspect": 1, "quarantine": 3, "dead": 12 },
  "freshness": { "lastSuccessAt": "…", "oldestActiveVerifiedAt": "…", "activeTtlSec": 420 },
  "sessions": { "firstSession": 0.73, "retryRescued": 0.25, "failed": 0.02 },
  "activeHistory": [{ "at": "…", "active": 24 }],
  "events": [{ "type": "restored", "endpoint": "162.159.192.18:2408", "at": "…" },
             { "type": "discovery", "count": 3, "at": "…" }],
  "endpoints": [{
    "ip": "162.159.192.18", "port": 2408, "state": "ACTIVE", "source": "consumer_official_seed",
    "lastVerifiedAt": "…", "expiresAt": "…", "session": "first | retry | failed",
    "https": "ok | fail", "reliability": 0.994
  }],
  "retryAfterSec": 60
}
```

Обязательны `schemaVersion`, `status`, `generatedAt`; остальные разделы необязательны. Ограничения:
`endpoints` ≤ 500, `activeHistory` ≤ 1500 точек, `events` ≤ 100. `state`: `ACTIVE`, `VERIFIED`, `SUSPECT`,
`QUARANTINE`, `DEAD`, `DISCOVERED`; переходные `PROBING`, `HANDSHAKE_OK`, `VERIFYING` показываются как
«Проверяется»; неизвестное — «Неизвестно». Ручная блокировка — флаг оператора, в публичный ответ не входит.
`source` — `source_class` бэкенда (`negative_control` не публикуется); неизвестное значение — «Другой источник».
`events[].type`: `restored`, `promoted`, `discovery`, `suspect`, `excluded`, `demoted`, `dead`.

`GET <endpoint>?endpoint=<id>&range=all|24h|7d|30d` — подробности, `id` = `ip:port` или `[ipv6]:port`:

```json
{
  "schemaVersion": 1,
  "endpoint": { "…": "как элемент endpoints[]" },
  "checks": { "handshake": { "result": "ok", "at": "…" }, "tunnel": { "…": "…" }, "https": { "…": "…" } },
  "stability": { "h1": 0.992, "h24": 0.988, "observations": 214 },
  "timeline": [{ "at": "…", "state": "ACTIVE" }],
  "lastError": { "code": "handshake_timeout", "message": "Handshake timeout", "at": "…" },
  "history": { "range": "all", "buckets": [{ "at": "…", "first": 5, "retry": 1, "fail": 0 }],
               "events": [{ "at": "…", "result": "first | retry | fail", "error": "Handshake timeout" }] }
}
```

В ответах не должно быть приватных ключей, идентификаторов и токенов регистрации, путей хоста, адреса VPS,
внутренностей systemd и трассировок; тест `__tests__/lab-page.test.js` проверяет это для фикстур и кода страницы.

### Что из этого уже есть в Lab и чего нет

По состоянию веток `feat/endpoint-lab` (dfb44c6) и `feat/endpoint-provider` (e5a1c43):

- есть файлом на хосте: `lab-status.json` (`lab.health`, `pool.states`, `freshness.*`, `stats_15m.sessions`) и
  `active-pool.json` (только ACTIVE: `ip`, `port`, `state`, `lab_verified_at`, `expires_at`, `source_class`);
- нет: HTTP-маршрута к этим данным, списка не-ACTIVE endpoint'ов, `reliability`, `session`/`https` по адресу,
  истории ACTIVE по времени, ленты событий, подробностей и истории проверок одного endpoint'а
  (в БД есть таблицы `observation` и `transition`, наружу они не выходят).

Без недостающих разделов страница работает: таблица, график, активность и подробности показывают свои
пустые состояния.

## Подключение реальных данных

1. Backend отдаёт сводку по same-origin адресу (например, `api/lab.js`, читающий публичные файлы Lab).
2. В `public/lab/lab-data.js` заполнить `LAB_API.overview` (и `LAB_API.endpoint`, когда будут подробности).
   Другие файлы менять не нужно.
3. Опрос — раз в 30 с (`POLL_INTERVAL_MS`), в скрытой вкладке останавливается; `Retry-After` и
   `retryAfterSec` удлиняют паузу, но не ускоряют опрос.
4. Тексты макета «автоматически используются генератором» и «доступные генератору» пока заменены
   нейтральными («пул свежих адресов», «свежие проверенные endpoint'ы»): генератор на пул Lab не переключён.
   Вернуть формулировки макета можно в том же изменении, которое переключает генератор; тест
   `lab-page.test.js` не даст сделать это раньше, пока `LAB_API` пуст.
5. Быстрый просмотр на странице генератора: подключить `/lab/lab-core.js`, `/lab/lab-data.js`,
   `/lab/lab-quick.js` (defer, после `ui-shell.js`) и дать кнопке атрибут `data-lab-quick`. Это меняет
   `public/index.html`, но не `/static`.

## Локальная проверка

`npm start` или `node server.js`, затем на localhost: `/lab?fixture=healthy|degraded|unavailable|stale|empty|mixed|partial|malformed|error|loading`,
`&endpoint=162.159.192.18:2408` — подробности, `&quick=1` — окно быстрого просмотра. На любом другом
хосте параметры `fixture` и `quick` игнорируются, файл фикстур не загружается.

## Решения и отступления от макетов

- Ширина контейнера страницы — 1320 px (макет), у генератора 1240 px; шапка Lab растягивается вместе с контентом.
- Адреса набраны Inter с табличными цифрами, как в макете, а не моноширинным шрифтом.
- Проценты по правилам языка: `99,4%` в RU, `99.4%` в EN (в макете RU — с точкой).
- «Окно актуальности» берётся из данных (`activeTtlSec`; у Lab сейчас 7 минут), а не «до 24 часов» из макета.
- Подпись «HTTPS traffic (cloudflare.com)» сокращена до «HTTPS traffic»: целевой хост проверки в контракте не передаётся.
- Подписи про генератор нейтральны до переключения генератора на Lab (см. шаг 4 выше).
- Иллюстрация hero — астронавт из макета; панель «WARP Endpoints / WireGuard / Tunnel / HTTPS» сверстана текстом.
- Макеты 4–8 (история генераций с Lab endpoint, вкладки настроек генератора с автовыбором Lab, диагностика с
  компонентами «База данных», «Хранилище» и логами) относятся к генератору и операторской части; они требуют
  переключения генератора на Lab и здесь не реализованы.
