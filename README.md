# 🌐🔧 Генератор конфигурации AmneziaWG

Веб-приложение предназначено для генерации конфигурационных файлов для **AmneziaWG** — клиента WireGuard. Оно позволяет пользователю создать конфигурацию, скачать её и использовать в своей системе, а также получить файл планировщика для автоматического подключения при запуске системы. Проект уже развёрнут и доступен по адресу: [https://valokda-amnezia.vercel.app/](https://valokda-amnezia.vercel.app/).

![Интерфейс приложения](https://i.imgur.com/xjgNNQX.png)

## ✨ Основные особенности

- **Генерация конфигурации** для AmneziaWG с предустановленными маршрутами для Discord: режим **Legacy** (фиксированные магические заголовки H1=1..H4=4 и старые Jc/Jmin/Jmax — как в классическом профиле совместимости) или **AmneziaWG 2.0** (случайное **незапересекающееся** разбиение uint32 на четыре диапазона H1–H4 по реализации `amneziawg-go`; на каждом пакете клиент по-прежнему выбирает случайное значение *внутри* своего диапазона; дополнительно задаются случайные S1–S4 с ограничением `S1+56 ≠ S2`, Jc/Jmin/Jmax; нужен совместимый клиент, например AmneziaVPN 4.8.12.9+).
- **Скачивание сгенерированного конфигурационного файла** в формате `.conf`.
- **Скачивание .bat-файла** для автоматического запуска AmneziaWG при старте системы (только для Windows). По умолчанию в `SchedulerAmnezia.bat` указан конфиг `AmneziaWarp-AWG2.conf` в папке «Загрузки»; для Legacy замените `CONFIG_FILE` на `AmneziaWarp.conf`.
- **Инструкция по установке и настройке** прямо на сайте.
- **Динамическое обновление Endpoint** — приоритетно из ответа Cloudflare; при отсутствии хоста в JSON — случайный выбор из запасных WARP-совместимых адресов.
- **Устойчивость Cloudflare API** — повторные попытки с экспоненциальной задержкой при таймаутах, сбросах соединения, 429 и 502/503/504 (см. `api/warp.js`).
- **DNS** — по умолчанию в UI и в `GET /api/warp` без параметра `dns` используется пресет **Cloudflare** (`dns=cloudflare`), плитка подписана «(по умолчанию)».
- **Пресеты маршрутов** — в настройках (⚙) можно выбрать пресеты по категориям (соцсети, игры, торренты, дополнительно); для них на сервере собираются подсети IPv4 и IPv6 в `AllowedIPs`. Без выбора — полный туннель. В ответе `GET /api/iplist` у каждого пресета есть поле `category`: `social` \| `gaming` \| `torrent` \| `more`. API: `GET /api/warp?mode=legacy|awg2&presets=youtube,discord`, предпросмотр CIDR: `GET /api/iplist?presets=...`. Если открыта только статика (`public`), UI подхватывает `public/static/presets-fallback.json` (список пресетов и DNS-плитки); предпросмотр CIDR и генерация с маршрутами по-прежнему требуют `vercel dev` или деплой. После правок в `api/routePresets.js` обновите файл: `npm run presets:fallback`.
- **Совместимость** с операционными системами Windows, Linux и Android (конфигурация работает на всех платформах, файл планировщика — только для Windows).

## 🚀 Как использовать

1. Перейдите на веб-сайт: [https://valokda-amnezia.vercel.app/](https://valokda-amnezia.vercel.app/).
2. Нажмите **«Сгенерировать (Legacy)»** или **«Сгенерировать AmneziaWG 2.0»** в зависимости от версии клиента. API: `GET /api/warp?mode=legacy` или `GET /api/warp?mode=awg2` (в ответе также поле `mode`).
3. Скачайте сгенерированный файл и настройте AmneziaWG согласно инструкциям на сайте.
4. Для автоматической настройки запуска AmneziaWG при старте системы:
   - Скачайте **.bat-файл для планировщика**.
   - Запустите его **от имени администратора**.

## 📂 Структура проекта

- **/static** — статические файлы (изображения, стили и скрипты).
- **index.html** — главный HTML-файл, который загружается при посещении страницы.
- **styles.css** — стили для веб-приложения.
- **script.js** — JavaScript-код для взаимодействия с интерфейсом и генерации конфигурации.
- **api/warp.js** — серверless-обработчик Vercel: регистрация WARP через `api.cloudflareclient.com`, ретраи, сборка `.conf` для Legacy или AWG 2.0; опционально подстановка `AllowedIPs` по параметру `presets`.
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
