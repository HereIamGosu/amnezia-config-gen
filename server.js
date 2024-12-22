// server.js
const express = require('express');
const { generateWarpConfig } = require('./api/warp'); // Функция для генерации конфигурации WARP

const app = express();
const port = 3000;

// Раздача статики
app.use(express.static('public'));

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

// Запуск сервера
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
