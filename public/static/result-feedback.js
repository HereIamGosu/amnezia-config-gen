// public/static/result-feedback.js
//
// «Подключилось?» в панели результата и «Поделиться» после ответа «Да». Вопрос появляется, когда конфиг
// уже у человека: при первом его действии с результатом (скачать, скопировать vpn:// или текст, открыть
// целиком) или, если файл скачался сам, при возврате на вкладку. Один ответ на одну генерацию; можно
// закрыть без ответа. «Нет» даёт шаги, которые только меняют параметр: каждая генерация регистрирует новое
// устройство WARP, поэтому новый конфиг человек создаёт сам. Делимся только ссылкой на главную с utm —
// никогда конфигом и vpn:// (в них приватный ключ). В Метрику уходят ответ и шаг, без текста и адресов.
//
// Классический скрипт (defer), не модуль: верхнеуровневые const/let/функции всех скриптов генератора
// живут в одной глобальной лексической области. Порядок загрузки — в public/index.html:
// i18n.js → common.js → status.js → result.js → result-feedback.js → settings.js → cps-editor.js →
// settings-link.js → history.js → script.js. При загрузке файл вызывает только своё и уже загруженное;
// остальное — из обработчиков после DOMContentLoaded. /* global */ — что файл берёт у других,
// /* exported */ — что отдаёт им (проверяют ESLint и __tests__/frontend-scripts.test.js).

/* global t, _i18n -- i18n.js */
/* global telemetry, toast, copyText, openModal -- common.js */
/* global currentResult, getModeLabel -- result.js */
/* global cfgState, endpointDefault, chooseEndpoint, updateParamChips -- settings.js */
/* exported noteResultAction, renderConnectionCheck, initConnectionCheck */

/** idle — ещё не спрашивали; ask — вопрос на экране; yes / no — ответ дан; closed — закрыт без ответа. */
const CONNECTION_STAGES = ['idle', 'ask', 'yes', 'no', 'closed'];

const connectionStage = () => (currentResult && CONNECTION_STAGES.includes(currentResult.connection)
  ? currentResult.connection
  : 'idle');

const resultOnScreen = () => {
  const panel = document.getElementById('resultPanel');
  return Boolean(currentResult && panel && !panel.hidden && panel.dataset.view === 'success');
};

// Тот же обезличенный контекст генерации, что у generation_succeeded, — только поля для разбивки ответа
const CONNECTION_CONTEXT_KEYS = [
  'mode', 'endpoint_mode', 'endpoint_source', 'cps_mode', 'cps_requested', 'cps_resolved', 'cps_stability',
  'mobile_profile', 'router_profile',
];

const connectionContext = (extra = {}) => {
  const source = (currentResult && currentResult.telemetryContext) || {};
  const context = {};
  CONNECTION_CONTEXT_KEYS.forEach((key) => {
    if (source[key] !== undefined) context[key] = source[key];
  });
  return { ...context, ...extra };
};

const setConnectionStage = (stage) => {
  if (!currentResult) return;
  currentResult.connection = stage;
  renderConnectionCheck();
};

/** Действие с результатом: показать вопрос, если для этой генерации его ещё не было. */
const noteResultAction = () => {
  if (resultOnScreen() && connectionStage() === 'idle') setConnectionStage('ask');
};

// ── «Поделиться»: только главная страница с метками, язык — как у страницы ──

const SHARE_ORIGIN = 'https://awgconfig.com';

const shareUrl = (medium) =>
  `${SHARE_ORIGIN}${_i18n.locale === 'en' ? '/en' : '/'}?utm_source=share&utm_medium=${medium}`;

const shareMessage = () => t('share_message',
  'Генератор конфигов AmneziaWG и WireGuard на базе Cloudflare WARP: файл .conf или ссылка для AmneziaVPN за минуту, без регистрации.');

const canShareNatively = () => typeof navigator.share === 'function'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse)').matches;

const renderSharePanel = () => {
  const telegram = document.getElementById('shareTelegram');
  if (telegram) {
    telegram.href = `https://t.me/share/url?url=${encodeURIComponent(shareUrl('telegram'))}`
      + `&text=${encodeURIComponent(shareMessage())}`;
  }
  const native = document.getElementById('shareNative');
  if (native) native.hidden = !canShareNatively();
};

