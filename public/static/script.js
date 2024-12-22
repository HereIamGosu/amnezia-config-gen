// public/static/script.js

async function generateConfig() {
    const button = document.getElementById('generateButton');
    const button_text = document.querySelector('#generateButton .button__text');
    const status = document.getElementById('status');

    button.disabled = true;
    button.classList.add("button--loading");
    status.textContent = "Генерация конфигурации...";

    try {
        const response = await fetch('/api/warp');
        const data = await response.json();

        if (data.success) {
            const downloadFile = () => {
                const blob = new Blob([data.content], { type: 'text/plain' });
                const link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = 'AmneziaWarp.conf';
                link.click();
                URL.revokeObjectURL(link.href);
            };

            button_text.textContent = 'Скачать AmneziaWarp.conf';
            button.removeEventListener('click', generateConfig); // Удаляем старый обработчик
            button.addEventListener('click', downloadFile); // Добавляем новый обработчик
            downloadFile();
            status.textContent = "Конфигурация успешно сгенерирована!";
        } else {
            status.textContent = 'Ошибка: ' + data.message;
        }
    } catch (error) {
        console.error(error);
        status.textContent = 'Произошла ошибка при генерации. Попробуйте снова.';
    } finally {
        button.disabled = false;
        button.classList.remove("button--loading");
    }
}

document.getElementById('generateButton').addEventListener('click', generateConfig);

document.getElementById('schedulerButton').addEventListener('click', async function() {
    const url = 'https://raw.githubusercontent.com/HereIamGosu/warp-config-generator/main/SchedulerAmnezia.bat';
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! статус: ${response.status}`);
        }

        const blob = await response.blob();
        const urlBlob = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = urlBlob;
        a.download = 'SchedulerAmnezia.bat';
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(urlBlob);
    } catch (error) {
        console.error('Ошибка при скачивании файла:', error);
        alert('Не удалось скачать файл. Попробуйте позже.');
    }
});
