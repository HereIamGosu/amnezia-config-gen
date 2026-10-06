// public/lab/lab-history.js
//
// «История» в шапке страницы Lab: тот же модал истории генераций, что у генератора, без перехода на
// главную. Список, предпросмотр и скачивание строят скрипты генератора (history.js, common.js, result.js,
// settings.js, i18n.js), подключённые перед этим файлом; при загрузке они только объявляют функции.
// Здесь — то, что на главной делает script.js: кнопка в шапке, очистка с подтверждением, «Копировать»
// в предпросмотре и словарь для t() (статичные тексты модалов уже на языке страницы).
//
// Классический скрипт (defer): общая глобальная область с теми скриптами.

/* global _i18n, localeRequestUrl, setI18nText, t -- i18n.js */
/* global openModal, previewConfigText, copyText, toast -- common.js */
/* global renderHistoryPanel, HISTORY_KEY -- history.js */

(() => {
  const doc = document;
  const lang = doc.documentElement.lang === 'en' ? 'en' : 'ru';

  // Словарь — тот же адрес с версией, что запрашивает lab.js: второй запрос отдаёт кэш браузера.
  _i18n.locale = lang;
  const stringsReady = fetch(localeRequestUrl(lang))
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (data && typeof data === 'object') _i18n.strings = data;
    })
    .catch(() => { /* без словаря t() отдаёт русские подписи по умолчанию */ });

  const init = () => {
    const historyModalBtn = doc.getElementById('historyModalBtn');
    const historyClearBtn = doc.getElementById('historyClearBtn');
    if (historyModalBtn) {
      historyModalBtn.addEventListener('click', async () => {
        await stringsReady;
        renderHistoryPanel();
        openModal('historyModal', historyModalBtn);
      });
    }
    if (historyClearBtn) {
      // Разрушающее действие — со вторым подтверждающим нажатием, как на главной.
      let confirmTimer = null;
      const resetConfirm = () => {
        historyClearBtn.dataset.confirm = '';
        setI18nText(historyClearBtn, 'history_clear_all', 'Очистить историю');
      };
      historyClearBtn.addEventListener('click', () => {
        if (historyClearBtn.dataset.confirm !== '1') {
          historyClearBtn.dataset.confirm = '1';
          setI18nText(historyClearBtn, 'history_clear_confirm', 'Нажмите ещё раз, чтобы удалить');
          if (confirmTimer) clearTimeout(confirmTimer);
          confirmTimer = setTimeout(resetConfirm, 4000);
          return;
        }
        if (confirmTimer) clearTimeout(confirmTimer);
        try { localStorage.removeItem(HISTORY_KEY); } catch { /* приватный режим */ }
        resetConfirm();
        renderHistoryPanel();
        doc.querySelector('#historyModal .modal__close')?.focus();
      });
    }
    const copyConfigBtnModal = doc.getElementById('copyConfigBtnModal');
    if (copyConfigBtnModal) {
      copyConfigBtnModal.addEventListener('click', async () => {
        if (!previewConfigText) return;
        const copied = await copyText(previewConfigText);
        toast(copied ? t('btn_copied', 'Скопировано!') : t('copy_failed', 'Не удалось скопировать.'), copied ? 'success' : 'info');
      });
    }
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
