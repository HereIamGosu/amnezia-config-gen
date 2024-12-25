// public/static/script.js

/**
 * Функция для скачивания файла.
 * @param {string} content Содержимое файла.
 * @param {string} filename Имя файла для скачивания.
 */
function downloadFile(content, filename) {
    const blob = new Blob([content], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }
  
  /**
   * Генерация конфигурационного файла.
   */
  async function generateConfig() {
    const button = document.getElementById('generateButton');
    const buttonText = button.querySelector('.button__text');
    const status = document.getElementById('status');
  
    button.disabled = true;
    button.classList.add('button--loading');
    status.textContent = 'Генерация конфигурации...';
  
    try {
      const response = await fetch('/api/warp', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });
  
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || `Ошибка HTTP: ${response.status}`);
      }
  
      const data = await response.json();
  
      if (data.success) {
        const decodedConfig = atob(data.content);
        buttonText.textContent = 'Скачать AmneziaWarp.conf';
  
        // Обработчик для скачивания файла при повторном клике
        const downloadHandler = () => downloadFile(decodedConfig, 'AmneziaWarp.conf');
        button.removeEventListener('click', generateConfig);
        button.addEventListener('click', downloadHandler);
  
        // Сразу скачиваем файл после генерации
        downloadHandler();
        status.textContent = 'Конфигурация успешно сгенерирована!';
      } else {
        throw new Error(data.message || 'Неизвестная ошибка при генерации конфигурации.');
      }
    } catch (error) {
      console.error('Ошибка при генерации конфигурации:', error);
      status.textContent = `Ошибка: ${error.message}`;
    } finally {
      button.disabled = false;
      button.classList.remove('button--loading');
    }
  }
  
  /**
   * Обработчик для кнопки скачивания файла планировщика.
   */
  async function downloadScheduler() {
    const status = document.getElementById('status');
    status.textContent = 'Скачивание файла планировщика...';
  
    try {
      const url = 'https://raw.githubusercontent.com/HereIamGosu/warp-config-generator/main/SchedulerAmnezia.bat';
      const response = await fetch(url);
  
      if (!response.ok) {
        throw new Error(`Ошибка HTTP: ${response.status}`);
      }
  
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = 'SchedulerAmnezia.bat';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
  
      status.textContent = 'Файл планировщика успешно скачан!';
    } catch (error) {
      console.error('Ошибка при скачивании файла:', error);
      status.textContent = 'Не удалось скачать файл. Попробуйте позже.';
      alert('Не удалось скачать файл. Попробуйте позже.');
    }
  }
  
  // Добавляем обработчики событий после загрузки DOM
  document.addEventListener('DOMContentLoaded', () => {
    const generateButton = document.getElementById('generateButton');
    const schedulerButton = document.getElementById('schedulerButton');
  
    generateButton.addEventListener('click', generateConfig);
    schedulerButton.addEventListener('click', downloadScheduler);
  });
  