// public/static/script.js

const API_WARP_TIMEOUT_MS = 45000;

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
  
  const GENERATE_BUTTON_IDS = ['generateButton', 'generateButtonAwg2'];

  const setAllGenerateButtonsDisabled = (disabled) => {
    GENERATE_BUTTON_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = disabled;
    });
  };

  /**
   * Генерация конфигурационного файла (Legacy AmneziaWG или AmneziaWG 2.0).
   * @param {{ buttonId: string, mode: string, filename: string, readyDownloadText: string, loadingLabel: string, boundGenerateClick: () => void }} options
   */
  const generateConfig = async (options) => {
    const { buttonId, mode, filename, readyDownloadText, loadingLabel, boundGenerateClick } = options;
    const button = document.getElementById(buttonId);
    if (!button) {
      return;
    }
    const buttonText = button.querySelector('.button__text');
    const status = document.getElementById('status');

    setAllGenerateButtonsDisabled(true);
    button.classList.add('button--loading');
    status.textContent = loadingLabel;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_WARP_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(`/api/warp?mode=${encodeURIComponent(mode)}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
  
      if (!response.ok) {
        let message = `Ошибка HTTP: ${response.status}`;
        try {
          const errorData = await response.json();
          if (errorData && errorData.message) {
            message = errorData.message;
          }
        } catch {
          /* non-JSON error body */
        }
        throw new Error(message);
      }
  
      const data = await response.json();
  
      if (data.success) {
        if (!data.content) {
          throw new Error('Отсутствует содержимое конфигурации.');
        }
  
        const decodedConfig = atob(data.content);
        buttonText.textContent = readyDownloadText;

        const downloadHandler = () => downloadFile(decodedConfig, filename);

        if (boundGenerateClick) {
          button.removeEventListener('click', boundGenerateClick);
        }
        button.addEventListener('click', downloadHandler);

        downloadHandler();
        status.textContent =
          mode === 'awg2'
            ? 'Конфигурация AmneziaWG 2.0 успешно сгенерирована! Нужен клиент AmneziaVPN 4.8.12.9+ или совместимый AWG 2.0.'
            : 'Конфигурация Legacy успешно сгенерирована!';
      } else {
        throw new Error(data.message || 'Неизвестная ошибка при генерации конфигурации.');
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Ошибка при генерации конфигурации:', error);
      const message =
        error && error.name === 'AbortError'
          ? 'Превышено время ожидания ответа. Попробуйте ещё раз.'
          : error.message;
      status.textContent = `Ошибка: ${message}`;
    } finally {
      setAllGenerateButtonsDisabled(false);
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
  
  document.addEventListener('DOMContentLoaded', () => {
    const generateButton = document.getElementById('generateButton');
    const generateButtonAwg2 = document.getElementById('generateButtonAwg2');
    const schedulerButton = document.getElementById('schedulerButton');

    /** @type {{ buttonId: string, mode: string, filename: string, readyDownloadText: string, loadingLabel: string, boundGenerateClick: () => void }} */
    const legacyOptions = {
      buttonId: 'generateButton',
      mode: 'legacy',
      filename: 'AmneziaWarp.conf',
      readyDownloadText: 'Скачать AmneziaWarp.conf',
      loadingLabel: 'Генерация конфигурации (Legacy)...',
      boundGenerateClick: () => {},
    };
    legacyOptions.boundGenerateClick = () => generateConfig(legacyOptions);

    /** @type {{ buttonId: string, mode: string, filename: string, readyDownloadText: string, loadingLabel: string, boundGenerateClick: () => void }} */
    const awg2Options = {
      buttonId: 'generateButtonAwg2',
      mode: 'awg2',
      filename: 'AmneziaWarp-AWG2.conf',
      readyDownloadText: 'Скачать AmneziaWarp-AWG2.conf',
      loadingLabel: 'Генерация конфигурации (AmneziaWG 2.0)...',
      boundGenerateClick: () => {},
    };
    awg2Options.boundGenerateClick = () => generateConfig(awg2Options);

    if (generateButton) {
      generateButton.addEventListener('click', legacyOptions.boundGenerateClick);
    } else {
      // eslint-disable-next-line no-console
      console.error('Кнопка "generateButton" не найдена.');
    }

    if (generateButtonAwg2) {
      generateButtonAwg2.addEventListener('click', awg2Options.boundGenerateClick);
    } else {
      // eslint-disable-next-line no-console
      console.error('Кнопка "generateButtonAwg2" не найдена.');
    }

    if (schedulerButton) {
      schedulerButton.addEventListener('click', downloadScheduler);
    } else {
      // eslint-disable-next-line no-console
      console.error('Кнопка "schedulerButton" не найдена.');
    }

    const closeButton = document.querySelector('.close-button');
    const minimizeButton = document.querySelector('.minimize-button');

    if (closeButton) {
      closeButton.addEventListener('click', () => {
        window.close();
      });
    }

    if (minimizeButton) {
      minimizeButton.addEventListener('click', () => {
        const windowContent = document.querySelector('.window-content');
        if (!windowContent) {
          return;
        }
        if (windowContent.style.display === 'none') {
          windowContent.style.display = 'flex';
        } else {
          windowContent.style.display = 'none';
        }
      });
    }

    const infoLink = document.getElementById('infoLink');
    const modal = document.getElementById('modal');

    if (infoLink && modal) {
      const closeModal = () => {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
      };

      const openModal = () => {
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
      };

      infoLink.addEventListener('click', openModal);

      modal.addEventListener('click', (event) => {
        if (event.target === modal) {
          closeModal();
        }
      });

      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') {
          return;
        }
        if (modal.style.display === 'flex') {
          closeModal();
        }
      });
    } else {
      // eslint-disable-next-line no-console
      console.error('Элементы "infoLink" или "modal" не найдены.');
    }
  });