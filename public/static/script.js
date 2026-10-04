// public/static/script.js

// ─────────────────────────────────────────────────────────────
// F-03: Локализация (i18n)
// ─────────────────────────────────────────────────────────────

// Языковые версии страницы; язык текущей задан атрибутом <html lang> (en/index.html генерируется).
const LANG_PATHS = { ru: '/', en: '/en' };
const isKnownLang = (lang) => Object.prototype.hasOwnProperty.call(LANG_PATHS, lang);
const PAGE_LANG = document.documentElement.lang === 'en' ? 'en' : 'ru';

const _i18n = { locale: PAGE_LANG, strings: {} };
const resultExplanation = window.ResultExplanation || null;
let lastResultSummary = null;
let lastCompatibility = null;
const telemetry = window.ProductTelemetry || {
  classifyGenerationError: () => 'unknown',
  durationMs: () => 0,
  trackEvent: () => false,
};

const telemetryNow = () =>
  window.performance && typeof window.performance.now === 'function'
    ? window.performance.now()
    : Date.now();

const getTelemetryContext = (mode, extra = {}) => {
  const endpointMode = cfgState.warpEndpoint === 'hostname' ? 'hostname' : 'ip';
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

/** Возвращает переведённую строку или fallback (если перевод не загружен). */
const t = (key, fallback) => _i18n.strings[key] !== undefined ? _i18n.strings[key] : (fallback !== undefined ? fallback : key);

/** Обходит все элементы с data-i18n-* и применяет переводы. */
const applyTranslations = () => {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const val = _i18n.strings[key];
    if (val !== undefined) el.textContent = val;
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const key = el.getAttribute('data-i18n-html');
    const val = _i18n.strings[key];
    if (val !== undefined) el.innerHTML = val;
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    const val = _i18n.strings[key];
    if (val !== undefined) el.title = val;
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria-label');
    const val = _i18n.strings[key];
    if (val !== undefined) el.setAttribute('aria-label', val);
  });
  document.querySelectorAll('[data-i18n-alt]').forEach((el) => {
    const key = el.getAttribute('data-i18n-alt');
    const val = _i18n.strings[key];
    if (val !== undefined) el.setAttribute('alt', val);
  });
};

/**
 * Загружает словарь для заданного языка и применяет переводы.
 * Fallback: если файл недоступен (offline), оставляем HTML-текст нетронутым.
 */
