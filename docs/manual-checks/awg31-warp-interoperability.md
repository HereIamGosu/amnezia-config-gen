# AWG 3.1 / Cloudflare WARP Manual Interoperability

Автоматические тесты генератора не доказывают реальную UDP interoperability. Для каждого сценария зафиксируйте client/version, platform, network, generator commit и timestamps.

## Матрица

| Сценарий | ContentPaddingAddition | DisableCookies | RandomTrailers |
|---|---|---|---|
| Baseline A | off | off | off |
| Test B | 10-100 | off | off |
| Test C | 10-100 | on | off |
| Negative D, только контролируемый локальный AWG peer | 10-100 | on | on |

`D` не должен генерироваться production WARP API и не должен тестироваться против Cloudflare как штатный режим.

## Для A/B/C

- [ ] `.conf` импортирован; parser показывает ожидаемый AWG profile.
- [ ] Начальный handshake успешен.
- [ ] DNS и web browsing работают.
- [ ] Large TCP transfer завершён без зависания.
- [ ] UDP traffic проверен.
- [ ] Idle period пройден.
- [ ] Соединение наблюдалось минимум через один rekey interval.
- [ ] Reconnect выполнен.
- [ ] Проверены Wi-Fi и mobile network, если доступны.
- [ ] Зафиксированы packet loss, throughput и ошибки клиента.

Успешный import или один начальный handshake не считается успешным transport test.
