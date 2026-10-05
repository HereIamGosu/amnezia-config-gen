// public/static/history.js
//
// История генераций в localStorage (awg_history, до 20 записей): сохранение результата и список
// в модале истории с просмотром и повторным скачиванием.
//
// Классический скрипт (defer), не модуль: верхнеуровневые const/let/функции всех скриптов генератора
// живут в одной глобальной лексической области. Порядок загрузки — в public/index.html:
// i18n.js → common.js → status.js → result.js → settings.js → settings-link.js → history.js →
// script.js. При загрузке файл вызывает только своё и уже загруженное;
// остальное — из обработчиков после DOMContentLoaded. /* global */ — что файл берёт у других,
// /* exported */ — что отдаёт им (проверяют ESLint и __tests__/frontend-scripts.test.js).

/* global _i18n, t -- i18n.js */
/* global makeIcon, openPreviewModal, telemetry, downloadFile -- common.js */
/* global getDnsLabel, getDeviceLabel, getModeBadgeClass, getModeLabel -- result.js */
/* global getResultStateSnapshot, getSelectedRouteIds, getSelectedDnsKey, ROUTE_MODES -- settings.js */
/* exported HISTORY_KEY, saveToHistory, renderHistoryPanel */

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
    endpoint: snapshot.warpEndpoint === 'hostname' ? 'auto' : snapshot.warpEndpoint === 'lab' ? 'lab' : 'ip',
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
  if (split) return t('history_title_split', 'Выборочная · направлений: {n}').replace('{n}', String(presets.length));
  return `${t('routing_mode_full', 'Полный туннель')} · ${getDnsLabel(entry.dns || 'cloudflare')} DNS`;
};

const historyMeta = (entry) => {
  const parts = [formatHistoryTime(entry.ts)];
  // Stored value 'auto' is the hostname mode (entries written before Lab Auto use it too).
  if (entry.endpoint) parts.push(`endpoint ${{ ip: 'IP', lab: 'Lab' }[entry.endpoint] || 'hostname'}`);
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
