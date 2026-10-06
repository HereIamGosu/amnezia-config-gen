// public/static/script.js
//
// Точка входа генератора: выбор профиля AWG, запрос /api/warp и телеметрия генерации, затем
// подключение всех частей интерфейса по DOMContentLoaded. Загружается последним.
//
// Классический скрипт (defer), не модуль: верхнеуровневые const/let/функции всех скриптов генератора
// живут в одной глобальной лексической области. Порядок загрузки — в public/index.html:
// i18n.js → common.js → status.js → result.js → settings.js → settings-link.js → history.js →
// script.js. При загрузке файл вызывает только своё и уже загруженное;
// остальное — из обработчиков после DOMContentLoaded. /* global */ — что файл берёт у других,
// /* exported */ — что отдаёт им (проверяют ESLint и __tests__/frontend-scripts.test.js).

/* global t, setI18nText, initI18n, switchLang, restoreLangHandoff -- i18n.js */
/* global telemetry, parseJsonResponse, downloadFile, openModal, previewConfigText, copyText, toast -- common.js */
/* global initHeroStatus, fetchServiceStatus, openStatusModal, refreshHeroStatus -- status.js */
/* global
   getModeFilename, getModeLoadingLabel, showResultLoading, resultExplanation, lastResultSummary:writable,
   renderResultExplanation, lastCompatibility:writable, renderCompatibilityCard, showResult, getModeSuccessLabel,
   showResultError, initResultPanel -- result.js */
/* global
   cfgState, getSelectedRouteIds, ROUTE_MODES, getSelectedDnsKey, getResultStateSnapshot, initSettingsPanel,
   chooseEndpoint, updateParamChips -- settings.js */
/* global shareLink -- settings-link.js */
/* global saveToHistory, renderHistoryPanel, HISTORY_KEY -- history.js */
/* exported getSelectedProfile */

const TG_CHANNEL_URL = 'https://t.me/amnezia_config';

const API_WARP_TIMEOUT_MS = 120000;

const telemetryNow = () =>
  window.performance && typeof window.performance.now === 'function'
    ? window.performance.now()
    : Date.now();

const getTelemetryContext = (mode, extra = {}) => {
  const endpointMode = ['hostname', 'lab'].includes(cfgState.warpEndpoint) ? cfgState.warpEndpoint : 'ip';
  const awg3 = mode === 'awg3' || mode === 'awg31';
  return {
    mode,
    count_requested: cfgState.configCount,
    endpoint_mode: endpointMode,
    endpoint_source: endpointMode === 'ip' ? 'manual' : 'unknown',
    route_mode: getSelectedRouteIds().length ? 'split' : 'full',
    mobile_profile: cfgState.mobileMode,
    router_profile: cfgState.routerMode,
    cps_mode: cfgState.cpsProtocol,
    cps_requested: cfgState.cpsProtocol,
    awg_timing_ranges: awg3,
    awg_content_padding_experimental: false,
    awg_warp_safe: awg3,
    ...extra,
  };
};

const getEndpointTelemetrySource = (data, endpointMode) => {
  if (endpointMode === 'ip') return 'manual';
  const source = data && data.configs && data.configs[0] && data.configs[0].endpointSource;
  return source || 'unknown';
};

const getWarningCount = (warning) =>
  Array.isArray(warning) ? warning.length : warning ? 1 : 0;

