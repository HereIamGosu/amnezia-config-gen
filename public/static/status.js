// public/static/status.js
//
// Статус сервисов: баннер о проблемах WARP-endpoint (/api/status), карточка «Статус системы» в hero
// и модал статуса. Один поллер window.LiveStatus на страницу кормит и карточку, и модал; строка
// «Endpoint Lab» в карточке — отдельный опрос /api/lab (window.LabData, public/lab/lab-data.js).
//
// Классический скрипт (defer), не модуль: верхнеуровневые const/let/функции всех скриптов генератора
// живут в одной глобальной лексической области. Порядок загрузки — в public/index.html:
// i18n.js → common.js → status.js → result.js → settings.js → settings-link.js → history.js →
// script.js. При загрузке файл вызывает только своё и уже загруженное;
// остальное — из обработчиков после DOMContentLoaded. /* global */ — что файл берёт у других,
// /* exported */ — что отдаёт им (проверяют ESLint и __tests__/frontend-scripts.test.js).

/* global t, setI18nText -- i18n.js */
/* global makeIcon, openModal, telemetry -- common.js */
/* global endpointDefault, syncDefaultEndpoint -- settings.js */
/* exported fetchServiceStatus, renderHeroStatus, initHeroStatus, refreshHeroStatus, openStatusModal, renderLabAutoNote */

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

// Те же названия и состояния, что в карточке hero: модал — её подробный вид.
const getLiveStatusLabels = () => {
  const base = window.LiveStatus.DEFAULT_LABELS;
  return {
    ...base,
    names: {
      ...base.names,
      generator: t('status_row_generator', base.names.generator),
      warp_api: t('status_row_warp_api', base.names.warp_api),
      warp_engage: t('status_row_engage', base.names.warp_engage),
      cidr_source: t('status_row_cidr', base.names.cidr_source),
      endpoint_pool: t('status_pool_name', base.names.endpoint_pool),
    },
    generatorDetail: t('status_generator_detail', base.generatorDetail),
    stateText: {
      ok:       t('status_state_ok',       base.stateText.ok),
      degraded: t('status_state_degraded', base.stateText.degraded),
      error:    t('status_state_error',    base.stateText.error),
      unknown:  t('status_state_unknown',  base.stateText.unknown),
    },
    latency:      t('status_latency',      base.latency),
    unreachable:  t('status_unreachable',  base.unreachable),
    poolDetail:   t('status_pool_detail',  base.poolDetail),
    poolUnmeasured: t('status_pool_unmeasured', base.poolUnmeasured),
    labOpen:      t('status_lab_open',     base.labOpen),
  };
};

const labPageHref = () => (document.documentElement.lang === 'en' ? '/en/lab' : '/lab');

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
  content.innerHTML = window.LiveStatus.renderCardsHtml(snapshot, getLiveStatusLabels(), { labHref: labPageHref() });
  renderStatusModalLab();
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

  // Строка Endpoint Lab постоянна (своя кнопка и свой опрос): перерисовываются только строки /api/status
  // перед ней, иначе кнопка в фокусе теряла бы его при каждом ответе.
  const labRow = document.getElementById('statusLabRow');
  list.querySelectorAll('.status-row:not(.status-row--lab)').forEach((li) => li.remove());
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
    list.insertBefore(li, labRow);
  });
  renderHeroLab();

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

// ── Строка «Endpoint Lab» в карточке ──
// Свой опрос /api/lab общим адаптером LabData (30 с, пауза в скрытой вкладке, Retry-After); клик открывает
// быстрый просмотр (lab-quick.js, атрибут data-lab-quick). Генератор берёт адреса из Lab только в режиме
// «Endpoint Lab — авто», который посетитель выбирает сам; по умолчанию — hostname Cloudflare. Поэтому строка
// не входит в общий статус карточки и в предупреждение над шагами, а состояние Lab для этого режима
// показывает пояснение под выбором endpoint в настройках (renderLabAutoNote).
// Опрос начинается, только когда /api/status подтвердил файлы Lab на этом развёртывании (lab.available):
// без них /api/lab отвечает 503, а браузер пишет каждый ответ 5xx в консоль.

