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
        const response = await fetch('/api/warp');
        
        if (!response.ok) {
            throw new Error(`Ошибка HTTP: ${response.status}`);
        }

        let data;
        try {
            data = await response.json();
        } catch (error) {
            const text = await response.text();  // Если это не JSON, пробуем получить текст
            console.error('Ошибка при парсинге JSON:', text);
            status.textContent = 'Ошибка: не удалось распарсить данные.';
            return;
        }

        if (data.success) {
            const decodedConfig = atob(data.content);  // Расшифровываем base64-строку конфигурации
            buttonText.textContent = 'Скачать AmneziaWarp.conf';
            
            // Удаляем старый обработчик и добавляем новый
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
            throw new Error(`Ошибка HTTP: ${response.status}`);
        }

        const blob = await response.blob();
        downloadFile(blob, 'SchedulerAmnezia.bat');
    } catch (error) {
        console.error('Ошибка при скачивании файла:', error);
        alert('Не удалось скачать файл. Попробуйте позже.');
    }
});
