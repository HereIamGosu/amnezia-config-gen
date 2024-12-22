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
        // Запрос к API для получения конфигурации
        const response = await fetch('/api/warp', {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            throw new Error(`Ошибка HTTP: ${response.status}`);
        }

        // Проверка типа контента, если это JSON
        const contentType = response.headers.get('content-type');
        let data;

        if (contentType && contentType.includes('application/json')) {
            data = await response.json();
        } else {
            // Если не JSON, читаем как текст
            const text = await response.text();
            throw new Error(`Ожидался JSON, но получен: ${text}`);
        }

        // Обработка успешного ответа
        if (data.success) {
            const decodedConfig = atob(data.content);
            buttonText.textContent = 'Скачать AmneziaWarp.conf';

            // Скачивание файла
            button.removeEventListener('click', generateConfig);  // Удаляем старый обработчик
            button.addEventListener('click', () => downloadFile(decodedConfig, 'AmneziaWarp.conf'));  // Добавляем новый

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
