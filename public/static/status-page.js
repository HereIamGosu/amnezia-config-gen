/**
 * Страница /status.html: карточки live-статуса через общий поллер из live-status.js.
 * Вынесено из inline-скрипта страницы, чтобы CSP обходился без script-src 'unsafe-inline'.
 */
(() => {
  'use strict';

  const content = document.getElementById('statusContent');
  const lastChecked = document.getElementById('lastChecked');
  if (!content || !lastChecked) return;

  const formatMoscowTime = (isoStr) => {
    const d = new Date(isoStr);
    if (isNaN(d)) return isoStr;
    return d.toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }) + ' (МСК)';
  };

  const showLoading = () => {
    content.className = 'status-loading-msg';
    content.textContent = 'Загрузка данных...';
    lastChecked.hidden = true;
  };

  const showSnapshot = (snapshot) => {
    content.className = '';
    content.innerHTML = window.LiveStatus.renderCardsHtml(snapshot);
    lastChecked.hidden = false;
    lastChecked.textContent = '';
    const label = document.createElement('strong');
    label.textContent = 'Последняя проверка:';
    lastChecked.append(label, document.createElement('br'), formatMoscowTime(snapshot.checkedAt),
      document.createElement('br'), 'Обновляется автоматически раз в минуту, пока вкладка открыта.');
  };

  const showUnavailable = (err, { retryAt = null } = {}) => {
    const reason = {
      timeout: 'сервер не ответил вовремя',
      rate_limited: 'слишком много запросов',
    }[err && err.kind] || 'не удалось получить актуальные данные';
    lastChecked.hidden = true;
    content.className = 'status-error-msg';
    content.textContent = '';
    const title = document.createElement('strong');
    title.textContent = 'Статус временно недоступен';
    content.append(title, document.createElement('br'), reason);
    if (retryAt != null) {
      const at = new Date(retryAt).toLocaleTimeString('ru-RU', {
        timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      content.append(document.createElement('br'), `Следующая попытка около ${at} (МСК).`);
    }
  };

  if (window.LiveStatus) {
    window.LiveStatus.createPoller({
      load: () => window.LiveStatus.loadSnapshot(),
      onLoading: showLoading,
      onData: showSnapshot,
      onError: showUnavailable,
    }).start();
  } else {
    content.className = 'status-error-msg';
    content.textContent = 'Статус временно недоступен.';
  }
})();