// ── «Нет»: шаги по порядку. Порядок — как в ответе FAQ q5 и в предупреждении о версии клиента ──

/** Профиль, который принимает больше клиентов (src/server/clientCompatibility.js: 3.x — только клиенты с AWG 3.1). */
const PROFILE_FALLBACK = { awg31: 'awg2', awg3: 'awg2', awg2: 'legacy' };

/** Endpoint, отличный от того, с которым создан конфиг: Lab Auto ↔ hostname, ручной адрес → hostname. */
const endpointAlternative = () => {
  const used = currentResult && currentResult.snapshot ? currentResult.snapshot.warpEndpoint : '';
  if (used === 'hostname') return endpointDefault.labReady ? 'lab' : null;
  return 'hostname';
};

const endpointName = (value) => (value === 'lab'
  ? t('chip_endpoint_lab', 'Endpoint Lab')
  : t('chip_endpoint_hostname', 'Hostname'));

const checkedProfile = () => {
  const input = document.querySelector('[name="awgProfile"]:checked');
  return input ? input.value : '';
};

/** Текст с подстановкой: без data-i18n — его перерисует renderConnectionCheck при загрузке словаря. */
const setTemplateText = (el, key, fallback, values) => {
  if (!el) return;
  el.removeAttribute('data-i18n');
  el.textContent = Object.entries(values)
    .reduce((text, [name, value]) => text.split(`{${name}}`).join(value), t(key, fallback));
};

const renderStepButton = (button, selected, key, fallback, values) => {
  if (!button) return;
  button.disabled = selected;
  if (selected) setTemplateText(button, 'connect_step_selected', 'Выбрано', {});
  else setTemplateText(button, key, fallback, values);
};

const renderNextSteps = () => {
  const endpoint = endpointAlternative();
  const endpointStep = document.getElementById('connectStepEndpoint');
  if (endpointStep) {
    endpointStep.hidden = !endpoint;
    if (endpoint) {
      setTemplateText(document.getElementById('connectStepEndpointTitle'), 'connect_step_endpoint_title',
        'Другой endpoint: {endpoint}', { endpoint: endpointName(endpoint) });
      renderStepButton(document.getElementById('connectStepEndpointBtn'), cfgState.warpEndpoint === endpoint,
        'connect_step_choose', 'Выбрать {name}', { name: endpointName(endpoint) });
    }
  }

  const profile = currentResult ? PROFILE_FALLBACK[currentResult.mode] : null;
  const profileStep = document.getElementById('connectStepProfile');
  if (profileStep) {
    profileStep.hidden = !profile;
    if (profile) {
      const values = { profile: getModeLabel(profile), current: getModeLabel(currentResult.mode) };
      setTemplateText(document.getElementById('connectStepProfileTitle'), 'connect_step_profile_title',
        'Другой профиль: {profile}', values);
      setTemplateText(document.getElementById('connectStepProfileText'), 'connect_step_profile_text',
        'Старая версия клиента может не знать параметров {current}. {profile} принимает больше клиентов — см. карточку «Совместимость».',
        values);
      renderStepButton(document.getElementById('connectStepProfileBtn'), checkedProfile() === profile,
        'connect_step_choose', 'Выбрать {name}', { name: getModeLabel(profile) });
    }
  }
};

/** Перерисовывает блок по состоянию текущего результата: новый результат, вариант, смена языка. */
const renderConnectionCheck = () => {
  const box = document.getElementById('connectCheck');
  if (!box) return;
  const stage = connectionStage();
  box.dataset.stage = stage;
  const share = document.getElementById('connectSharePanel');
  const steps = document.getElementById('connectStepsPanel');
  if (share) share.hidden = stage !== 'yes';
  if (steps) steps.hidden = stage !== 'no';
  if (stage === 'yes') renderSharePanel();
  if (stage === 'no') renderNextSteps();
};

/** Параметр выставлен: генерацию запускает человек — подсказка и фокус на кнопке генерации. */
const pointToGenerate = (what) => {
  toast(t('connect_step_applied', 'Выбрано: {what}. Новый конфиг создаст кнопка «{button}».')
    .split('{what}').join(what)
    .split('{button}').join(t('btn_generate', 'Сгенерировать конфигурацию')));
  const button = document.getElementById('generateButton');
  if (button) {
    button.scrollIntoView({ behavior: 'smooth', block: 'center' });
    button.focus({ preventScroll: true });
  }
};

