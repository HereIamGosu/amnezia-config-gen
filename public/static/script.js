// public/static/script.js

// Функция для скачивания файла
function downloadFile(content, filename) {
    const blob = new Blob([content], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
}

// Генерация конфигурации
async function generateConfig() {
    const button = document.getElementById('generateButton');
    const buttonText = document.querySelector('#generateButton .button__text');
    const status = document.getElementById('status');

    button.disabled = true;
    button.classList.add("button--loading");
    status.textContent = "Генерация конфигурации...";

    try {
        const response = await fetch('/api/warp', {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        });

        let data;
        const contentType = response.headers.get('content-type');

        if (contentType && contentType.includes('application/json')) {
            data = await response.json();
        } else {
            // Если не JSON, читаем как текст и выбрасываем ошибку
            const text = await response.text();
            throw new Error(text);
        }

        if (data.success) {
            const decodedConfig = atob(data.content);
            buttonText.textContent = 'Скачать AmneziaWarp.conf';
            // Удаление старого обработчика и добавление нового
            button.removeEventListener('click', generateConfig);
            button.addEventListener('click', () => downloadFile(decodedConfig, 'AmneziaWarp.conf'));
            downloadFile(decodedConfig, 'AmneziaWarp.conf');
            status.textContent = "Конфигурация успешно сгенерирована!";
        } else {
            status.textContent = `Ошибка: ${data.message}`;
        }
    } catch (error) {
        console.error('Ошибка при генерации конфигурации:', error);
        status.textContent = `Ошибка при генерации: ${error.message}`;
    } finally {
        button.disabled = false;
        button.classList.remove("button--loading");
    }
}

// Обработчик для кнопки генерации конфигурации
document.getElementById('generateButton').addEventListener('click', generateConfig);

// Обработчик для кнопки скачивания другого файла
document.getElementById('schedulerButton').addEventListener('click', async function() {
    const url = 'https://raw.githubusercontent.com/HereIamGosu/warp-config-generator/main/SchedulerAmnezia.bat';
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! статус: ${response.status}`);
        }

        const blob = await response.blob();
        downloadFile(blob, 'SchedulerAmnezia.bat');
    } catch (error) {
        console.error('Ошибка при скачивании файла:', error);
        alert('Не удалось скачать файл. Попробуйте позже.');
    }
});
