// public/static/script.js

/**
 * Функция для скачивания файла.
 * @param {string} content Содержимое файла.
 * @param {string} filename Имя файла для скачивания.
 */
const downloadFile = (content, filename) => {
    const blob = new Blob([content], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  };
  
  /**
   * Генерация конфигурационного файла.
   */
  const generateConfig = async () => {
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
        if (!data.content) {
          throw new Error('Отсутствует содержимое конфигурации.');
        }
  
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
      // eslint-disable-next-line no-console
      console.error('Ошибка при генерации конфигурации:', error);
      status.textContent = `Ошибка: ${error.message}`;
    } finally {
      button.disabled = false;
      button.classList.remove('button--loading');
    }
  };
  
  /**
   * Обработчик для кнопки скачивания файла планировщика.
   */
  const downloadScheduler = async () => {
    const status = document.getElementById('status');
    status.textContent = 'Скачивание файла планировщика...';
  
    const SCHEDULER_URL = 'https://raw.githubusercontent.com/HereIamGosu/amnezia-config-gen/main/SchedulerAmnezia.bat';
    try {
      const response = await fetch(SCHEDULER_URL);
  
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
      // eslint-disable-next-line no-console
      console.error('Ошибка при скачивании файла:', error);
      status.textContent = 'Не удалось скачать файл. Попробуйте позже.';
    }
  };
  
  // Добавляем обработчики событий после загрузки DOM
  document.addEventListener('DOMContentLoaded', () => {
    const generateButton = document.getElementById('generateButton');
    const schedulerButton = document.getElementById('schedulerButton');
  
    if (generateButton) {
      generateButton.addEventListener('click', generateConfig);
    } else {
      // eslint-disable-next-line no-console
      console.error('Кнопка "generateButton" не найдена.');
    }
  
    if (schedulerButton) {
      schedulerButton.addEventListener('click', downloadScheduler);
    } else {
      // eslint-disable-next-line no-console
      console.error('Кнопка "schedulerButton" не найдена.');
    }
  });
  
  document.addEventListener('DOMContentLoaded', () => {
    const closeButton = document.querySelector('.close-button');
    const minimizeButton = document.querySelector('.minimize-button');
  
    closeButton.addEventListener('click', () => {
      // Закрывает окно браузера (работает только для окон, открытых через window.open)
      window.close();
    });
  
    minimizeButton.addEventListener('click', () => {
      // Скрывает содержимое окна
      const windowContent = document.querySelector('.window-content');
      if (windowContent.style.display === 'none') {
        windowContent.style.display = 'flex';
      } else {
        windowContent.style.display = 'none';
      }
    });
  });


// Добавляем обработчик для клика по тексту "Дополнительная информация"
document.addEventListener('DOMContentLoaded', () => {
  const infoLink = document.getElementById('infoLink');
  const modal = document.getElementById('modal');

  if (infoLink && modal) {
    // Открытие модального окна
    infoLink.addEventListener('click', () => {
      modal.style.display = 'flex';
    });

    // Закрытие модального окна при клике вне его области
    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        modal.style.display = 'none';
      }
    });
  } else {
    console.error('Элементы "infoLink" или "modal" не найдены.');
  }
});