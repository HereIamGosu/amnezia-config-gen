// server.js
const express = require('express');
const { generateWarpConfig } = require('./api/warp'); // Функция для генерации конфигурации WARP
const { logger, errorHandler } = require('./middleware'); // Подключаем middleware


const app = express();
const port = 3000;

// Подключение middleware
app.use(logger);
app.use(express.static('public')); // Для раздачи статики

// Обработка запроса на генерацию конфигурации
app.get('/warp', async (req, res) => {
    try {
        const config = await generateWarpConfig();
        res.json({ success: true, content: config });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Ошибка при генерации конфигурации' });
    }
});

// Обработка ошибок
app.use(errorHandler);

// Запуск сервера
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});