const buildWarpQueryString = (mode) => {
  const params = new URLSearchParams();
  params.set('mode', mode);
  if (mode === 'legacy') params.set('template', 'warp_amnezia');
  if (mode === 'awg2') params.set('template', 'warp_amnezia_awg2');
  if (mode === 'awg3') params.set('template', 'warp_amnezia_awg3');
  if (mode === 'awg31') params.set('template', 'warp_amnezia_awg31');
  params.set('routeMode', cfgState.routeMode);
  // Only send presets in split mode — in full tunnel presets must not reach the server
  if (cfgState.routeMode === ROUTE_MODES.SPLIT) {
    const routeIds = getSelectedRouteIds();
    if (routeIds.length) params.set('presets', routeIds.join(','));
  }
  const dns = getSelectedDnsKey();
  if (dns) params.set('dns', dns);
  if (cfgState.includeIpv6) params.set('ipv6', '1');
  if (cfgState.routerMode) params.set('router', '1');
  if (cfgState.extraCps) params.set('cps5', '1');
  if (cfgState.mobileMode) params.set('mobile', '1');
  params.set('link', '1');
  params.set('cps', cfgState.cpsProtocol);
  params.set('port', String(cfgState.port));
  if (cfgState.configCount > 1) params.set('count', String(cfgState.configCount));
  if (cfgState.warpEndpoint === 'lab') {
    // Lab Auto: the server picks fresh Lab endpoints (the port is a preference) or answers lab_* — never hostname.
    params.set('endpointMode', 'lab');
  } else if (cfgState.warpEndpoint !== 'hostname') {
    params.set('peerEndpoint', `${cfgState.warpEndpoint}:${cfgState.port}`);
  }
  return params.toString();
};

/** Lab Auto refusals (HTTP 503 with a stable code): localized text instead of the server's Russian message. */
const LAB_AUTO_ERRORS = {
  lab_unavailable: ['err_lab_unavailable', 'Endpoint Lab сейчас недоступен. Lab Auto не создаёт конфигурацию без проверенных данных — выберите hostname в настройках endpoint.'],
  lab_stale: ['err_lab_stale', 'Данные Endpoint Lab устарели. Lab Auto не создаёт конфигурацию без свежей проверки — выберите hostname в настройках endpoint.'],
  lab_no_endpoints: ['err_lab_no_endpoints', 'В Endpoint Lab сейчас нет свежих проверенных endpoint\'ов. Выберите hostname в настройках endpoint или попробуйте позже.'],
  lab_selection_failed: ['err_lab_selection_failed', 'Не удалось выбрать endpoint Endpoint Lab. Конфигурация не создана — выберите hostname в настройках endpoint.'],
};

const getApiErrorMessage = (data) => {
  const lab = data && LAB_AUTO_ERRORS[data.error];
  return lab ? t(lab[0], lab[1]) : data && data.message;
};

/** Ошибка ответа /api/warp; отказ Lab Auto помечен — панель ошибки предложит hostname явной кнопкой. */
const apiError = (data, fallback) => {
  const error = new Error(getApiErrorMessage(data) || fallback);
  error.labRefusal = Boolean(data && LAB_AUTO_ERRORS[data.error]);
  return error;
};

// ─────────────────────────────────────────────────────────────
// Профиль AWG и генерация (одна кнопка для всех профилей)
// ─────────────────────────────────────────────────────────────

const PROFILE_MODES = ['legacy', 'awg2', 'awg3', 'awg31'];
const DEFAULT_PROFILE = 'awg2';
const PROFILE_STORAGE_KEY = 'awg_profile';

const getSelectedProfile = () => {
  const checked = document.querySelector('[name="awgProfile"]:checked');
  return checked && PROFILE_MODES.includes(checked.value) ? checked.value : DEFAULT_PROFILE;
};

/** Восстанавливает последний выбранный профиль; по умолчанию — AWG 2.0. */
const initProfileSelector = () => {
  let saved = null;
  try {
    saved = localStorage.getItem(PROFILE_STORAGE_KEY);
  } catch {
    saved = null;
  }
  // Профиль из ссылки с настройками (?profile=awg3) важнее запомненного, но не перезаписывает его:
  // выбор посетителя запоминается только по его собственному клику.
  const linked = shareLink ? shareLink.parseShareParams(window.location.search).profile : undefined;
  const initial = linked || saved;
  if (PROFILE_MODES.includes(initial)) {
    const input = document.querySelector(`[name="awgProfile"][value="${initial}"]`);
    if (input) input.checked = true;
  }
  document.querySelectorAll('[name="awgProfile"]').forEach((input) => {
    input.addEventListener('change', () => {
      try {
        localStorage.setItem(PROFILE_STORAGE_KEY, input.value);
      } catch {
        // Без localStorage выбор просто не запомнится
      }
    });
  });
};

let generationInFlight = false;

