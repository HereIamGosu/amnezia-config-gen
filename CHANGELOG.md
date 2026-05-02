# AmneziaWG Config Generator 2.1.0 — DPI-устойчивая генерация CPS

**Дата:** 2026-05-02
**Тип:** minor
**Совместимость:** полная — формат `.conf`, AllowedIPs/CIDR-логика, шаблоны WARP/Amnezia не менялись.

## TL;DR

Переработан внутренний генератор CPS-payload (поле `I1`). Все пять текущих протоколов стали ближе к реальному сетевому трафику; добавлен новый протокол DTLS; исправлен баг кодирования QUIC varInt; добавлены защитные ограничения, инспирированные сторонними проектами `payloadGen` (Sketchystan1) и `AmneziaWG-Architect` (Vadim-Khristenko). Никаких изменений UI и формата конфига — обновление прозрачно для пользователей.

## Что нового

### Шесть точечных улучшений генерации `I1`

1. **TLS ClientHello: GREASE и рандомизация порядка extension'ов.**
   В `auto`/`tls`-CPS теперь всегда вставляются GREASE-значения в cipher suites, supported_versions, supported_groups и key_share (RFC 8701, 0x?A?A pattern). Порядок промежуточных extension'ов перетасовывается на каждом запуске. Это поведение реальных Chrome/Firefox — отсутствие GREASE само по себе является fingerprint-сигналом.

2. **TLS ClientHello: padding extension до 512 байт.**
   Размер ClientHello теперь стабилизируется через `padding (0x0015)` — как делает Chrome, чтобы скрывать длину SNI/cookies. Все TLS-payload'ы теперь укладываются в одну длину 521 байт независимо от содержимого.

3. **STUN: SOFTWARE attribute, реалистичные USERNAME-шаблоны и динамический PADDING.**
   Раньше payload содержал только `USERNAME/PRIORITY/ICE-CONTROLLING`. Теперь добавлены:
   - `SOFTWARE` (`0x8022`) — выбирается из пула реальных ICE-агентов (`libwebrtc`, `pjnath`, `cisco-libsrtp`, `twilio-srtp`, `cloudflare-stun`).
   - `USERNAME` имитирует наблюдаемые шаблоны Google/Twilio/Cloudflare/WhatsApp ICE.
   - `USE-CANDIDATE` (`0x0025`) — типичный флаг.
   - `PADDING` (`0x0026`) до целевой длины пакета 100..220 байт. Длина варьируется от запроса к запросу, что снимает статический length-fingerprint.

4. **Новый CPS-протокол: DTLS 1.2 ClientHello.**
   Естественное расширение TLS, имитирует первый пакет WebRTC SRTP-handshake (включая `use_srtp 0x0007`, ECDHE-ECDSA cipher list, корректную DTLS record layer с epoch+seqnum). Включён в `auto`-ротацию (теперь шесть протоколов: `quic`/`dns`/`stun`/`tls`/`dtls`/`sip`).

5. **Исправлен баг кодирования QUIC varInt.**
   Старая реализация кодировала только формы 1/2/4 байта, причём 4-байтовая ветка (`n | 0x80000000`) выдавала знаково-инвертированное значение для `n ≥ 2³⁰`, ломая QUIC-пакет при больших длинах. Новая реализация поддерживает все четыре формы (RFC 9000 §16): 1, 2, 4 и 8 байт; проверена против всех тест-векторов RFC. На практике размеры наших payload'ов далеко не достигают этого диапазона, но корректность теперь гарантируется математически.

6. **Защитный 1000-байтный cap на длину payload.**
   Согласно недокументированному ограничению `splitPad` в AmneziaWG (1000 байт на тег) — payload больше этого размера может вызвать `ErrorCode 1000` в старых клиентах. Все генерируемые payload'ы теперь автоматически обрезаются. Целевая длина QUIC снижена с 1200 до 900..940 байт, чтобы оставаться в безопасном диапазоне. Pool из трёх verified WARP CPS-бинарников (~1200..1250 байт) намеренно не подпадает под cap — это статически проверенные payload'ы для Cloudflare-пира.