let labPoller = null;
/** Последний результат LabData ({ kind, view }); null — первый ответ ещё не пришёл. */
let heroLab = null;

const LAB_ROW_ICONS = { ok: 'i-check', degraded: 'i-alert', unknown: 'i-help' };

/** Состояние Lab для строки карточки и модала: тон иконки, значение справа и подпись. */
const heroLabView = () => {
  const Core = window.LabCore;
  const now = Date.now();
  const s = Core ? Core.statusSummary(heroLab, now) : { state: 'unavailable', tone: 'unknown', active: null, at: null };
  const active = s.active === null ? '' : t('status_lab_active', '{n} ACTIVE').replace('{n}', String(s.active));
  const ago = s.at === null ? '' : Core.formatAgo(now - s.at, t);
  const [value, detail] = {
    loading: ['', ''],
    ok: [active, ago],
    degraded: [t('status_lab_limited', 'Ограничен'), active],
    stale: [t('status_lab_stale', 'Данные устарели'), ago],
    empty: [t('status_lab_empty', 'Нет ACTIVE'), ago],
    unavailable: [t('status_lab_unavailable', 'Недоступен'), ''],
  }[s.state];
  // Lab Auto создаёт конфиг, только когда у Lab есть свежие ACTIVE-адреса: ok и degraded
  return { tone: s.tone, value, detail, state: s.state, ready: s.state === 'ok' || s.state === 'degraded' };
};

const paintLabState = (icon, state, view) => {
  icon.className = `state-icon state-icon--${view.tone}`;
  icon.textContent = '';
  if (view.tone !== 'loading') icon.appendChild(makeIcon(LAB_ROW_ICONS[view.tone]));
  state.className = `status-row__state status-row__state--${view.tone}`;
  state.textContent = view.value;
};

/** Строка Endpoint Lab в модале: меняются только тексты, ссылка «Открыть Lab» не теряет фокус. */
const renderStatusModalLab = () => {
  const icon = document.getElementById('statusModalLabIcon');
  const state = document.getElementById('statusModalLabState');
  const meta = document.getElementById('statusModalLabMeta');
  if (!icon || !state || !meta) return;
  const view = heroLabView();
  paintLabState(icon, state, view);
  meta.textContent = view.detail ? `${view.detail} · ` : '';
};

const renderHeroLab = () => {
  const icon = document.getElementById('statusLabIcon');
  const state = document.getElementById('statusLabState');
  const sub = document.getElementById('statusLabSub');
  if (!icon || !state || !sub) return;
  const view = heroLabView();
  paintLabState(icon, state, view);
  sub.textContent = view.detail;
  sub.hidden = !view.detail;
  renderStatusModalLab();
  // Endpoint по умолчанию следует за Lab: свежий пул — Endpoint Lab, иначе hostname (если посетитель не выбрал сам)
  if (typeof syncDefaultEndpoint === 'function') syncDefaultEndpoint(view.ready);
  renderLabAutoNote();
};

// ── Пояснение к «Endpoint Lab — авто» в настройках ──
// Видно, только когда выбран этот endpoint. Состояние — то же, что у строки Lab в карточке, без чисел
// (подробности — на /lab). Решает всё равно сервер: без свежих данных Lab он отвечает ошибкой, не hostname.

const LAB_AUTO_STATES = {
  loading: ['labauto_state_loading', 'проверяем…'],
  ok: ['labauto_state_ok', 'есть свежие проверенные endpoint\'ы'],
  degraded: ['labauto_state_degraded', 'работает с ограничениями, свежие endpoint\'ы есть'],
  stale: ['labauto_state_stale', 'данные устарели — генерация сейчас вернёт ошибку'],
  empty: ['labauto_state_empty', 'нет свежих endpoint\'ов — генерация сейчас вернёт ошибку'],
  unavailable: ['labauto_state_unavailable', 'недоступен — генерация сейчас вернёт ошибку'],
};

