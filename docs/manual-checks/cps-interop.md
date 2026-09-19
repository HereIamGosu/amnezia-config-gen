# CPS / I1 Manual Interoperability Matrix

Эта матрица отделяет автоматическую структурную проверку от реальной совместимости клиента, сети и WARP peer. Не помещайте сюда ключи, токены, полный конфиг или raw I1.

## Процедура

1. Сгенерировать один конфиг с явным `cps=<id>` и записать возвращённые `cpsRequested`, `cpsResolved`, `cpsStability`.
2. Импортировать конфиг в указанную версию клиента без ручной правки.
3. Проверить наличие handshake, затем доступ в интернет и DNS resolution не менее пяти минут.
4. Повторить на другом UDP WARP port; смена порта не считается исправлением генератора, но фиксируется как наблюдение сети.
5. Записывать только категориальные результаты и окружение без секретов.

| Дата | Client / OS | Network | CPS | Port | Handshake | Internet | DNS | Результат / примечание |
|---|---|---|---|---:|---|---|---|---|
| — | AmneziaWG 2.0 / — | — | Static | — | not run | not run | not run | Базовый stable контроль |
| — | AmneziaWG 2.0 / — | — | SIP | — | not run | not run | not run | Stable контроль |
| — | AmneziaWG 2.0 / — | — | STUN | — | not run | not run | not run | Stable контроль |
| — | AmneziaWG 2.0 / — | — | QUIC | — | not run | not run | not run | Experimental; проверить полный 1200-byte packet |
| — | AmneziaWG 2.0 / — | — | DNS | — | not run | not run | not run | Experimental response-shaped variant |
| — | AmneziaWG 2.0 / — | — | DTLS | — | not run | not run | not run | Experimental |

## Критерий повышения статуса

Протокол можно рассматривать для Auto только после воспроизводимого успеха handshake + internet + DNS минимум на двух клиентских платформах и двух независимых сетях без зависимости от одного случайного конфига. Один успешный handshake без передачи трафика недостаточен.
