async function generateConfig() {
    const button = document.getElementById('generateButton');
    const button_text = document.querySelector('#generateButton .button__text');
    const status = document.getElementById('status');
    
    button.disabled = true;
    button.classList.add("button--loading");
    status.textContent = "Генерация конфигурации...";

    try {
        const response = await fetch(`https://amnezia-config-bpuusmrvw-hereiamgosus-projects.vercel.app/warp`);
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
            button.onclick = downloadFile;
            status.textContent = "Конфигурация успешно сгенерирована!";
        } else {
            status.textContent = 'Ошибка: ' + data.message;
        }
    } catch (error) {
        status.textContent = 'Произошла ошибка при генерации. Попробуйте снова.';
    } finally {
        button.disabled = false;
        button.classList.remove("button--loading");
    }
}


// Привязываем функцию к кнопке
document.getElementById('generateButton').onclick = generateConfig;


document.getElementById('schedulerButton').onclick = async function() {
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
};