### Аудит инвариантов AmneziaWG 2.0

Подтверждено формальной проверкой на 5000 итерациях, что наши генераторы соблюдают все известные инварианты AmneziaWG:
- `S2 ≠ S1+56`, `S3 ≠ S1+56`, `S3 ≠ S2+92` (защита от коллизий с реальными WireGuard-размерами).
- `Jmax ≥ Jmin + 64` (требование AWG ≥ 1.5).
- `S1, S2, S3 ∈ [0, 64]`, `S4 ∈ [0, 32]`, `Jc ∈ [1, 25]`, `Jmin ∈ [64, 800]`, `Jmax ∈ [Jmin+64, 1024]` — все границы строго соблюдаются.

Эти же инварианты независимо реализует `AmneziaWG-Architect` — наша имплементация совпадает.

## Что не менялось

- Формат `.conf` (uppercase `I1`, AWG2 поля `[Interface]`, peer-блок).
- Фиксированный `MTU = 1280`, `S1=S2=S3=S4=0`, `H1..H4 = 1..4` для WARP-пресета (инвариант: Cloudflare-пир — стоковый WireGuard).
- Pool из трёх verified WARP CPS-payload'ов в `warpCpsPayloads.js`.
- Логика регистрации WARP, retry/jitter, IPv4/IPv6-валидация.
- CIDR-pipeline (opencck.org → antifilter.download fallback, кэш 10 мин).
- UI, шаблоны, рейт-лимит, локализация.

## Что было изучено и **не** портировано

Сознательно пропущено как избыточное или вредное для текущего scope:

- **Browser-fingerprint таблицы** (Chrome/Firefox/Edge/Safari TLS-fingerprints из `payloadGen`) — для WARP-пути бесполезны, т.к. Cloudflare-пир не парсит `I1` (он стоковый WireGuard).
- **Дополнительные протоколы:** NTP, CoAP, MQTT, RTP, RTCP, WebRTC-комбо, BitTorrent DHT, mDNS, LLMNR из `payloadGen`. Слишком много для «точечного» обновления — отложено на возможную будущую итерацию.
- **AWG 1.0-совместимость и H1-H4 banded ranges по типам пакетов** из `AmneziaWG-Architect` — для WARP-пути инвариант `H1..H4 = 1..4` обязателен; для self-hosted-шаблонов наша банд-нарезка уже работает.
- **Browser-fingerprint packet-size профили (Chrome QI 1250, Firefox QI 1252, ...)** из Architect — наш cap 1000 байт жёстче, что безопаснее на разнородных клиентах.
- **Бимодальное распределение entropy для I2-I5** — мы генерируем только `I1` (формат `.conf` AWG 2.0 не использует I2-I5 в нашей конфигурации).

## Файлы

- `api/cpsGenerator.js` — основные изменения (~+200 LOC, +1 новый генератор DTLS, +утилиты GREASE/cap).
- `api/warp.js` — удалён неиспользуемый импорт `pickRandomCpsPayload`.
- `package.json` — версия `2.0.0` → `2.1.0`.

## Проверка

- `npm run lint` — touched files clean.
- 5000-итерационный smoke-тест на инварианты AmneziaWG 2.0 — 0 нарушений.
- 30-итерационный smoke-тест на каждый из 8 режимов (`quic`/`dns`/`stun`/`tls`/`dtls`/`sip`/`static`/`auto`) — все размеры payload в ожидаемом диапазоне.
- Все 7 тест-векторов QUIC varInt из RFC 9000 §16 — проходят.

## Источники

- [Sketchystan1/payloadGen](https://github.com/Sketchystan1/payloadGen) — референс по структурам реальных протоколов (DNS, STUN, TLS, DTLS, QUIC) и набору helper-утилит. Лицензия MIT.
- [Vadim-Khristenko/AmneziaWG-Architect](https://github.com/Vadim-Khristenko/AmneziaWG-Architect) — независимое подтверждение AWG-инвариантов и `splitPad` 1000-байтного лимита. Лицензия MIT.

Идеи проверены и адаптированы; код не копировался дословно — все имплементации написаны под архитектуру нашего проекта.