const generateConfig = async () => {
  const button = document.getElementById('generateButton');
  if (!button || generationInFlight) return;
  const mode = getSelectedProfile();
  const filename = getModeFilename(mode);
  const status = document.getElementById('status');
  const startedAt = telemetryNow();
  const startedContext = getTelemetryContext(mode);
  const resultState = getResultStateSnapshot();
  let response;

  // Empty split tunnel guard
  if (cfgState.routeMode === ROUTE_MODES.SPLIT && getSelectedRouteIds().length === 0) {
    status.textContent = t('routing_empty_split_error',
      'Для выборочной маршрутизации выберите хотя бы одно направление или переключитесь на полный туннель.');
    status.classList.remove('visually-hidden');
    return;
  }

  generationInFlight = true;
  button.disabled = true;
  button.classList.add('btn--loading');
  button.setAttribute('aria-busy', 'true');
  status.textContent = getModeLoadingLabel(mode);
  // Ход и итог генерации видны в панели результата; строку оставляем только для экранных дикторов
  status.classList.add('visually-hidden');
  showResultLoading();
  telemetry.trackEvent('generation_started', startedContext);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_WARP_TIMEOUT_MS);
    try {
      const warpQs = buildWarpQueryString(mode);
      response = await fetch(`/api/warp?${warpQs}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const data = await parseJsonResponse(response);

    if (!response.ok) {
      throw apiError(data, `${t('err_http_prefix', 'Ошибка HTTP:')} ${response.status}`);
    }

    if (!data.success) {
      throw apiError(data, t('err_unknown_gen', 'Неизвестная ошибка при генерации конфигурации.'));
    }
    if (!data.content) throw new Error(t('err_no_content', 'Отсутствует содержимое конфигурации.'));

    const countProduced = Number.isInteger(data.count)
      ? data.count
      : data.configs && data.configs.length
        ? data.configs.length
        : 1;
    const warningCount = getWarningCount(data.warning);
    const completedContext = {
      ...startedContext,
      count_produced: countProduced,
      endpoint_source: getEndpointTelemetrySource(data, startedContext.endpoint_mode),
      routes_source: data.routesTelemetrySource || 'unknown',
      has_warning: warningCount > 0,
      warning_count: warningCount,
      cps_requested: data.cpsRequested || startedContext.cps_requested,
      cps_resolved: data.cpsResolved || 'unknown',
      cps_stability: data.cpsStability || 'unknown',
      duration_ms: telemetry.durationMs(startedAt, telemetryNow()),
    };
    telemetry.trackEvent(
      countProduced < startedContext.count_requested
        ? 'generation_partially_succeeded'
        : 'generation_succeeded',
      completedContext,
    );
    if (resultExplanation) {
      lastResultSummary = resultExplanation.buildResultSummary(data, resultState);
      renderResultExplanation(lastResultSummary);
    }
    // Режим ответа нужен карточке: пометка про AWG 3.1 только у профилей 3.x.
    lastCompatibility = data.compatibility ? { ...data.compatibility, mode: data.mode } : null;
    renderCompatibilityCard(lastCompatibility);

    // Несколько вариантов (count = 2–3) показываются переключателем в панели результата.
    // Автоматически скачивается только первый: браузеры блокируют несколько загрузок подряд.
    const variants = data.configs && data.configs.length > 1
      ? data.configs.map((cfg, idx) => ({
        filename: filename.replace(/\.conf$/, `_variant${idx + 1}.conf`),
        decodedConfig: atob(cfg.content),
        vpnLink: cfg.vpnLink || null,
      }))
      : [{ filename, decodedConfig: atob(data.content), vpnLink: data.vpnLink || null }];

    showResult({
      mode,
      variants,
      hasWarnings: warningCount > 0,
      telemetryContext: completedContext,
      snapshot: resultState,
    });
    downloadFile(variants[0].decodedConfig, variants[0].filename);
    telemetry.trackEvent('config_downloaded', completedContext);
    saveToHistory(mode, variants[0].decodedConfig, variants[0].filename, resultState);

    status.textContent = data.warning
      ? t('generation_completed_with_warnings',
        'Конфигурация создана с предупреждениями. Подробности указаны в карточке результата.')
      : getModeSuccessLabel(mode);
  } catch (error) {
    telemetry.trackEvent('generation_failed', {
      ...startedContext,
      count_produced: 0,
      error_code: telemetry.classifyGenerationError(error, response && response.status),
    });
    console.error('Ошибка при генерации конфигурации:', error);
    const message = error && error.name === 'AbortError'
      ? t('err_timeout', 'Превышено время ожидания ответа. Попробуйте ещё раз.')
      : error.message;
    status.textContent = `${t('err_prefix', 'Ошибка:')} ${message}`;
    showResultError(message, { labRefusal: Boolean(error && error.labRefusal) });
  } finally {
    generationInFlight = false;
    button.disabled = false;
    button.classList.remove('btn--loading');
    button.removeAttribute('aria-busy');
  }
};

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-tg-channel]').forEach((el) => {
    el.href = TG_CHANNEL_URL;
    el.addEventListener('click', () => {
      if (typeof ym === 'function') ym(99328227, 'reachGoal', 'telegram_channel_footer_click');
    });
  });

  initProfileSelector();
  const generateButton = document.getElementById('generateButton');
  if (generateButton) {
    generateButton.addEventListener('click', () => generateConfig());
  } else {
    console.error('Кнопка "generateButton" не найдена.');
  }
  // Отказ Lab Auto: «Сгенерировать через hostname» — явный выбор посетителя, не тихая подмена
  const hostnameRetry = document.getElementById('resultHostnameRetry');
  if (hostnameRetry) {
    hostnameRetry.addEventListener('click', () => {
      chooseEndpoint('hostname');
      updateParamChips();
      generateConfig();
    });
  }
  initResultPanel();

  // ── История генераций ──
  const historyModalBtn = document.getElementById('historyModalBtn');
  const historyClearBtn = document.getElementById('historyClearBtn');
  if (historyModalBtn) {
    historyModalBtn.addEventListener('click', () => {
      renderHistoryPanel();
      openModal('historyModal', historyModalBtn);
    });
  }
  if (historyClearBtn) {
    // Разрушающее действие — со вторым подтверждающим нажатием.
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
      try { localStorage.removeItem(HISTORY_KEY); } catch { /* */ }
      resetConfirm();
      renderHistoryPanel();
      document.querySelector('#historyModal .modal__close')?.focus();
    });
  }
  renderHistoryPanel();

  initSettingsPanel();

  // ── F-03: Локализация ──
  initI18n();
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchLang(btn.dataset.lang));
  });
  restoreLangHandoff();

  // ── Статус сервисов: карточка в hero и модал ──
  telemetry.trackEvent('healthcheck_opened');
  initHeroStatus();
  fetchServiceStatus();
  const statusModalBtn = document.getElementById('statusModalBtn');
  if (statusModalBtn) statusModalBtn.addEventListener('click', () => openStatusModal(statusModalBtn));
  // Делегирование: ссылки внутри переводимого текста (ответ FAQ) перерисовываются при загрузке словаря
  document.addEventListener('click', (ev) => {
    const link = ev.target.closest && ev.target.closest('[data-status-link]');
    if (!link || ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
    ev.preventDefault();
    openStatusModal(link);
  });
  const statusRefreshBtn = document.getElementById('statusRefreshBtn');
  if (statusRefreshBtn) {
    statusRefreshBtn.addEventListener('click', () => {
      statusRefreshBtn.classList.add('is-spinning');
      setTimeout(() => statusRefreshBtn.classList.remove('is-spinning'), 900);
      refreshHeroStatus();
    });
  }

  // ── Предпросмотр: «Копировать» отдаёт полный конфиг, хотя на экране ключ скрыт ──
  const copyConfigBtnModal = document.getElementById('copyConfigBtnModal');
  if (copyConfigBtnModal) {
    copyConfigBtnModal.addEventListener('click', async () => {
      if (!previewConfigText) return;
      const copied = await copyText(previewConfigText);
      toast(copied ? t('btn_copied', 'Скопировано!') : t('copy_failed', 'Не удалось скопировать.'), copied ? 'success' : 'info');
    });
  }

  // ── «Какой профиль выбрать?» ──
  const infoLink = document.getElementById('infoLink');
  if (infoLink) infoLink.addEventListener('click', () => openModal('modal', infoLink));
});