const loadLocale = async (lang) => {
  try {
    const res = await fetch(`/locales/${lang}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _i18n.strings = await res.json();
    _i18n.locale = lang;
    applyTranslations();
    // data-i18n дал счётчику только заготовку: перерисовываем его на текущем языке с реальным числом
    updateCidrCounter(cfgState.routeMode === ROUTE_MODES.FULL ? 0 : cfgState.cidrCount4);
    if (lastResultSummary) renderResultExplanation(lastResultSummary);
    if (lastCompatibility) renderCompatibilityCard(lastCompatibility);
    // Тексты, которые строит JS (статус, чипы, результат, история), — на языке словаря
    renderHeroStatus();
    updateParamChips();
    if (currentResult) renderResultSuccess();
    renderHistoryPanel();
  } catch {
    // В офлайн-режиме или при 404 оставляем исходный HTML-текст (русский)
  }
  // Обновляем состояние кнопок переключателя
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.classList.toggle('lang-btn--active', btn.dataset.lang === _i18n.locale);
  });
};

/**
 * Fetch /api/status and show a banner only for measured problems (degraded/down).
 * `unknown` means there is no endpoint health data — not a failure, so no banner.
 */
const fetchServiceStatus = async () => {
  const bannerEl = document.getElementById('statusBanner');
  if (!bannerEl) return;
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const data = await res.json();
    if (data.status === 'degraded' || data.status === 'down') {
      const key = data.status === 'down' ? 'status_banner_down' : 'status_banner_degraded';
      // data-i18n lets applyTranslations() re-render the text when the locale loads or changes.
      bannerEl.dataset.i18n = key;
      bannerEl.textContent = key === 'status_banner_down'
        ? t(key, 'WARP-endpoint не проходят проверку — генерация может не сработать')
        : t(key, 'Часть WARP-endpoint не проходит проверку — генерация может работать нестабильно');
      bannerEl.hidden = false;
    } else {
      delete bannerEl.dataset.i18n;
      bannerEl.hidden = true;
    }
  } catch {
    // Silent — don't show banner on network error
  }
};

const readSavedLang = () => {
  try {
    const saved = localStorage.getItem('lang');
    return isKnownLang(saved) ? saved : null;
  } catch {
    return null;
  }
};

const navigateToLang = (lang) => {
  window.location.assign(LANG_PATHS[lang] + window.location.search + window.location.hash);
};

/**
 * Инициализирует i18n. Язык задаёт адрес страницы (/ — ru, /en — en), а не язык браузера:
 * поисковый робот всегда видит язык адреса. Явный выбор посетителя из localStorage
 * переводит его на адрес нужного языка. Вызывается один раз при DOMContentLoaded.
 */
const initI18n = () => {
  const saved = readSavedLang();
  if (saved && saved !== PAGE_LANG) {
    navigateToLang(saved);
    return;
  }
  loadLocale(PAGE_LANG);
};

/** Переключает язык: сохраняет выбор и открывает адрес выбранного языка. */
const switchLang = (lang) => {
  if (!isKnownLang(lang)) return;
  try {
    localStorage.setItem('lang', lang);
  } catch {
    // Без localStorage выбор просто не запомнится
  }
  if (lang === PAGE_LANG) {
    loadLocale(lang);
    return;
  }
  navigateToLang(lang);
};

// ─────────────────────────────────────────────────────────────
// Модальные окна (каркас, ловушка фокуса и ESC — в ui-shell.js)
// ─────────────────────────────────────────────────────────────

const uiShell = window.UiShell || null;

/** Открывает модальное окно по id; после закрытия фокус вернётся на opener. */
const openModal = (id, opener) => {
  if (uiShell) {
    uiShell.openModal(id, opener);
    return;
  }
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('is-open');
  el.setAttribute('aria-hidden', 'false');
};

const toast = (text) => {
  if (uiShell) uiShell.toast(text);
};

/** Копирует текст в буфер; без Clipboard API (http, старые браузеры) — через выделение. */
const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
};

const makeIcon = (id, cls = 'icon') => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.appendChild(use);
  return svg;
};

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── Превью конфига: PrivateKey маскируется только на экране ──

const SECRET_MASK = '••••••••••••••••';

/** HTML конфига с подсветкой секций; значение PrivateKey заменено маской. Всё экранировано. */
const renderConfigHtml = (configText) => configText.split(/\r?\n/).map((line) => {
  if (/^\s*\[[^\]]+\]\s*$/.test(line)) return `<span class="c-section">${escapeHtml(line)}</span>`;
  if (/^\s*#/.test(line)) return `<span class="c-comment">${escapeHtml(line)}</span>`;
  const m = /^(\s*)([A-Za-z0-9]+)(\s*=\s*)(.*)$/.exec(line);
  if (!m) return escapeHtml(line);
  const value = /^privatekey$/i.test(m[2])
    ? `<span class="c-mask">${SECRET_MASK}</span>`
    : escapeHtml(m[4]);
  return `${escapeHtml(m[1])}<span class="c-key">${escapeHtml(m[2])}</span>${escapeHtml(m[3])}${value}`;
}).join('\n');

/** vpn://-ссылка кодирует весь конфиг вместе с ключом: на экране — только начало. */
const renderVpnLinkHtml = (link) => `${escapeHtml(link.slice(0, 28))}<span class="c-mask">${SECRET_MASK}</span>`;

let previewConfigText = '';

/** Открывает предпросмотр конфига: на экране ключ скрыт, «Копировать» отдаёт полный текст. */
const openPreviewModal = (decodedConfig, filename, opener) => {
  previewConfigText = decodedConfig;
  const code = document.getElementById('configPreviewCode');
  if (code) code.innerHTML = renderConfigHtml(decodedConfig);
  const name = document.getElementById('previewFileName');
  if (name && filename) name.textContent = filename;
  openModal('configPreviewModal', opener);
};

// ── Статус сервисов (live: /api/status + /api/healthcheck) ──

const formatMoscowTime = (isoStr) => {
  const d = new Date(isoStr);
  if (isNaN(d)) return isoStr;
  return d.toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }) + t('status_msk_suffix', ' (МСК)');
};

const getLiveStatusLabels = () => {
  const base = window.LiveStatus.DEFAULT_LABELS;
  return {
    ...base,
    names: {
      ...base.names,
      warp_engage: t('status_engage_name', base.names.warp_engage),
      cidr_source: t('status_cidr_name', base.names.cidr_source),
      endpoint_pool: t('status_pool_name', base.names.endpoint_pool),
    },
    statusText: {
      ok:       t('status_ok',       base.statusText.ok),
      error:    t('status_error',    base.statusText.error),
      degraded: t('status_degraded', base.statusText.degraded),
      unknown:  t('status_unknown',  base.statusText.unknown),
    },
    latency:      t('status_latency',      base.latency),
    unreachable:  t('status_unreachable',  base.unreachable),
    poolDetail:   t('status_pool_detail',  base.poolDetail),
    poolFallback: t('status_pool_fallback', base.poolFallback),
    poolUnmeasured: t('status_pool_unmeasured', base.poolUnmeasured),
  };
};

const renderStatusModalLoading = () => {
  const content     = document.getElementById('statusModalContent');
  const lastChecked = document.getElementById('statusModalLastChecked');
  if (content) { content.className = 'status-loading-msg'; content.textContent = t('status_loading', 'Загрузка...'); }
  if (lastChecked) lastChecked.hidden = true;
};

const renderStatusModal = (snapshot) => {
  const content     = document.getElementById('statusModalContent');
  const lastChecked = document.getElementById('statusModalLastChecked');
  if (!content) return;
  content.className = '';
  content.innerHTML = window.LiveStatus.renderCardsHtml(snapshot, getLiveStatusLabels());
  if (lastChecked) {
    lastChecked.hidden = false;
    lastChecked.textContent = '';
    const label = document.createElement('strong');
    label.textContent = t('status_last_checked_label', 'Последняя проверка:');
    lastChecked.append(label, document.createElement('br'), formatMoscowTime(snapshot.checkedAt),
      document.createElement('br'), t('status_auto_refresh', 'Обновляется автоматически раз в минуту, пока вкладка открыта.'));
  }
};

const formatMoscowClock = (ms) => new Date(ms).toLocaleTimeString('ru-RU', {
  timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', second: '2-digit',
}) + t('status_msk_suffix', ' (МСК)');

const renderStatusModalError = (err, { retryAt = null } = {}) => {
  const content     = document.getElementById('statusModalContent');
  const lastChecked = document.getElementById('statusModalLastChecked');
  if (lastChecked) lastChecked.hidden = true;
  if (!content) return;
  const reason = {
    timeout:      t('status_reason_timeout', 'сервер не ответил вовремя'),
    rate_limited: t('status_reason_rate_limited', 'слишком много запросов'),
  }[err && err.kind] || t('status_reason_other', 'не удалось получить актуальные данные');
  content.className = 'status-error-msg';
  content.textContent = '';
  const title = document.createElement('strong');
  title.textContent = t('status_unavailable', 'Статус временно недоступен');
  content.append(title, document.createElement('br'), reason);
  if (retryAt != null) {
    content.append(document.createElement('br'),
      t('status_retry_at', 'Следующая попытка около {time}.').replace('{time}', formatMoscowClock(retryAt)));
  }
};

// ── Карточка «Статус системы» в hero ──
// Один поллер на страницу кормит и карточку, и модал статуса: раз в минуту, пока вкладка
// видима, с паузой по Retry-After (createPoller). Отдельного опроса /api/healthcheck больше нет.

let statusPoller = null;
/** @type {{ kind: 'loading' } | { kind: 'data', snapshot: object, at: number } | { kind: 'error', error: Error, at: number }} */
let heroStatus = { kind: 'loading' };

const HERO_STATUS_ROWS = [
  { key: 'generator', label: ['status_row_generator', 'Генератор API'] },
  { key: 'warp_api', label: ['status_row_warp_api', 'Регистрация WARP'] },
  { key: 'warp_engage', label: ['status_row_engage', 'WARP endpoint'] },
  { key: 'endpoint_pool', label: ['status_row_pool', 'Пул endpoint\'ов'] },
  { key: 'cidr_source', label: ['status_row_cidr', 'Источник CIDR'], optional: true },
];

const STATE_ICONS = { ok: 'i-check', degraded: 'i-alert', error: 'i-x', unknown: 'i-help' };

const getStateLabel = (state) => ({
  ok: t('status_state_ok', 'Работает'),
  degraded: t('status_state_degraded', 'Нестабильно'),
  error: t('status_state_error', 'Недоступен'),
  unknown: t('status_state_unknown', 'Нет данных'),
}[state] || t('status_state_unknown', 'Нет данных'));

const OVERALL_LABELS = {
  ok: ['status_overall_ok', 'Всё работает'],
  degraded: ['status_overall_degraded', 'Есть сбои'],
  error: ['status_overall_error', 'Сервис недоступен'],
  unknown: ['status_overall_unknown', 'Нет данных'],
  loading: ['status_checking', 'Проверяем…'],
};

/** Сервер ответил, но данные не годятся (лимит, устаревшие) — это не «недоступен». */
const generatorStateForError = (error) => (
  ['network', 'timeout', 'http'].includes(error && error.kind) ? 'error' : 'unknown'
);

const computeOverall = (states) => {
  const measured = states.filter((s) => s !== 'unknown');
  if (!measured.length) return 'unknown';
  if (measured.every((s) => s === 'error')) return 'error';
  if (measured.some((s) => s === 'error' || s === 'degraded')) return 'degraded';
  return 'ok';
};

/** Текст с ключом перевода: applyTranslations() перерисует его при смене языка. */
const setI18nText = (el, key, fallback) => {
  if (!el) return;
  el.dataset.i18n = key;
  el.textContent = t(key, fallback);
};

const renderHeroStatus = () => {
  const list = document.getElementById('statusList');
  if (!list) return;

  let rows;
  if (heroStatus.kind === 'data') {
    const byKey = Object.fromEntries(heroStatus.snapshot.services.map((svc) => [svc.key, svc.status]));
    rows = HERO_STATUS_ROWS
      .filter((row) => !row.optional || byKey[row.key])
      .map((row) => ({ ...row, state: row.key === 'generator' ? 'ok' : (byKey[row.key] || 'unknown') }));
  } else if (heroStatus.kind === 'error') {
    const generator = generatorStateForError(heroStatus.error);
    rows = HERO_STATUS_ROWS
      .filter((row) => !row.optional)
      .map((row) => ({ ...row, state: row.key === 'generator' ? generator : 'unknown' }));
  } else {
    rows = HERO_STATUS_ROWS.filter((row) => !row.optional).map((row) => ({ ...row, state: 'loading' }));
  }

  list.textContent = '';
  rows.forEach((row) => {
    const li = document.createElement('li');
    li.className = 'status-row';
    const icon = document.createElement('span');
    icon.className = `state-icon state-icon--${row.state}`;
    if (row.state !== 'loading') icon.appendChild(makeIcon(STATE_ICONS[row.state]));
    const name = document.createElement('span');
    name.className = 'status-row__name';
    setI18nText(name, row.label[0], row.label[1]);
    const state = document.createElement('span');
    state.className = `status-row__state status-row__state--${row.state}`;
    if (row.state !== 'loading') state.textContent = getStateLabel(row.state);
    li.append(icon, name, state);
    list.appendChild(li);
  });

  const overall = heroStatus.kind === 'loading' ? 'loading' : computeOverall(rows.map((row) => row.state));
  const dotClass = `dot dot--${overall === 'unknown' ? 'unknown' : overall}`;
  const overallEl = document.getElementById('statusOverall');
  if (overallEl) {
    overallEl.className = `status-overall status-overall--${overall}`;
    const dot = overallEl.querySelector('.dot');
    if (dot) dot.className = dotClass;
  }
  const [labelKey, labelFallback] = OVERALL_LABELS[overall];
  setI18nText(document.getElementById('statusOverallText'), labelKey, labelFallback);
  setI18nText(document.getElementById('statusStripText'), labelKey, labelFallback);
  const stripDot = document.getElementById('statusStripDot');
  if (stripDot) stripDot.className = dotClass;

  // Предупреждение над шагами — только о реальных проблемах, без ложных тревог.
  const warnEl = document.getElementById('healthWarn');
  if (warnEl) {
    const apiDown = rows.some((row) => row.key === 'warp_api' && row.state === 'error');
    const serverDown = rows.some((row) => row.key === 'generator' && row.state === 'error');
    if (serverDown) {
      setI18nText(warnEl, 'health_warn_server', 'Сервер генератора недоступен — попробуйте позже.');
      warnEl.hidden = false;
    } else if (apiDown) {
      setI18nText(warnEl, 'health_warn_api', 'Cloudflare API недоступен — генерация может не сработать.');
      warnEl.hidden = false;
    } else {
      warnEl.hidden = true;
    }
  }
  renderHeroCheckedAt();
};

const renderHeroCheckedAt = () => {
  const el = document.getElementById('statusCheckedAt');
  if (!el) return;
  if (heroStatus.kind === 'loading') {
    setI18nText(el, 'status_not_checked', 'Проверка…');
    return;
  }
  const minutes = Math.floor((Date.now() - heroStatus.at) / 60_000);
  delete el.dataset.i18n;
  el.textContent = minutes < 1
    ? t('status_checked_just_now', 'Проверено только что')
    : t('status_checked_minutes', 'Проверено {n} мин назад').replace('{n}', String(minutes));
};

const initHeroStatus = () => {
  if (!window.LiveStatus) {
    heroStatus = { kind: 'error', error: new Error('live-status.js not loaded'), at: Date.now() };
    renderHeroStatus();
    renderStatusModalError(heroStatus.error);
    return;
  }
  statusPoller = window.LiveStatus.createPoller({
    load: () => window.LiveStatus.loadSnapshot(),
    onLoading: () => {
      heroStatus = { kind: 'loading' };
      renderHeroStatus();
      renderStatusModalLoading();
    },
    onData: (snapshot) => {
      heroStatus = { kind: 'data', snapshot, at: Date.now() };
      renderHeroStatus();
      renderStatusModal(snapshot);
    },
    onError: (error, meta) => {
      heroStatus = { kind: 'error', error, at: Date.now() };
      renderHeroStatus();
      renderStatusModalError(error, meta);
    },
  });
  statusPoller.start();
  // Только подпись «Проверено N мин назад» — без сетевых запросов.
  setInterval(renderHeroCheckedAt, 30_000);
};

/** Ручное обновление: перезапуск поллера соблюдает минимальный интервал между запросами. */
const refreshHeroStatus = () => {
  if (!statusPoller) return;
  statusPoller.stop();
  statusPoller.start();
};

/** Открывает модал статуса; данные приходят от того же поллера, что и у карточки. */
const openStatusModal = (opener) => {
  openModal('statusModal', opener);
  telemetry.trackEvent('status_modal_opened');
  if (heroStatus.kind === 'data') renderStatusModal(heroStatus.snapshot);
  else if (heroStatus.kind === 'error') renderStatusModalError(heroStatus.error);
};

// ─────────────────────────────────────────────────────────────
// Панель результата: загрузка → успех (варианты, превью, действия) / ошибка
// ─────────────────────────────────────────────────────────────

/**
 * @type {null | {
 *   mode: string,
 *   variants: Array<{ filename: string, decodedConfig: string, vpnLink: string | null }>,
 *   active: number,
 *   tab: 'conf' | 'link',
 *   hasWarnings: boolean,
 *   telemetryContext: Record<string, unknown>,
 *   snapshot: ReturnType<typeof getResultStateSnapshot>,
 * }}
 */
let currentResult = null;
let progressTimer = null;

const showResultView = (view) => {
  const panel = document.getElementById('resultPanel');
  if (!panel) return;
  panel.hidden = false;
  document.getElementById('resultLoading').hidden = view !== 'loading';
  document.getElementById('resultError').hidden = view !== 'error';
  document.getElementById('resultSuccess').hidden = view !== 'success';
};

const scrollResultIntoView = () => {
  const panel = document.getElementById('resultPanel');
  if (!panel) return;
  const rect = panel.getBoundingClientRect();
  if (rect.top < 0 || rect.top > window.innerHeight * 0.75) {
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
};

/** Этапы в карточке загрузки — ориентир для пользователя, а не точный прогресс сервера. */
const startResultProgress = () => {
  const items = Array.from(document.querySelectorAll('#resultProgress li'));
  let step = 0;
  const paint = () => items.forEach((li, i) => {
    li.classList.toggle('is-done', i < step);
    li.classList.toggle('is-active', i === step);
  });
  paint();
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    if (step < items.length - 1) {
      step += 1;
      paint();
    }
  }, 1400);
};

const stopResultProgress = () => {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = null;
};

const showResultLoading = () => {
  showResultView('loading');
  startResultProgress();
  scrollResultIntoView();
};

const showResultError = (message) => {
  stopResultProgress();
  const text = document.getElementById('resultErrorText');
  if (text) text.textContent = message;
  showResultView('error');
};

const activeVariant = () => (currentResult ? currentResult.variants[currentResult.active] : null);

const getDeviceLabel = (mobile, router) => {
  if (mobile && router) return t('device_mobile_router', 'Смартфон + роутер');
  if (mobile) return t('device_mobile', 'Смартфон');
  if (router) return t('device_router', 'Роутер');
  return t('device_universal', 'Универсальный');
};

const getDnsLabel = (id) => {
  const preset = cfgState.dnsPresets.find((d) => d.id === id);
  if (preset) return preset.label.replace(/\s*\(.*\)\s*$/, '');
  // Каталог пресетов ещё не загружен: показываем id с заглавной буквы
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Cloudflare';
};

const appendQuickSummary = (list, icon, label, value, isOn = false) => {
  const item = document.createElement('div');
  item.className = 'summary-item';
  const term = document.createElement('dt');
  term.textContent = label;
  const desc = document.createElement('dd');
  desc.textContent = value;
  desc.title = value;
  if (isOn) desc.classList.add('is-on');
  item.append(makeIcon(icon), term, desc);
  list.appendChild(item);
};

const renderQuickSummary = () => {
  const list = document.getElementById('resultQuickSummary');
  if (!list || !currentResult) return;
  const snap = currentResult.snapshot;
  const summary = lastResultSummary;
  list.textContent = '';

  const endpoint = summary
    ? summaryValue('endpointMode', summary.endpoint.mode)
    : (snap.warpEndpoint === 'hostname' ? t('chip_endpoint_auto', 'Автовыбор') : snap.warpEndpoint);
  const routes = snap.routeMode === ROUTE_MODES.SPLIT
    ? `${t('routing_mode_split', 'Выборочная')} · ${snap.routePresets.length}`
    : t('routing_mode_full', 'Полный туннель');
  const port = summary && summary.port != null ? String(summary.port) : String(snap.port);
  const ipv6On = summary ? summary.ipv6 === 'enabled' : snap.includeIpv6;
  const ipv6 = summary ? summaryValue('ipv6', summary.ipv6) : (ipv6On ? t('chip_on', 'Включён') : t('chip_off', 'Выключен'));
  const warnings = summary ? summary.warnings.length : 0;

  appendQuickSummary(list, 'i-shield-check', t('result_summary_profile_label', 'Профиль'), getModeLabel(currentResult.mode));
  appendQuickSummary(list, 'i-plug', t('chip_port', 'Порт WARP'), port);
  appendQuickSummary(list, 'i-pin', 'Endpoint', endpoint);
  appendQuickSummary(list, 'i-network', 'IPv6', ipv6, ipv6On);
  appendQuickSummary(list, 'i-route', t('routing_mode_title', 'Маршрутизация'), routes);
  appendQuickSummary(list, 'i-laptop', t('chip_device', 'Устройство'), getDeviceLabel(snap.mobileMode, snap.routerMode));
  appendQuickSummary(list, 'i-globe', 'DNS', getDnsLabel(snap.dns));
  appendQuickSummary(list, 'i-alert', t('result_summary_warnings', 'Предупреждения'),
    warnings ? String(warnings) : t('result_no_warnings', 'Нет'));
};

const renderResultCode = () => {
  const code = document.getElementById('resultCode');
  const note = document.getElementById('resultCodeNote');
  const variant = activeVariant();
  if (!code || !variant) return;
  const linkTab = currentResult.tab === 'link';
  if (linkTab && variant.vpnLink) {
    code.classList.add('code-block--wrap');
    code.innerHTML = renderVpnLinkHtml(variant.vpnLink);
    setI18nText(note, 'result_link_note', 'Ссылка содержит ключ, поэтому показано только начало. «Копировать» скопирует её целиком.');
  } else {
    code.classList.remove('code-block--wrap');
    code.innerHTML = renderConfigHtml(variant.decodedConfig);
    setI18nText(note, 'result_code_note', 'PrivateKey скрыт в превью. Скачивание и копирование отдают полный конфиг.');
  }
};

const renderResultSuccess = () => {
  if (!currentResult) return;
  stopResultProgress();
  const variant = activeVariant();

  const badge = document.getElementById('resultBadge');
  if (badge) badge.classList.toggle('result__badge--warn', currentResult.hasWarnings);
  const title = document.getElementById('resultTitle');
  if (currentResult.hasWarnings) setI18nText(title, 'result_warn_title', 'Готово, но есть предупреждения');
  else setI18nText(title, 'result_ready_title', 'Конфигурация готова!');
  const subtitle = document.getElementById('resultSubtitle');
  if (subtitle) {
    subtitle.textContent = t('result_ready_subtitle', 'Профиль {mode} успешно сгенерирован.')
      .replace('{mode}', getModeLabel(currentResult.mode));
  }

  // Переключатель вариантов (count = 2–3)
  const variantsWrap = document.getElementById('resultVariants');
  const variantButtons = document.getElementById('resultVariantButtons');
  if (variantsWrap && variantButtons) {
    variantButtons.textContent = '';
    variantsWrap.hidden = currentResult.variants.length < 2;
    currentResult.variants.forEach((_, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'seg__btn';
      btn.textContent = String(index + 1);
      btn.setAttribute('aria-pressed', String(index === currentResult.active));
      btn.addEventListener('click', () => {
        currentResult.active = index;
        renderResultSuccess();
      });
      variantButtons.appendChild(btn);
    });
  }

  // vpn:// бывает не у всех профилей (для AWG 3.0 намеренно недоступен)
  const copyLinkBtn = document.getElementById('resultCopyLink');
  const linkTab = document.getElementById('resultTabLink');
  const hasLink = !!(variant && variant.vpnLink);
  if (copyLinkBtn) copyLinkBtn.hidden = !hasLink;
  if (linkTab) linkTab.disabled = !hasLink;
  if (!hasLink && currentResult.tab === 'link') {
    currentResult.tab = 'conf';
    if (uiShell) uiShell.selectTab('resultTabConf');
  }

  renderQuickSummary();
  renderResultCode();
  showResultView('success');
};

/**
 * Показывает результат генерации.
 * @param {{ mode: string, variants: Array<{ filename: string, decodedConfig: string, vpnLink: string | null }>, hasWarnings: boolean, telemetryContext: Record<string, unknown>, snapshot: object }} result
 */
const showResult = (result) => {
  currentResult = { ...result, active: 0, tab: 'conf' };
  if (uiShell) uiShell.selectTab('resultTabConf');
  renderResultSuccess();
  scrollResultIntoView();
};

const initResultPanel = () => {
  document.getElementById('resultDownload')?.addEventListener('click', () => {
    const variant = activeVariant();
    if (!variant) return;
    downloadFile(variant.decodedConfig, variant.filename);
    telemetry.trackEvent('config_downloaded', currentResult.telemetryContext);
  });

  document.getElementById('resultCopyLink')?.addEventListener('click', async () => {
    const variant = activeVariant();
    if (!variant || !variant.vpnLink) return;
    if (await copyText(variant.vpnLink)) {
      telemetry.trackEvent('vpn_link_copied', currentResult.telemetryContext);
      toast(t('vpn_link_copied', 'Ссылка скопирована, откройте AmneziaVPN на телефоне.'));
    } else {
      toast(t('vpn_link_copy_failed', 'Не удалось скопировать ссылку.'));
    }
  });

  document.getElementById('resultCopyCode')?.addEventListener('click', async () => {
    const variant = activeVariant();
    if (!variant) return;
    const text = currentResult.tab === 'link' && variant.vpnLink ? variant.vpnLink : variant.decodedConfig;
    toast(await copyText(text) ? t('btn_copied', 'Скопировано!') : t('copy_failed', 'Не удалось скопировать.'));
  });

  document.getElementById('resultTabConf')?.closest('[role="tablist"]')?.addEventListener('tabs:change', (ev) => {
    if (!currentResult) return;
    currentResult.tab = ev.detail.tabId === 'resultTabLink' ? 'link' : 'conf';
    renderResultCode();
  });

  document.getElementById('resultMoreMenu')?.addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-result-action]');
    if (!item || !currentResult) return;
    const moreBtn = document.getElementById('resultMoreBtn');
    const variant = activeVariant();
    switch (item.dataset.resultAction) {
      case 'preview':
        openPreviewModal(variant.decodedConfig, variant.filename, moreBtn);
        telemetry.trackEvent('config_preview_opened', currentResult.telemetryContext);
        break;
      case 'explain':
        openModal('resultInfoModal', moreBtn);
        break;
      case 'compat': {
        const card = document.getElementById('compatibilityCard');
        if (card && !card.hidden) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          openModal('instructionModal', moreBtn);
        }
        break;
      }
      case 'regenerate':
        document.getElementById('generateButton')?.click();
        break;
      default:
        break;
    }
  });
};

const summaryValue = (key, value) => {
  const values = {
    format: {
      legacy: getModeLabel('legacy'),
      awg2: getModeLabel('awg2'),
      awg3: getModeLabel('awg3'),
      awg31: getModeLabel('awg31'),
      unknown: t('result_summary_no_data', 'нет данных'),
    },
    endpointMode: {
      hostname: t('result_summary_endpoint_hostname', 'hostname'),
      auto: t('result_summary_endpoint_auto', 'auto'),
      manual: t('result_summary_endpoint_manual', 'manual'),
      unknown: t('result_summary_no_data', 'нет данных'),
    },
    endpointSource: {
      hostname: t('result_summary_endpoint_hostname', 'hostname'),
      manual: t('result_summary_endpoint_manual', 'manual'),
      tcpCheck: t('result_summary_endpoint_tcp_check', 'встроенный список, проверка TCP'),
      fallback: t('result_summary_endpoint_fallback', 'fallback'),
      unknown: t('result_summary_no_data', 'нет данных'),
    },
    routesSource: {
      opencck: 'OpenCCK',
      community: t('result_summary_routes_community', 'community lists'),
      antifilter: 'antifilter',
      staticFallback: t('result_summary_routes_static_fallback', 'static fallback'),
      notApplicable: t('result_summary_not_applicable', 'не применяется'),
      unknown: t('result_summary_no_data', 'нет данных'),
    },
    routeMode: {
      full: t('result_summary_route_full', 'full route'),
      split: t('result_summary_route_split', 'выборочная'),
    },
    profile: {
      mobile: 'mobile',
      router: 'router',
      mobileRouter: 'mobile + router',
      standard: t('result_summary_profile_standard', 'standard'),
      unknown: t('result_summary_no_data', 'нет данных'),
    },
    ipv6: {
      enabled: t('result_summary_ipv6_enabled', 'включён'),
      disabled: t('result_summary_ipv6_disabled', 'отключён'),
      disabledByMobile: t('result_summary_ipv6_disabled_mobile', 'отключён mobile-профилем'),
      unknown: t('result_summary_no_data', 'нет данных'),
    },
    vpnImport: {
      available: t('result_summary_import_available', 'vpn:// доступен'),
      notRequested: t('result_summary_import_not_requested', 'не запрошен'),
      unknown: t('result_summary_no_data', 'нет данных'),
    },
  };
  return values[key]?.[value] ?? t('result_summary_no_data', 'нет данных');
};

const warningText = (warning) => {
  const byCode = {
    partial_generation: t('risk_partial_generation', 'Создано меньше вариантов, чем запрошено.'),
    no_configs: t('risk_no_configs', 'Генерация не вернула ни одного конфига.'),
    endpoint_fallback: t('risk_endpoint_fallback', 'Использован fallback-источник endpoint.'),
    endpoint_unknown: t('risk_endpoint_unknown', 'Источник endpoint не указан.'),
    allowed_ips_limit_disabled: t('risk_limit_disabled', 'Лимит AllowedIPs отключён.'),
    routes_fallback: t('risk_routes_fallback', 'Использован резервный источник маршрутов.'),
    routes_unknown: t('risk_routes_unknown', 'Источник маршрутов не указан.'),
  };
  return byCode[warning.code] || warning.message || t('result_summary_no_data', 'нет данных');
};

const appendSummaryField = (container, label, value) => {
  const row = document.createElement('div');
  row.className = 'result-summary-card__field';
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value;
  row.append(term, description);
  container.appendChild(row);
};

const getModeLabel = (mode) => {
  const labels = {
    legacy: 'AWG 1.5',
    awg2: 'AWG 2.0',
    awg3: 'AWG 3.0',
    awg31: 'AWG 3.1',
  };
  return labels[mode] || t('result_summary_no_data', 'нет данных');
};

const getModeFilename = (mode) => ({
  legacy: 'AmneziaWarp.conf',
  awg2: 'AmneziaWarp-AWG2.conf',
  awg3: 'AmneziaWarp-AWG3.0.conf',
  awg31: 'AmneziaWarp-AWG3.1.conf',
}[mode] || 'AmneziaWarp.conf');
const getModeLoadingLabel = (mode) => t(`loading_${mode}`, `Генерация конфигурации (${getModeLabel(mode)})...`);
const getModeSuccessLabel = (mode) => t(`success_${mode}`, `Конфигурация ${getModeLabel(mode)} успешно сгенерирована.`);

const getModeBadgeClass = (mode) => {
  if (mode === 'awg2' || mode === 'awg3' || mode === 'awg31') {
    return `history-item__badge history-item__badge--${mode}`;
  }
  return 'history-item__badge history-item__badge--legacy';
};

const getAwgFeatureLabel = (feature) => ({
  'junk-packets': t('awg_feature_junk', 'Junk packets'),
  cps: t('awg_feature_cps', 'CPS packets'),
  'timing-ranges': t('awg_feature_timing', 'Рандомизация timing'),
  'persistent-keepalive-range': t('awg_feature_keepalive', 'Диапазон PersistentKeepalive'),
  'content-padding-addition': t('awg_feature_content_padding', 'ContentPaddingAddition'),
  'disable-cookies': t('awg_feature_disable_cookies', 'DisableCookies'),
  'header-protection': t('awg_feature_header_disabled', 'Header Protection отключён'),
  'message-padding': t('awg_feature_padding_disabled', 'S1-S4 padding отключён'),
  'dynamic-message-headers': t('awg_feature_headers_disabled', 'Dynamic H1-H4 отключён'),
  'random-trailers': t('awg_feature_trailers_disabled', 'RandomTrailers отключён'),
  'router-compatibility': t('awg_router_warning', 'Совместимость с роутерами зависит от реализации роутера'),
}[feature] || feature);

const getAwgCapabilityLabel = (capability) => ({
  contentPaddingAddition: t('awg_capability_content_padding', 'ContentPaddingAddition'),
  disableCookies: t('awg_capability_disable_cookies', 'DisableCookies'),
  randomTrailers: t('awg_capability_random_trailers', 'RandomTrailers'),
  headerProtectionKey: t('awg_capability_header_protection_key', 'HeaderProtectionKey'),
}[capability] || capability);

const getAwgEvidenceStatusLabel = (status) => ({
  verified: t('awg_evidence_status_verified', 'Verified'),
  'source-confirmed': t('awg_evidence_status_source_confirmed', 'Source-confirmed'),
  experimental: t('awg_evidence_status_experimental', 'Experimental'),
  'peer-dependent-disabled': t('awg_evidence_status_peer_dependent_disabled', 'Disabled: compatible peer required'),
  unknown: t('awg_evidence_status_unknown', 'Unknown'),
}[status] || t('awg_evidence_status_unknown', 'Unknown'));

const getAwgEffectiveStateLabel = (state) => ({
  active: t('awg_effective_state_active', 'active'),
  disabled: t('awg_effective_state_disabled', 'disabled'),
  blocked: t('awg_effective_state_blocked', 'blocked'),
}[state] || t('awg_effective_state_disabled', 'disabled'));

const formatAwgCapabilityEvidence = (capability) => {
  const parts = [
    getAwgEvidenceStatusLabel(capability.status),
    getAwgEffectiveStateLabel(capability.effectiveState),
  ];
  if (capability.effectiveValue) {
    parts.push(`${t('awg_effective_value', 'value')}: ${capability.effectiveValue}`);
  }
  return parts.join(' · ');
};

const appendAwgConstraint = (container, feature) => {
  const label = document.createElement('div');
  label.className = 'risk-label risk-label--info';
  const state = document.createElement('strong');
  state.textContent = t('awg_disabled_for_warp', 'Ограничение WARP');
  const message = document.createElement('span');
  message.textContent = getAwgFeatureLabel(feature);
  label.append(state, message);
  container.appendChild(label);
};

const renderResultExplanation = (summary) => {
  const fields = document.getElementById('resultSummaryFields');
  const risks = document.getElementById('resultRiskLabels');
  if (!fields || !risks || !summary) return;

  fields.textContent = '';
  risks.textContent = '';
  const endpointMode = summaryValue('endpointMode', summary.endpoint.mode);
  const endpointSource = summaryValue('endpointSource', summary.endpoint.source);
  const endpoint = endpointMode === endpointSource ? endpointMode : `${endpointMode} / ${endpointSource}`;
  const presetNames = summary.presets.length
    ? ` (${summary.presets.slice(0, 4).join(', ')}${summary.presets.length > 4 ? ', …' : ''})`
    : '';

  appendSummaryField(fields, t('result_summary_format', 'Формат'), summaryValue('format', summary.format));
  appendSummaryField(fields, t('result_summary_variants', 'Вариантов'), String(summary.variants));
  appendSummaryField(fields, t('result_summary_endpoint', 'Endpoint'), endpoint);
  appendSummaryField(
    fields,
    t('result_summary_port', 'Порт'),
    summary.port == null ? t('result_summary_no_data', 'нет данных') : String(summary.port),
  );
  appendSummaryField(fields, t('result_summary_routes_source', 'Маршруты'), summaryValue('routesSource', summary.routesSource));
  appendSummaryField(fields, t('result_summary_route_mode', 'Режим маршрутов'), summaryValue('routeMode', summary.routeMode));
  appendSummaryField(
    fields,
    t('result_summary_presets', 'Presets'),
    `${summary.presets.length}${presetNames}`,
  );
  appendSummaryField(fields, t('result_summary_profile', 'Профиль'), summaryValue('profile', summary.profile));
  appendSummaryField(fields, t('result_summary_ipv6', 'IPv6'), summaryValue('ipv6', summary.ipv6));
  const cpsValue = summary.cps.requested === 'auto'
    ? `Auto → ${summary.cps.resolved}${summary.cps.stability === 'experimental' ? ' (experimental)' : ''}`
    : `${summary.cps.resolved}${summary.cps.stability === 'experimental' ? ' (experimental)' : ''}`;
  appendSummaryField(fields, t('result_summary_cps', 'CPS'), cpsValue);
  appendSummaryField(fields, t('result_summary_import', 'Импорт'), summaryValue('vpnImport', summary.vpnImport));
  if (summary.awg) {
    appendSummaryField(
      fields,
      t('awg_profile_label', 'AWG-профиль'),
      `AWG ${summary.awg.version} ${t('awg_warp_safe', 'WARP-safe')}`,
    );
    appendSummaryField(
      fields,
      t('awg_enabled_features', 'Включено'),
      summary.awg.enabledFeatures.map(getAwgFeatureLabel).join(', '),
    );
    summary.awg.disabledFeatures.forEach((feature) => appendAwgConstraint(risks, feature));
    if (summary.awg.experimentalFeatures.length) {
      appendSummaryField(
        fields,
        t('awg_experimental_features', 'Экспериментально'),
        summary.awg.experimentalFeatures.map(getAwgFeatureLabel).join(', '),
      );
    }
    if (summary.awg.capabilities && Object.keys(summary.awg.capabilities).length) {
      appendSummaryField(
        fields,
        t('awg_protocol_evidence', 'Protocol evidence'),
        t('awg_evidence_scope', 'Source-confirmed describes upstream behavior, not a live test on your network.'),
      );
      Object.entries(summary.awg.capabilities).forEach(([key, capability]) => {
        appendSummaryField(fields, getAwgCapabilityLabel(key), formatAwgCapabilityEvidence(capability));
      });
    }
    appendSummaryField(
      fields,
      t('awg_client_compatibility', 'Совместимость клиента'),
      summary.awg.version === '3.1'
        ? t('awg31_client_warning', 'Рекомендуется AmneziaVPN 5.0.1.5+ или совместимый AWG 3.1 client.')
        : t('awg3_client_warning', 'Требуется клиент с поддержкой параметров AWG 3.x.'),
    );
    if (summary.awg.routerCompatibility) appendAwgConstraint(risks, 'router-compatibility');
  }
  appendSummaryField(fields, t('result_summary_warnings', 'Предупреждения'), String(summary.warnings.length));

  if (!summary.warnings.length) {
    const calm = document.createElement('p');
    calm.className = 'result-risk-list__empty';
    calm.textContent = t('risk_no_critical_warnings', 'Критичных предупреждений нет.');
    risks.appendChild(calm);
  } else {
    summary.warnings.forEach((warning) => {
      const label = document.createElement('div');
      label.className = `risk-label risk-label--${warning.level}`;
      const level = document.createElement('strong');
      level.textContent = t(`risk_${warning.level}`, warning.level);
      const message = document.createElement('span');
      message.textContent = warningText(warning);
      label.append(level, message);
      risks.appendChild(label);
    });
  }
};

// ── Compatibility card (2.7.0) ────────────────────────────────────────────────

/** Maps canonical server-side format ids to display labels. */
const COMPAT_FORMAT_LABELS = { conf: '.conf', vpnlink: 'vpn://', qr: 'QR' };

/**
 * Localizes a fixed English server string (warning or reason) via a known-prefix
 * lookup. Falls back to the original string, which is always secret-free.
 */
const localizeCompatText = (text) => {
  if (typeof text !== 'string') return '';
  const map = [
    ['AmneziaWG fields are client-side configuration parameters', 'compat_cloudflare_peer_notice'],
    ['Compatibility depends on the client', 'compat_client_version_warning'],
    ['This format does not have a stable exporter', 'compat_unsupported_exporter_warning'],
    ['Direct export is not implemented', 'compat_reason_no_exporter'],
    ['Research/documentation target only', 'compat_reason_research'],
    ['No supported import path', 'compat_reason_no_path'],
  ];
  for (const [prefix, key] of map) {
    if (text.startsWith(prefix)) return t(key, text);
  }
  return text;
};

const compatListItem = (primary, secondary) => {
  const li = document.createElement('li');
  li.className = 'compat-card__item';
  const name = document.createElement('span');
  name.className = 'compat-card__client';
  name.textContent = primary;
  li.appendChild(name);
  if (secondary) {
    const meta = document.createElement('span');
    meta.className = 'compat-card__meta';
    meta.textContent = secondary;
    li.appendChild(meta);
  }
  return li;
};

const fillCompatGroup = (groupId, listId, items, buildItem) => {
  const group = document.getElementById(groupId);
  const list = document.getElementById(listId);
  if (!group || !list) return;
  list.textContent = '';
  if (!Array.isArray(items) || items.length === 0) {
    group.hidden = true;
    return;
  }
  items.forEach((entry) => list.appendChild(buildItem(entry)));
  group.hidden = false;
};

/**
 * Renders the post-generation compatibility card from the /api/warp
 * `compatibility` summary. When the summary is missing/invalid, the card is
 * hidden and generation actions (download/preview/vpn://) keep working.
 */
const renderCompatibilityCard = (compatibility) => {
  const card = document.getElementById('compatibilityCard');
  if (!card) return;

  const valid = compatibility
    && typeof compatibility === 'object'
    && (Array.isArray(compatibility.recommended)
      || Array.isArray(compatibility.experimental)
      || Array.isArray(compatibility.notRecommended));

  if (!valid) {
    card.hidden = true;
    return;
  }

  const recommended = compatibility.recommended || [];
  const experimental = compatibility.experimental || [];
  const notRecommended = compatibility.notRecommended || [];
  const warnings = compatibility.warnings || [];

  // Format line: union of usable exports across recommended + experimental.
  const formatEl = document.getElementById('compatFormat');
  if (formatEl) {
    const formats = new Set();
    [...recommended, ...experimental].forEach((c) => {
      (c.exports || []).forEach((ex) => formats.add(COMPAT_FORMAT_LABELS[ex] || ex));
    });
    if (formats.size === 0) formats.add('.conf');
    formatEl.textContent = `${t('compat_format', 'Формат')}: ${[...formats].join(', ')}`;
  }

  fillCompatGroup('compatRecommended', 'compatRecommendedList', recommended, (c) => {
    const platforms = (c.platforms || []).join(', ');
    return compatListItem(c.name || c.clientId, platforms);
  });

  fillCompatGroup('compatExperimental', 'compatExperimentalList', experimental, (c) => {
    const warn = (c.warnings || [])[0];
    return compatListItem(c.name || c.clientId, warn ? localizeCompatText(warn) : '');
  });

  fillCompatGroup('compatNotRecommended', 'compatNotRecommendedList', notRecommended, (c) => (
    compatListItem(c.name || c.clientId, localizeCompatText(c.reason || ''))
  ));

  const warnEl = document.getElementById('compatWarnings');
  if (warnEl) {
    warnEl.textContent = '';
    if (warnings.length) {
      warnings.forEach((w) => {
        const p = document.createElement('p');
        p.className = 'compat-card__warning';
        p.textContent = localizeCompatText(w);
        warnEl.appendChild(p);
      });
      warnEl.hidden = false;
    } else {
      warnEl.hidden = true;
    }
  }

  card.hidden = false;
};

const getResultStateSnapshot = () => ({
  configCount: cfgState.configCount,
  warpEndpoint: cfgState.warpEndpoint,
  port: cfgState.port,
  routePresets: getSelectedRouteIds(),
  dns: getSelectedDnsKey(),
  mobileMode: cfgState.mobileMode,
  routerMode: cfgState.routerMode,
  routeMode: cfgState.routeMode,
  includeIpv6: cfgState.includeIpv6,
  ignoreLimit: cfgState.ignoreLimit,
  vpnLinkRequested: true,
});

const API_WARP_TIMEOUT_MS = 120000;

/**
 * Maximum safe number of IPv4 CIDR routes in AllowedIPs.
 * Above this threshold routers and low-memory devices (GL.iNet, Keenetic, MikroTik)
 * may fail to apply the routing table. 500 is a conservative limit that works reliably
 * on all tested platforms. Users are warned at 80 % and blocked at 100 %.
 */
const MAX_CIDR_LIMIT = 1000;

/** Routing mode enum. Always use these constants — never bare string literals. */
const ROUTE_MODES = Object.freeze({ FULL: 'full', SPLIT: 'split' });

const TG_CHANNEL_URL = 'https://t.me/amnezia_config';

/**
 * @param {Response} response
 * @returns {Promise<Record<string, unknown>>}
 */
const parseJsonResponse = async (response) => {
  const raw = await response.text();
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    throw new Error(t('err_empty_response', 'Пустой ответ сервера.'));
  }
  const lower = trimmed.slice(0, 64).toLowerCase();
  if (
    trimmed.startsWith('<')
    || lower.includes('<!doctype')
    || lower.includes('<html')
  ) {
    throw new Error(t('err_html_response', 'Сервер вернул HTML вместо JSON (нет API). Запустите vercel dev или откройте задеплоенный сайт.'));
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(t('err_not_json', 'Ответ не похож на JSON. Проверьте доступность API.'));
  }
};

const debounce = (fn, delayMs) => {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, delayMs);
  };
};

/** @type {{ presets: Array<{id:string,label:string,category?:string,sitesCount?:number}>, groupRfPopular: string[], dnsPresets: Array<{id:string,label:string}>, dnsDefault: string, selectedDns: string, iplistSource: 'none' | 'api' | 'fallback', cidrCount4: number, includeIpv6: boolean }} */
const cfgState = {
  presets: [],
  groupRfPopular: [],
  dnsPresets: [],
  dnsDefault: 'cloudflare',
  selectedDns: '',
  iplistSource: 'none',
  /** Current IPv4 CIDR count for selected presets (updated after each fetch). */
  cidrCount4: 0,
  /** Whether IPv6 CIDRs should be included in the generated config. Off by default. */
  includeIpv6: false,
  /** When true the CIDR limit is not enforced — tiles are never disabled. */
  ignoreLimit: false,
  /** When true, router-safe caps are applied (Jc≤2, Jmin/Jmax≤128). */
  routerMode: false,
  /** CPS protocol for I1 field: auto | quic | dns | stun | dtls | sip | static */
  cpsProtocol: 'auto',
  /** Set of preset IDs confirmed to return 0 IPv4 CIDRs from opencck. */
  zeroCidrPresets: new Set(),
  warpPort: 4500,
  /** Allowlisted UDP port for WARP endpoint (mirrors cfgState.warpPort; kept in sync). */
  port: 4500,
  warpEndpoint: 'hostname',
  /** When true, server appends I2-I5 to AWG 2.0 [Interface]. */
  extraCps: false,
  /** When true, mobile preset (low Jc/Jmax, IPv4-only). */
  mobileMode: false,
  /** Explicit routing mode. 'full' = all traffic through tunnel; 'split' = only selected presets. */
  routeMode: ROUTE_MODES.FULL,
  /** Number of configs to generate (1–3). */
  configCount: 1,
};

const getPresetsFallbackUrl = () => {
  const el = document.querySelector('script[src*="script.js"]');
  if (el && el.src) {
    try {
      return new URL('presets-fallback.json', el.src).href;
    } catch {
      /* ignore */
    }
  }
  return new URL('/static/presets-fallback.json', window.location.href).href;
};

/**
 * Tries GET /api/iplist, then static presets-fallback.json next to script.js.
 * @returns {Promise<{ source: 'api' | 'fallback', data: Record<string, unknown> }>}
 */
const fetchPresetsManifest = async () => {
  let apiErr = null;
  try {
    const res = await fetch('/api/iplist');
    const data = await parseJsonResponse(res);
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    if (!data.success) throw new Error(data.message || 'Ошибка списка пресетов');
    return { source: 'api', data };
  } catch (e) {
    apiErr = e;
  }
  const fallbackUrl = getPresetsFallbackUrl();
  try {
    const res2 = await fetch(fallbackUrl, { cache: 'no-cache' });
    if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
    const parsed = JSON.parse((await res2.text()).trim());
    if (!Array.isArray(parsed.presets)) throw new Error('Некорректный fallback');
    return { source: 'fallback', data: parsed };
  } catch {
    throw apiErr;
  }
};

let presetStatsAbort = null;

const ROUTE_CATEGORY_ORDER = ['social', 'gaming', 'torrent', 'more'];

const ROUTE_CONTAINER_BY_CATEGORY = {
  social: 'routeTilesSocial',
  gaming: 'routeTilesGaming',
  torrent: 'routeTilesTorrent',
  more: 'routeTilesMore',
};

const ROUTE_TILE_ROOT_SELECTORS = ROUTE_CATEGORY_ORDER.map(
  (c) => `#${ROUTE_CONTAINER_BY_CATEGORY[c]} .cfg-tile`,
);

const ROUTE_CHECKBOX_SELECTOR = ROUTE_TILE_ROOT_SELECTORS.map(
  (s) => `${s} input[type="checkbox"]:checked`,
).join(', ');

const forEachRouteTile = (fn) => {
  ROUTE_TILE_ROOT_SELECTORS.forEach((sel) => {
    document.querySelectorAll(sel).forEach(fn);
  });
};

const clearAllRouteTileHosts = () => {
  ROUTE_CATEGORY_ORDER.forEach((c) => {
    const el = document.getElementById(ROUTE_CONTAINER_BY_CATEGORY[c]);
    if (el) el.textContent = '';
  });
};

const getSelectedRouteIds = () =>
  Array.from(document.querySelectorAll(ROUTE_CHECKBOX_SELECTOR)).map((el) => el.value);

const SETTINGS_TABS = { routes: 'tab-routes', dnscps: 'tab-dnscps', extra: 'tab-extra' };

/**
 * Открывает настройки на нужной вкладке (чипы шага 2 ведут каждый в свой раздел).
 * @param {{ tab?: string, focusId?: string, opener?: Element }} [options]
 */
const openSettingsModal = ({ tab = 'routes', focusId = null, opener = null } = {}) => {
  if (uiShell) uiShell.selectTab(SETTINGS_TABS[tab] || SETTINGS_TABS.routes);
  openModal('settingsModal', opener);
  document.getElementById('settingsToggle')?.setAttribute('aria-expanded', 'true');
  const target = focusId && document.getElementById(focusId);
  if (target) {
    target.scrollIntoView({ block: 'center' });
    if (!target.disabled) target.focus({ preventScroll: true });
  }
};

/** Значения чипов шага 2 — всегда фактическое состояние cfgState, а не картинка из макета. */
const updateParamChips = () => {
  const setChip = (id, text, modifier) => {
    const el = document.getElementById(id);
    if (!el) return;
    delete el.dataset.i18n;
    el.textContent = text;
    el.title = text;
    el.classList.toggle('param-chip__value--on', modifier === 'on');
    el.classList.toggle('param-chip__value--accent', modifier === 'accent');
  };

  const selectedCount = getSelectedRouteIds().length;
  setChip('chipRouting', cfgState.routeMode === ROUTE_MODES.SPLIT
    ? `${t('routing_mode_split', 'Выборочная')} · ${selectedCount}`
    : t('routing_mode_full', 'Полный туннель'));
  setChip('chipDns', getDnsLabel(getSelectedDnsKey() || cfgState.dnsDefault));
  setChip('chipEndpoint', cfgState.warpEndpoint === 'hostname'
    ? t('chip_endpoint_auto', 'Автовыбор')
    : cfgState.warpEndpoint, 'accent');
  setChip('chipPort', String(cfgState.port));
  setChip('chipIpv6', cfgState.includeIpv6 ? t('chip_on', 'Включён') : t('chip_off', 'Выключен'),
    cfgState.includeIpv6 ? 'on' : null);
  setChip('chipDevice', getDeviceLabel(cfgState.mobileMode, cfgState.routerMode));
};

/**
 * When mobile mode toggles, IPv6 routes must be off (server forces this anyway,
 * but the UI should reflect it). Disable the IPv6 checkbox while mobile is on,
 * and uncheck it. Restore interactivity when mobile is off.
 */
const applyMobileModeCascade = () => {
  const ipv6Toggle = document.getElementById('ipv6Toggle');
  if (!ipv6Toggle) return;
  if (cfgState.mobileMode) {
    if (cfgState.includeIpv6) {
      cfgState.includeIpv6 = false;
      ipv6Toggle.checked = false;
    }
    ipv6Toggle.disabled = true;
  } else {
    ipv6Toggle.disabled = false;
  }
};

const getSelectedDnsKey = () => cfgState.selectedDns || '';

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
  if (cfgState.warpEndpoint !== 'hostname') {
    params.set('peerEndpoint', `${cfgState.warpEndpoint}:${cfgState.port}`);
  }
  return params.toString();
};

/** Renders contextual AllowedIPs explanation based on current cfgState. */
const updateAllowedIpsExplanation = () => {
  const el = document.getElementById('allowedIpsExplanation');
  if (!el) return;

  const lines = [];

  if (cfgState.routeMode === ROUTE_MODES.FULL) {
    lines.push(t('routing_allowedips_full',
      'В AllowedIPs будет добавлен полный маршрут. Это направит весь поддерживаемый трафик через туннель.'));
  } else {
    lines.push(t('routing_allowedips_split',
      'В AllowedIPs попадут только сети выбранных направлений. Если нужный сайт не входит в выбранные presets, он может идти мимо туннеля.'));
    lines.push(t('routing_allowedips_limit',
      'Большие списки AllowedIPs могут нестабильно импортироваться или работать на телефонах и роутерах. Поэтому генератор предупреждает на 80% лимита и блокирует выбор при 1000 IPv4 CIDR, если не включён режим «Без лимита».'));
  }

  if (cfgState.ignoreLimit) {
    lines.push(t('routing_allowedips_nolimit',
      'Режим «Без лимита» снимает защитное ограничение, но не гарантирует, что клиент или роутер корректно обработает большой список маршрутов.'));
  }

  if (cfgState.mobileMode) {
    lines.push(t('routing_allowedips_mobile_ipv6',
      'Mobile-профиль принудительно отключает IPv6, чтобы снизить риск проблем на мобильных сетях и клиентах.'));
  }

  el.innerHTML = lines
    .map((line) => `<p class="allowed-ips-explanation__line">${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
    .join('');
};

/** Sets cfgState.routeMode and updates all UI state for the routes tab. */
const updateRouteModeUI = (mode) => {
  cfgState.routeMode = mode;

  document.getElementById('routeModeFull')
    ?.classList.toggle('route-mode-btn--active', mode === ROUTE_MODES.FULL);
  document.getElementById('routeModeSplit')
    ?.classList.toggle('route-mode-btn--active', mode === ROUTE_MODES.SPLIT);

  const desc = document.getElementById('routeModeDescription');
  if (desc) {
    desc.textContent = mode === ROUTE_MODES.FULL
      ? t('routing_mode_full_desc',
          'Весь поддерживаемый трафик будет направлен через WARP. Это рекомендуемый вариант, если не нужно выбирать отдельные сервисы.')
      : t('routing_mode_split_desc',
          'Через WARP пойдут только выбранные направления. Если нужный сайт не входит в выбранные presets, он может идти мимо туннеля.');
  }

  // Dim preset tiles in full tunnel mode (pointer-events: none via CSS class)
  document.getElementById('panel-routes')
    ?.classList.toggle('routes-panel--full-tunnel', mode === ROUTE_MODES.FULL);

  // Show "presets ignored" notice only when full + at least one preset is checked
  const ignoredNotice = document.getElementById('presetsIgnoredNotice');
  if (ignoredNotice) {
    ignoredNotice.hidden = !(mode === ROUTE_MODES.FULL && getSelectedRouteIds().length > 0);
  }

  // Update CIDR counter (full tunnel: "not applicable"; split: actual count)
  updateCidrCounter(mode === ROUTE_MODES.FULL ? 0 : cfgState.cidrCount4);

  updateAllowedIpsExplanation();
};

/** Update the CIDR counter element (#cidrCounter) and mini counter (#cidrCounterMini). */
const updateCidrCounter = (count4) => {
  const el = document.getElementById('cidrCounter');
  const mini = document.getElementById('cidrCounterMini');

  // Full tunnel: CIDR counter not applicable
  if (cfgState.routeMode === ROUTE_MODES.FULL) {
    if (el) el.textContent = t('routing_counter_not_applicable', 'IPv4 маршруты: не применяется');
    if (mini) mini.textContent = '';
    return;
  }

  if (cfgState.ignoreLimit) {
    if (el) {
      el.classList.remove('cidr-counter--warn', 'cidr-counter--over');
      el.innerHTML = `<span class="cidr-counter__label">${t('cidr_routes_prefix', 'IPv4 маршруты:')} ${count4} ${t('cidr_limit_disabled', '(лимит отключён)')}</span>`;
    }
    if (mini) { mini.textContent = `IPv4: ${count4}`; mini.className = 'cidr-counter-mini'; }
  } else {
    const pct = Math.min(count4 / MAX_CIDR_LIMIT, 1);
    const warn = count4 >= MAX_CIDR_LIMIT * 0.8 && count4 < MAX_CIDR_LIMIT;
    const over = count4 >= MAX_CIDR_LIMIT;
    if (el) {
      el.classList.toggle('cidr-counter--warn', warn);
      el.classList.toggle('cidr-counter--over', over);
      el.innerHTML = `
        <span class="cidr-counter__label">${t('cidr_routes_prefix', 'IPv4 маршруты:')} ${count4} / ${MAX_CIDR_LIMIT}</span>
        <div class="cidr-counter__bar-track">
          <div class="cidr-counter__bar-fill" style="width:${(pct * 100).toFixed(1)}%"></div>
        </div>`;
    }
    if (mini) {
      mini.textContent = `IPv4: ${count4} / ${MAX_CIDR_LIMIT}`;
      mini.className = 'cidr-counter-mini' + (over ? ' cidr-counter-mini--over' : warn ? ' cidr-counter-mini--warn' : '');
    }
  }
};

/**
 * Disable unchecked route tiles when the CIDR limit is reached (or re-enable when below).
 * Already-checked tiles stay interactive so the user can deselect them.
 * When cfgState.ignoreLimit is true, tiles are never disabled.
 */
const updateTileDisabledState = () => {
  const overLimit = !cfgState.ignoreLimit && cfgState.cidrCount4 >= MAX_CIDR_LIMIT;
  forEachRouteTile((tile) => {
    const cb = tile.querySelector('input[type="checkbox"]');
    if (!cb) return;
    if (!cb.checked) {
      cb.disabled = overLimit;
      tile.classList.toggle('cfg-tile--disabled', overLimit);
    } else {
      cb.disabled = false;
      tile.classList.remove('cfg-tile--disabled');
    }
  });
};

const refreshPresetStats = debounce(async () => {
  const el = document.getElementById('presetStats');
  if (!el) return;

  const selected = getSelectedRouteIds();
  if (!selected.length) {
    cfgState.cidrCount4 = 0;
    el.textContent = t('preset_none_selected', 'Пресеты не выбраны — весь трафик пойдёт через туннель.');
    el.classList.remove('preset-stats--warn');
    updateCidrCounter(0);
    updateTileDisabledState();
    return;
  }

  if (cfgState.iplistSource !== 'api') {
    el.textContent = t('preset_offline_warning', 'Пресеты выбраны из локального списка. Оценка CIDR и генерация конфига с AllowedIPs по пресетам нуждаются в API — запустите vercel dev или откройте задеплоенный сайт.');
    el.classList.add('preset-stats--warn');
    return;
  }

  if (presetStatsAbort) presetStatsAbort.abort();
  presetStatsAbort = new AbortController();

  el.textContent = t('preset_loading', 'Загрузка оценки маршрутов…');
  el.classList.remove('preset-stats--warn');

  try {
    const qs = new URLSearchParams();
    qs.set('presets', selected.join(','));
    if (cfgState.includeIpv6) qs.set('ipv6', '1');
    const res = await fetch(`/api/iplist?${qs.toString()}`, {
      signal: presetStatsAbort.signal,
    });
    const data = await parseJsonResponse(res);
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);

    const count4 = data.count4 ?? data.count;
    cfgState.cidrCount4 = count4;
    updateCidrCounter(count4);
    updateTileDisabledState();

    // Track presets that return 0 CIDRs when selected alone
    if (selected.length === 1) {
      const pid = selected[0];
      if (count4 === 0) cfgState.zeroCidrPresets.add(pid);
      else cfgState.zeroCidrPresets.delete(pid);
      applyZeroCidrMarks();
    }

    const cidrSource = data.cidrSource;
    const overLimit = !cfgState.ignoreLimit && count4 >= MAX_CIDR_LIMIT;
    if (overLimit) {
      el.classList.add('preset-stats--warn');
      el.textContent = `${t('cidr_routes_prefix', 'IPv4 маршруты:')} ${count4}/${MAX_CIDR_LIMIT} IPv4 CIDR. ${t('preset_over_limit_msg', 'Некоторые устройства могут работать нестабильно. Рекомендуется отключить часть категорий.')}`;
    } else if (cidrSource === 'antifilter') {
      el.classList.add('preset-stats--warn');
      el.textContent = `⚠ iplist.opencck.org недоступен — использован резервный источник antifilter.download (${count4} общих подсетей РФ). Маршруты могут быть неточными.`;
    } else if (cidrSource === 'mixed') {
      el.classList.add('preset-stats--warn');
      el.textContent = `⚠ Часть пресетов не найдена в opencck — дополнено из antifilter.download (${count4} IPv4). Некоторые маршруты могут быть неточными.`;
    } else {
      el.classList.remove('preset-stats--warn');
      const ipv6Info = cfgState.includeIpv6 && data.count6 ? `, IPv6: +${data.count6}` : '';
      const limitNote = cfgState.ignoreLimit && count4 >= MAX_CIDR_LIMIT ? t('preset_limit_warn_suffix', ' ⚠ лимит превышен') : '';
      el.textContent = `${t('cidr_routes_prefix', 'IPv4 маршруты:')} ${count4}${ipv6Info}${limitNote} (${data.sitesQueried}${t('tile_domains_suffix', ' доменов в запросе')}).`;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    el.textContent = t('preset_preview_fail_prefix', 'Предпросмотр недоступен: ') + (err.message || err);
    el.classList.add('preset-stats--warn');
  }
}, 480);

const updateTileActiveClass = (label) => {
  const input = label.querySelector('input');
  if (!input) return;
  label.classList.toggle('cfg-tile--active', input.checked);
};

/** Mark/unmark route tiles that are known to return 0 CIDRs. */
const applyZeroCidrMarks = () => {
  forEachRouteTile((tile) => {
    const cb = tile.querySelector('input[type="checkbox"]');
    if (!cb) return;
    const isZero = cfgState.zeroCidrPresets.has(cb.value);
    tile.classList.toggle('cfg-tile--zero-cidr', isZero);
    let warn = tile.querySelector('.cfg-tile__zero-warn');
    if (isZero && !warn) {
      warn = document.createElement('span');
      warn.className = 'cfg-tile__zero-warn';
      warn.textContent = '⚠ 0 IP';
      warn.title = t('tile_zero_cidr_title', 'Нет данных в iplist.opencck.org — маршруты не будут добавлены');
      tile.appendChild(warn);
    } else if (!isZero && warn) {
      warn.remove();
    }
  });
};

const renderDnsTiles = (host) => {
  host.textContent = '';
  for (const d of cfgState.dnsPresets) {
    const label = document.createElement('label');
    label.className = 'cfg-tile';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'dns-preset';
    input.value = d.id;
    input.checked = d.id === cfgState.dnsDefault;
    if (input.checked) {
      cfgState.selectedDns = d.id;
      label.classList.add('cfg-tile--active');
    }

    input.addEventListener('change', () => {
      cfgState.selectedDns = d.id;
      host.querySelectorAll('.cfg-tile').forEach((tile) => updateTileActiveClass(tile));
      updateParamChips();
    });

    label.appendChild(input);
    label.appendChild(buildTileText(d.label));
    host.appendChild(label);
  }
};

/** Название плитки и подпись в скобках («Cloudflare (по умолчанию)») — двумя строками. */
const buildTileText = (fullLabel, sub = '') => {
  const match = /^(.*?)\s*\((.+)\)\s*$/.exec(fullLabel);
  const text = document.createElement('span');
  text.className = 'cfg-tile__text';
  const name = document.createElement('span');
  name.className = 'cfg-tile__name';
  name.textContent = match ? match[1] : fullLabel;
  text.appendChild(name);
  const subText = sub || (match ? match[2] : '');
  if (subText) {
    const subEl = document.createElement('span');
    subEl.className = 'cfg-tile__sub';
    subEl.textContent = subText;
    text.appendChild(subEl);
  }
  return text;
};

const renderRouteTiles = (host, presetList) => {
  if (!host) return;
  host.textContent = '';
  for (const p of presetList) {
    const label = document.createElement('label');
    label.className = 'cfg-tile cfg-tile--route';
    label.title = `${p.label} (${p.sitesCount ?? '?'}${t('tile_domains_suffix', ' доменов в запросе')})`;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = p.id;
    input.addEventListener('change', () => {
      updateTileActiveClass(label);
      refreshPresetStats();
      updateParamChips();
      // Keep "presets ignored" notice in sync when user toggles tiles
      const ignoredNotice = document.getElementById('presetsIgnoredNotice');
      if (ignoredNotice) {
        ignoredNotice.hidden = !(cfgState.routeMode === ROUTE_MODES.FULL && getSelectedRouteIds().length > 0);
      }
    });

    const mark = document.createElement('span');
    mark.className = 'cfg-tile__mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = Array.from(p.label.replace(/[^\p{L}\p{N}]/gu, ''))[0] || '•';

    label.appendChild(input);
    label.appendChild(mark);
    label.appendChild(buildTileText(p.label));
    host.appendChild(label);
  }
};

const initSettingsPanel = async () => {
  const dnsHost = document.getElementById('dnsTiles');
  const toggleBtn = document.getElementById('settingsToggle');
  const settingsModal = document.getElementById('settingsModal');

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => openSettingsModal({ opener: toggleBtn }));
  }
  document.querySelectorAll('[data-settings-tab]').forEach((chip) => {
    chip.addEventListener('click', () => openSettingsModal({
      tab: chip.dataset.settingsTab,
      focusId: chip.dataset.settingsFocus || null,
      opener: chip,
    }));
  });
  if (settingsModal) {
    settingsModal.addEventListener('modal:close', () => {
      if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
      updateParamChips();
    });
    // Любая правка внутри настроек сразу видна на чипах шага 2 (обработчики ниже меняют cfgState
    // синхронно, а этот слушатель на всплытии срабатывает после них).
    settingsModal.addEventListener('change', updateParamChips);
    settingsModal.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) updateParamChips();
    });
  }

  try {
    const { source, data } = await fetchPresetsManifest();
    cfgState.iplistSource = source;

    cfgState.presets = data.presets || [];
    cfgState.groupRfPopular = data.groupRfPopular || [];
    cfgState.dnsPresets = data.dnsPresets || [];
    cfgState.dnsDefault = data.dnsDefault || 'cloudflare';

    if (dnsHost) renderDnsTiles(dnsHost);

    ROUTE_CATEGORY_ORDER.forEach((cat) => {
      const host = document.getElementById(ROUTE_CONTAINER_BY_CATEGORY[cat]);
      const list = cfgState.presets.filter((p) => p.category === cat);
      renderRouteTiles(host, list);
    });
    applyZeroCidrMarks();

    const btnRf = document.getElementById('presetRfPopular');
    const btnClear = document.getElementById('presetClear');

    // Route mode toggle (2.6.0)
    document.getElementById('routeModeFull')
      ?.addEventListener('click', () => updateRouteModeUI(ROUTE_MODES.FULL));
    document.getElementById('routeModeSplit')
      ?.addEventListener('click', () => updateRouteModeUI(ROUTE_MODES.SPLIT));

    const ipv6Toggle = document.getElementById('ipv6Toggle');
    if (ipv6Toggle) {
      ipv6Toggle.checked = cfgState.includeIpv6;
      ipv6Toggle.addEventListener('change', () => {
        cfgState.includeIpv6 = ipv6Toggle.checked;
        refreshPresetStats();
      });
    }

    const ignoreLimitToggle = document.getElementById('ignoreLimitToggle');
    if (ignoreLimitToggle) {
      ignoreLimitToggle.checked = cfgState.ignoreLimit;
      ignoreLimitToggle.addEventListener('change', () => {
        cfgState.ignoreLimit = ignoreLimitToggle.checked;
        updateCidrCounter(cfgState.cidrCount4);
        updateTileDisabledState();
        updateAllowedIpsExplanation();
      });
    }

    const routerModeToggle = document.getElementById('routerModeToggle');
    if (routerModeToggle) {
      routerModeToggle.checked = cfgState.routerMode;
      routerModeToggle.addEventListener('change', () => {
        cfgState.routerMode = routerModeToggle.checked;
      });
    }

    const cps5Toggle = document.getElementById('cps5Toggle');
    if (cps5Toggle) {
      cps5Toggle.checked = cfgState.extraCps;
      cps5Toggle.addEventListener('change', () => {
        cfgState.extraCps = cps5Toggle.checked;
      });
    }

    const mobileModeToggle = document.getElementById('mobileModeToggle');
    if (mobileModeToggle) {
      mobileModeToggle.checked = cfgState.mobileMode;
      mobileModeToggle.addEventListener('change', () => {
        cfgState.mobileMode = mobileModeToggle.checked;
        applyMobileModeCascade();
        updateAllowedIpsExplanation();
      });
    }

    const warpPortSelect = document.getElementById('warpPortSelect');
    if (warpPortSelect) {
      warpPortSelect.value = String(cfgState.port);
      warpPortSelect.addEventListener('change', () => {
        const n = Number.parseInt(warpPortSelect.value, 10);
        if (n > 0) { cfgState.warpPort = n; cfgState.port = n; }
      });
    }

    const warpEndpointSelect = document.getElementById('warpEndpointSelect');
    if (warpEndpointSelect) {
      warpEndpointSelect.value = cfgState.warpEndpoint;
      warpEndpointSelect.addEventListener('change', () => {
        cfgState.warpEndpoint = warpEndpointSelect.value;
      });
    }

    document.querySelectorAll('[name="cpsProtocol"]').forEach((radio) => {
      radio.addEventListener('change', (e) => {
        cfgState.cpsProtocol = e.target.value;
      });
    });

    document.querySelectorAll('[name="configCount"]').forEach((radio) => {
      radio.addEventListener('change', (e) => {
        cfgState.configCount = Number.parseInt(e.target.value, 10) || 1;
      });
    });

    const settingsResetBtn = document.getElementById('settingsModalReset');
    if (settingsResetBtn) {
      settingsResetBtn.addEventListener('click', () => {
        // Reset toggles
        cfgState.includeIpv6 = false;
        cfgState.ignoreLimit = false;
        cfgState.routerMode = false;
        cfgState.cpsProtocol = 'auto';
        cfgState.warpPort = 4500;
        cfgState.port = 4500;
        cfgState.warpEndpoint = 'hostname';
        cfgState.extraCps = false;
        cfgState.mobileMode = false;
        cfgState.configCount = 1;
        const countRadio1 = document.querySelector('[name="configCount"][value="1"]');
        if (countRadio1) countRadio1.checked = true;
        if (ipv6Toggle) ipv6Toggle.checked = false;
        if (ignoreLimitToggle) ignoreLimitToggle.checked = false;
        if (routerModeToggle) routerModeToggle.checked = false;
        const autoRadio = document.querySelector('[name="cpsProtocol"][value="auto"]');
        if (autoRadio) autoRadio.checked = true;
        if (warpPortSelect) warpPortSelect.value = '4500';
        if (warpEndpointSelect) warpEndpointSelect.value = 'hostname';
        const cps5ToggleReset = document.getElementById('cps5Toggle');
        if (cps5ToggleReset) cps5ToggleReset.checked = false;
        const mobileToggleReset = document.getElementById('mobileModeToggle');
        if (mobileToggleReset) mobileToggleReset.checked = false;
        applyMobileModeCascade();
        // Clear route presets
        forEachRouteTile((tile) => {
          const cb = tile.querySelector('input[type="checkbox"]');
          if (cb) { cb.checked = false; cb.disabled = false; tile.classList.remove('cfg-tile--disabled'); updateTileActiveClass(tile); }
        });
        // Reset DNS to default
        const firstDns = document.querySelector('[name="dns-preset"]');
        if (firstDns) { firstDns.checked = true; cfgState.selectedDns = firstDns.value; document.querySelectorAll('.cfg-tile').forEach((tile) => updateTileActiveClass(tile)); }
        cfgState.cidrCount4 = 0;
        updateCidrCounter(0);
        updateTileDisabledState();
        refreshPresetStats();
      });
    }

    if (btnRf) {
      btnRf.addEventListener('click', () => {
        const want = new Set(cfgState.groupRfPopular);
        forEachRouteTile((tile) => {
          const cb = tile.querySelector('input[type="checkbox"]');
          if (cb) {
            // Only check tiles that are not disabled (limit guard)
            if (!cb.disabled || want.has(cb.value)) {
              cb.checked = want.has(cb.value);
              updateTileActiveClass(tile);
            }
          }
        });
        refreshPresetStats();
      });
    }

    if (btnClear) {
      btnClear.addEventListener('click', () => {
        forEachRouteTile((tile) => {
          const cb = tile.querySelector('input[type="checkbox"]');
          if (cb) {
            cb.checked = false;
            cb.disabled = false;
            tile.classList.remove('cfg-tile--disabled');
            updateTileActiveClass(tile);
          }
        });
        cfgState.cidrCount4 = 0;
        updateCidrCounter(0);
        updateTileDisabledState();
        refreshPresetStats();
      });
    }

    // Initialize route mode UI (2.6.0)
    updateRouteModeUI(cfgState.routeMode);
    updateAllowedIpsExplanation();
    updateParamChips();

    refreshPresetStats();
  } catch (e) {
    const statsEl = document.getElementById('presetStats');
    clearAllRouteTileHosts();
    if (statsEl) {
      statsEl.classList.add('preset-stats--warn');
      statsEl.textContent = t('preset_load_fail_prefix', 'Не удалось загрузить пресеты: ') + (e.message || e);
    }
  }
};

// ─────────────────────────────────────────────────────────────
// История генераций (localStorage)
// ─────────────────────────────────────────────────────────────

const HISTORY_KEY = 'awg_history';
const HISTORY_MAX = 20;

const loadHistory = () => {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
};

const saveToHistory = (mode, decodedConfig, filename, snapshot = getResultStateSnapshot()) => {
  const entry = {
    ts: Date.now(),
    mode,
    presets: getSelectedRouteIds(),
    dns: getSelectedDnsKey(),
    b64: btoa(decodedConfig),
    filename,
    routeMode: snapshot.routeMode,
    port: snapshot.port,
    endpoint: snapshot.warpEndpoint === 'hostname' ? 'auto' : 'ip',
    mobile: snapshot.mobileMode,
    router: snapshot.routerMode,
  };
  try {
    const arr = loadHistory();
    arr.unshift(entry);
    if (arr.length > HISTORY_MAX) arr.length = HISTORY_MAX;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(arr));
  } catch { /* quota exceeded or private mode */ }
  renderHistoryPanel();
};

const formatHistoryTime = (ts) => {
  const d = new Date(ts);
  const locale = _i18n.locale === 'en' ? 'en-GB' : 'ru-RU';
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  if (days === 0) return `${t('history_today', 'сегодня')}, ${time}`;
  if (days === 1) return `${t('history_yesterday', 'вчера')}, ${time}`;
  return d.toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

/** Заголовок записи истории: режим маршрутов и DNS. Старые записи без routeMode — по пресетам. */
const historyTitle = (entry) => {
  const presets = entry.presets || [];
  const split = entry.routeMode ? entry.routeMode === ROUTE_MODES.SPLIT : presets.length > 0;
  if (split) return t('history_title_split', 'Выборочная · {n} presets').replace('{n}', String(presets.length));
  return `${t('routing_mode_full', 'Полный туннель')} · ${getDnsLabel(entry.dns || 'cloudflare')} DNS`;
};

const historyMeta = (entry) => {
  const parts = [formatHistoryTime(entry.ts)];
  if (entry.endpoint) parts.push(`endpoint ${entry.endpoint === 'ip' ? 'IP' : 'auto'}`);
  if (entry.port && Number(entry.port) !== 4500) parts.push(`port ${entry.port}`);
  if (entry.mobile || entry.router) parts.push(getDeviceLabel(!!entry.mobile, !!entry.router));
  return parts.join(' · ');
};

const makeIconButton = (icon, label, onClick) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn--icon btn--sm';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.appendChild(makeIcon(icon, 'icon icon--sm'));
  btn.addEventListener('click', onClick);
  return btn;
};

const renderHistoryPanel = () => {
  const list = document.getElementById('historyList');
  const countEl = document.getElementById('historyCount');
  const emptyMsg = document.getElementById('historyEmptyMsg');
  const clearBtn = document.getElementById('historyClearBtn');
  const arr = loadHistory();

  if (countEl) countEl.textContent = arr.length > 0 ? String(arr.length) : '';
  if (clearBtn) clearBtn.hidden = arr.length === 0;

  if (!list) return;
  list.textContent = '';

  if (!arr.length) {
    if (emptyMsg) emptyMsg.hidden = false;
    return;
  }
  if (emptyMsg) emptyMsg.hidden = true;

  arr.forEach((entry) => {
    const item = document.createElement('div');
    item.className = 'history-item';

    const badge = document.createElement('span');
    badge.className = getModeBadgeClass(entry.mode);
    badge.textContent = getModeLabel(entry.mode);

    const info = document.createElement('div');
    info.className = 'history-item__info';
    const title = document.createElement('div');
    title.className = 'history-item__title';
    title.textContent = historyTitle(entry);
    title.title = entry.presets && entry.presets.length ? entry.presets.join(', ') : title.textContent;
    const meta = document.createElement('div');
    meta.className = 'history-item__meta';
    meta.textContent = historyMeta(entry);
    info.append(title, meta);

    const telemetryContext = {
      mode: entry.mode,
      route_mode: entry.presets && entry.presets.length ? 'split' : 'full',
    };
    const actions = document.createElement('div');
    actions.className = 'history-item__actions';
    const previewBtn = makeIconButton('i-eye', t('preview_btn_title', 'Просмотреть конфигурацию'), (ev) => {
      openPreviewModal(atob(entry.b64), entry.filename, ev.currentTarget);
      telemetry.trackEvent('history_item_previewed', telemetryContext);
    });
    const dlBtn = makeIconButton('i-download', `${t('history_download_label', 'Скачать')} ${entry.filename}`, () => {
      downloadFile(atob(entry.b64), entry.filename);
      telemetry.trackEvent('history_item_downloaded', telemetryContext);
    });
    actions.append(previewBtn, dlBtn);

    item.append(badge, info, actions);
    list.appendChild(item);
  });
};

const downloadFile = (content, filename) => {
  // application/octet-stream avoids mobile browsers appending .txt to .conf (text/plain triggers that).
  const blob = new Blob([content], { type: 'application/octet-stream' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
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
  if (PROFILE_MODES.includes(saved)) {
    const input = document.querySelector(`[name="awgProfile"][value="${saved}"]`);
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
      throw new Error(data.message || `${t('err_http_prefix', 'Ошибка HTTP:')} ${response.status}`);
    }

    if (!data.success) {
      throw new Error(data.message || t('err_unknown_gen', 'Неизвестная ошибка при генерации конфигурации.'));
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
    lastCompatibility = data.compatibility || null;
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
    showResultError(message);
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

  // ── Статус сервисов: карточка в hero и модал ──
  telemetry.trackEvent('healthcheck_opened');
  initHeroStatus();
  fetchServiceStatus();
  const statusModalBtn = document.getElementById('statusModalBtn');
  if (statusModalBtn) statusModalBtn.addEventListener('click', () => openStatusModal(statusModalBtn));
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
      toast(await copyText(previewConfigText) ? t('btn_copied', 'Скопировано!') : t('copy_failed', 'Не удалось скопировать.'));
    });
  }

  // ── «Какой профиль выбрать?» ──
  const infoLink = document.getElementById('infoLink');
  if (infoLink) infoLink.addEventListener('click', () => openModal('modal', infoLink));
});