const renderLabAutoNote = () => {
  const note = document.getElementById('labAutoNote');
  const select = document.getElementById('warpEndpointSelect');
  if (!note || !select) return;
  const Core = window.LabCore;
  const s = Core ? Core.statusSummary(heroLab, Date.now()) : { state: 'unavailable', tone: 'unknown' };
  const active = select.value === 'lab';
  // hostname выбран умолчанием, потому что у подключённого Lab сейчас нет свежих адресов: говорим почему.
  // На развёртывании без Lab (форк, Vercel) пояснения нет — там hostname и есть единственный вариант.
  const fallback = !active && select.value === 'hostname' && !endpointDefault.explicit
    && heroLab !== null && heroLab.kind !== 'not-connected' && ['stale', 'empty', 'unavailable'].includes(s.state);
  note.hidden = !active && !fallback;
  note.classList.toggle('lab-auto-note--fallback', fallback);
  if (!note.hidden) select.setAttribute('aria-describedby', 'labAutoNote');
  else select.removeAttribute('aria-describedby');
  const stateEl = document.getElementById('labAutoState');
  if (note.hidden || !stateEl) return;
  const [key, text] = fallback
    ? ['labauto_state_fallback', 'нет свежих проверенных адресов — поэтому выбран hostname']
    : LAB_AUTO_STATES[s.state] || LAB_AUTO_STATES.unavailable;
  stateEl.className = `lab-auto-note__state lab-auto-note__state--${s.tone}`;
  setI18nText(stateEl, key, text);
};

const startLabPoller = () => {
  if (!window.LabData || !window.LabCore) {
    heroLab = { kind: 'error' };
    renderHeroLab();
    return;
  }
  const source = window.LabData.createLabSource({ fetchImpl: window.fetch.bind(window) });
  labPoller = window.LabData.createPoller({
    load: source.loadOverview,
    // Разовый сбой запроса не прячет последние данные: их возраст растёт, и через несколько минут
    // statusSummary сам покажет «Данные устарели». «Недоступен» — пока хороших данных не было.
    onResult: (result) => {
      if (result.kind === 'ok' || !heroLab || heroLab.kind !== 'ok') heroLab = result;
      renderHeroLab();
    },
    doc: document,
  });
  labPoller.start();
};

/**
 * available — lab.available из /api/status: true — опрашиваем /api/lab; false или неизвестно — без запросов:
 * строка «Недоступен», быстрый просмотр (data-lab-quick="off") сразу говорит, что Lab не подключён.
 */
const syncHeroLab = (available) => {
  const btn = document.getElementById('statusLabBtn');
  if (btn) btn.dataset.labQuick = available === true ? '' : 'off';
  if (available === true) {
    if (!labPoller) startLabPoller();
    return;
  }
  if (labPoller) labPoller.stop();
  labPoller = null;
  heroLab = { kind: 'not-connected' };
  renderHeroLab();
};

const initHeroStatus = () => {
  // Только подпись «… назад» у строки Lab — без сетевых запросов.
  setInterval(renderHeroLab, 5_000);
  if (!window.LiveStatus) {
    heroStatus = { kind: 'error', error: new Error('live-status.js not loaded'), at: Date.now() };
    renderHeroStatus();
    renderStatusModalError(heroStatus.error);
    syncHeroLab(null);
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
      syncHeroLab(snapshot.lab.available);
      renderHeroStatus();
      renderStatusModal(snapshot);
    },
    onError: (error, meta) => {
      heroStatus = { kind: 'error', error, at: Date.now() };
      // Сбой /api/status не останавливает уже идущий опрос Lab; до первого ответа — без запросов к Lab.
      if (!labPoller) syncHeroLab(null);
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
  if (labPoller) labPoller.refresh();
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