const runNextStep = (step, opener) => {
  telemetry.trackEvent('connection_next_step', connectionContext({ next_step: step }));
  if (step === 'endpoint') {
    const endpoint = endpointAlternative();
    if (!endpoint) return;
    chooseEndpoint(endpoint);
    updateParamChips();
    renderNextSteps();
    pointToGenerate(endpointName(endpoint));
  } else if (step === 'profile') {
    const profile = currentResult ? PROFILE_FALLBACK[currentResult.mode] : null;
    const input = profile && document.querySelector(`[name="awgProfile"][value="${profile}"]`);
    if (!input) return;
    input.checked = true;
    // change — тот же путь, что у клика по карточке: выбор запоминается
    input.dispatchEvent(new Event('change', { bubbles: true }));
    renderNextSteps();
    pointToGenerate(getModeLabel(profile));
  } else if (step === 'faq') {
    // Окно FAQ, раскрыт q5 «Конфиг импортировался, но не подключается» (без id: разметку окна копирует
    // страница Lab); после закрытия фокус вернётся на кнопку шага
    const item = document.querySelector('#faqModal [data-i18n="faq_q5"]')?.closest('details');
    if (item) item.open = true;
    openModal('faqModal', opener);
  }
  // telegram — обычная ссылка с data-tg-channel: адрес и цель канала ставит script.js
};

const shareVia = async (channel) => {
  if (channel === 'telegram') {
    telemetry.trackEvent('share_clicked', { share_channel: 'telegram' });
    return;
  }
  if (channel === 'copy') {
    if (await copyText(shareUrl('copy'))) {
      telemetry.trackEvent('share_clicked', { share_channel: 'copy' });
      toast(t('share_copied', 'Ссылка на awgconfig.com скопирована.'), 'success');
    } else {
      toast(t('copy_failed', 'Не удалось скопировать.'), 'info');
    }
    return;
  }
  if (channel === 'native' && canShareNatively()) {
    telemetry.trackEvent('share_clicked', { share_channel: 'native' });
    try {
      await navigator.share({ title: 'awgconfig.com', text: shareMessage(), url: shareUrl('native') });
    } catch {
      // Отмена в системном окне — не ошибка
    }
  }
};

const answerConnection = (works) => {
  // Один ответ на генерацию: после ответа или закрытия кнопки уже скрыты, повтор отсекается здесь
  if (connectionStage() !== 'ask') return;
  telemetry.trackEvent(works ? 'connection_works' : 'connection_fails', connectionContext());
  setConnectionStage(works ? 'yes' : 'no');
  // Нажатая кнопка скрылась: фокус — на заголовок появившегося блока
  document.getElementById(works ? 'connectShareTitle' : 'connectStepsTitle')?.focus();
};

const initConnectionCheck = () => {
  const box = document.getElementById('connectCheck');
  if (!box) return;
  box.addEventListener('click', (ev) => {
    const answer = ev.target.closest('[data-connect-answer]');
    if (answer) {
      answerConnection(answer.dataset.connectAnswer === 'yes');
      return;
    }
    if (ev.target.closest('[data-connect-close]')) {
      if (connectionStage() !== 'ask') return;
      setConnectionStage('closed');
      box.querySelector('[data-slot="next"] .link-btn')?.focus();
      return;
    }
    const step = ev.target.closest('[data-connect-step]');
    if (step) {
      runNextStep(step.dataset.connectStep, step);
      return;
    }
    const share = ev.target.closest('[data-share]');
    if (share) shareVia(share.dataset.share);
  });

  // Файл скачался сам (не iOS): человек уходит в клиент и возвращается — тогда и спрашиваем
  let hiddenWith = null;
  document.addEventListener('visibilitychange', () => {
    if (!currentResult || !currentResult.autoDownloaded || connectionStage() !== 'idle') return;
    if (document.visibilityState === 'hidden') {
      hiddenWith = currentResult;
    } else if (hiddenWith === currentResult) {
      hiddenWith = null;
      noteResultAction();
    }
  });
};
