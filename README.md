# 🌐🔧 Генератор конфигурации AmneziaWG

Веб-приложение предназначено для генерации конфигурационных файлов для **AmneziaWG** — клиента WireGuard. Оно позволяет пользователю создать конфигурацию, скачать её и использовать в своей системе, а также получить файл планировщика для автоматического подключения при запуске системы. Проект уже развёрнут и доступен по адресу: [https://valokda-amnezia.vercel.app/](https://valokda-amnezia.vercel.app/).

![Интерфейс приложения](https://i.imgur.com/xjgNNQX.png)

## ✨ Основные особенности

- **Генерация конфигурации** для AmneziaWG с предустановленными маршрутами для Discord.
- **Скачивание сгенерированного конфигурационного файла** в формате `.conf`.
- **Скачивание .bat-файла** для автоматического запуска AmneziaWG при старте системы (только для Windows).
- **Инструкция по установке и настройке** прямо на сайте.
- **Динамическое обновление Endpoint** — автоматическое получение актуального IP-адреса от Cloudflare.
- **Совместимость** с операционными системами Windows, Linux и Android (конфигурация работает на всех платформах, файл планировщика — только для Windows).

## 🚀 Как использовать

1. Перейдите на веб-сайт: [https://valokda-amnezia.vercel.app/](https://valokda-amnezia.vercel.app/).
2. Нажмите кнопку **"Сгенерировать"**, чтобы создать конфигурационный файл для AmneziaWG.
3. Скачайте сгенерированный файл и настройте AmneziaWG согласно инструкциям на сайте.
4. Для автоматической настройки запуска AmneziaWG при старте системы:
   - Скачайте **.bat-файл для планировщика**.
   - Запустите его **от имени администратора**.

## 📂 Структура проекта

- **/static** — статические файлы (изображения, стили и скрипты).
- **index.html** — главный HTML-файл, который загружается при посещении страницы.
- **styles.css** — стили для веб-приложения.
- **script.js** — JavaScript-код для взаимодействия с интерфейсом и генерации конфигурации.
- **warp.js** — серверный скрипт для генерации конфигурации через API Cloudflare WARP.
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
