// public/static/status.js
//
// Статус сервисов: баннер о проблемах WARP-endpoint (/api/status), карточка «Статус системы» в hero
// и модал статуса. Один поллер window.LiveStatus на страницу кормит и карточку, и модал.
//
// Классический скрипт (defer), не модуль: верхнеуровневые const/let/функции всех скриптов генератора
// живут в одной глобальной лексической области. Порядок загрузки — в public/index.html:
// i18n.js → common.js → status.js → result.js → settings.js → settings-link.js → history.js →
// script.js. При загрузке файл вызывает только своё и уже загруженное;
// остальное — из обработчиков после DOMContentLoaded. /* global */ — что файл берёт у других,
// /* exported */ — что отдаёт им (проверяют ESLint и __tests__/frontend-scripts.test.js).

/* global t, setI18nText -- i18n.js */
/* global makeIcon, openModal, telemetry -- common.js */
/* exported fetchServiceStatus, renderHeroStatus, initHeroStatus, refreshHeroStatus, openStatusModal */

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

const renderHeroStatus = () => {
  const list = document.getElementById('statusList');
  if (!list) return;

  // Необязательная строка («Источник CIDR») есть в разметке с самого начала и скрывается, только если
  // сервер её явно не вернул: карточка не растёт после ответа и не сдвигает генератор.
  let rows;
  if (heroStatus.kind === 'data') {
    const byKey = Object.fromEntries(heroStatus.snapshot.services.map((svc) => [svc.key, svc.status]));
    rows = HERO_STATUS_ROWS
      .filter((row) => !row.optional || byKey[row.key])
      .map((row) => ({ ...row, state: row.key === 'generator' ? 'ok' : (byKey[row.key] || 'unknown') }));
  } else if (heroStatus.kind === 'error') {
    const generator = generatorStateForError(heroStatus.error);
    rows = HERO_STATUS_ROWS
      .map((row) => ({ ...row, state: row.key === 'generator' ? generator : 'unknown' }));
  } else {
    rows = HERO_STATUS_ROWS.map((row) => ({ ...row, state: 'loading' }));
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
