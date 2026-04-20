// public/static/script.js

// ─────────────────────────────────────────────────────────────
// F-03: Локализация (i18n)
// ─────────────────────────────────────────────────────────────

const _i18n = { locale: 'ru', strings: {} };

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
  } catch {
    // В офлайн-режиме или при 404 оставляем исходный HTML-текст (русский)
  }
  // Обновляем состояние кнопок переключателя
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.classList.toggle('lang-btn--active', btn.dataset.lang === _i18n.locale);
  });
};

/**
 * Инициализирует i18n: определяет язык (localStorage → navigator.language → 'ru').
 * Вызывается один раз при DOMContentLoaded.
 */
const initI18n = () => {
  const saved = localStorage.getItem('lang');
  const nav = (navigator.language || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
  const lang = saved || nav;
  loadLocale(lang);
};

/** Переключает язык и сохраняет выбор в localStorage. */
const switchLang = (lang) => {
  localStorage.setItem('lang', lang);
  loadLocale(lang);
};

// ─────────────────────────────────────────────────────────────
// F-02 / F-05 / F-07: Модальные окна
// ─────────────────────────────────────────────────────────────

/** Открывает любое модальное окно по id. */
const openModal = (id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = 'flex';
  el.setAttribute('aria-hidden', 'false');
};

/** Закрывает любое модальное окно по id. */
const closeModal = (id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = 'none';
  el.setAttribute('aria-hidden', 'true');
};

/**
 * Открывает модальное окно предпросмотра конфига.
 * @param {string} decodedConfig
 */
const openPreviewModal = (decodedConfig) => {
  const textarea = document.getElementById('configPreviewTextModal');
  if (textarea) textarea.value = decodedConfig;
  openModal('configPreviewModal');
};

// ── Статус сервисов ──

const STATUS_SERVICE_LABELS = {
  warp_api:    { name: 'Cloudflare WARP API', url: 'api.cloudflareclient.com' },
  cidr_source: { name: 'Источник CIDR (iplist.opencck.org)', url: 'iplist.opencck.org' },
};
const getStatusText = () => ({
  ok:      t('status_ok',      'ОК'),
  error:   t('status_error',   'ОШИБКА'),
  degraded: t('status_degraded', 'НЕСТАБИЛЬНО'),
  unknown: t('status_unknown', 'НЕИЗВЕСТНО'),
});

const formatMoscowTime = (isoStr) => {
  const d = new Date(isoStr);
  if (isNaN(d)) return isoStr;
  return d.toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }) + t('status_msk_suffix', ' (МСК)');
};

const renderStatusModal = (data) => {
  const content     = document.getElementById('statusModalContent');
  const lastChecked = document.getElementById('statusModalLastChecked');
  if (!content) return;

  if (!data || !data.services) {
    content.className = 'status-error-msg';
    content.textContent = t('status_data_error', 'Некорректный формат данных.');
    return;
  }

  if (data.checked_at === '1970-01-01T00:00:00Z') {
    content.className = 'status-error-msg';
    content.innerHTML = t('status_not_yet', 'Данные мониторинга ещё не собраны.<br>Healthcheck запускается каждые 30&nbsp;мин через GitHub Actions.');
    return;
  }

  const STATUS_TEXT = getStatusText();
  const cidrSourceName = t('status_cidr_name', 'Источник CIDR (iplist.opencck.org)');
  const serviceLabels = {
    warp_api:    { name: STATUS_SERVICE_LABELS.warp_api.name, url: STATUS_SERVICE_LABELS.warp_api.url },
    cidr_source: { name: cidrSourceName, url: STATUS_SERVICE_LABELS.cidr_source.url },
  };
  let html = '<div class="status-card-list">';
  for (const [key, svc] of Object.entries(data.services)) {
    const label  = serviceLabels[key] || STATUS_SERVICE_LABELS[key] || { name: key, url: '' };
    const status = svc.status || 'unknown';
    const code   = svc.http_code != null ? `HTTP ${svc.http_code}` : '—';
    html += `
      <div class="status-card">
        <div class="status-indicator status-indicator--${status}"></div>
        <div class="status-card__info">
          <div class="status-card__name">${label.name}</div>
          <div class="status-card__detail">${label.url} &middot; ${code}</div>
        </div>
        <span class="status-badge badge--${status}">${STATUS_TEXT[status] || status}</span>
      </div>`;
  }
  html += '</div>';

  content.className = '';
  content.innerHTML = html;

  if (lastChecked) {
    lastChecked.hidden = false;
    lastChecked.innerHTML = `<strong>${t('status_last_checked_label', 'Последняя проверка:')}</strong><br>${formatMoscowTime(data.checked_at)}`;
  }
};

/** Открывает модал статуса и загружает данные из /status.json. */
const openStatusModal = () => {
  const content     = document.getElementById('statusModalContent');
  const lastChecked = document.getElementById('statusModalLastChecked');

  if (content) { content.className = 'status-loading-msg'; content.textContent = t('status_loading', 'Загрузка...'); }
  if (lastChecked) lastChecked.hidden = true;

  openModal('statusModal');

  fetch('/status.json')
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(renderStatusModal)
    .catch(() => {
      if (content) { content.className = 'status-error-msg'; content.textContent = t('status_load_fail', 'Не удалось загрузить данные статуса.'); }
    });
};

// ─────────────────────────────────────────────────────────────
// F-02 / F-05: Показ тройки кнопок на месте кнопки генерации
// ─────────────────────────────────────────────────────────────

const POST_GEN_ROW_IDS = {
  generateButton:     'postGenLegacy',
  generateButtonAwg2: 'postGenAwg2',
};

/**
 * Скрывает кнопку генерации и показывает на её месте тройку кнопок:
 * Скачать | QR | Просмотр конфига.
 */
const showPostGenRow = ({ buttonId, readyDownloadText, filename, decodedConfig }) => {
  // Скрываем кнопку генерации
  const genBtn = document.getElementById(buttonId);
  if (genBtn) genBtn.hidden = true;

  // Показываем post-gen row
  const rowId = POST_GEN_ROW_IDS[buttonId];
  if (!rowId) return;
  const row = document.getElementById(rowId);
  if (!row) return;
  row.hidden = false;

  // Кнопка скачать
  const dlBtn = row.querySelector('.post-gen-row__download');
  if (dlBtn) {
    const span = dlBtn.querySelector('.button__text');
    if (span) span.textContent = readyDownloadText;
    dlBtn.onclick = () => downloadFile(decodedConfig, filename);
  }

  // Кнопка просмотра
  const prevBtn = row.querySelector('.post-gen-row__preview');
  if (prevBtn) {
    prevBtn.onclick = () => openPreviewModal(decodedConfig);
  }
};

const API_WARP_TIMEOUT_MS = 120000;

/**
 * Maximum safe number of IPv4 CIDR routes in AllowedIPs.
 * Above this threshold routers and low-memory devices (GL.iNet, Keenetic, MikroTik)
 * may fail to apply the routing table. 500 is a conservative limit that works reliably
 * on all tested platforms. Users are warned at 80 % and blocked at 100 %.
 */
const MAX_CIDR_LIMIT = 1000;

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
  /** CPS protocol for I1 field: auto | quic | dns | stun | tls | sip | static */
  cpsProtocol: 'auto',
  /** Set of preset IDs confirmed to return 0 IPv4 CIDRs from opencck. */
  zeroCidrPresets: new Set(),
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
  return new URL('static/presets-fallback.json', window.location.href).href;
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

const openSettingsModal = () => {
  const settingsModal = document.getElementById('settingsModal');
  const toggleBtn = document.getElementById('settingsToggle');
  if (!settingsModal) return;
  settingsModal.style.display = 'flex';
  settingsModal.setAttribute('aria-hidden', 'false');
  if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
  const closeBtn = document.getElementById('settingsModalClose');
  if (closeBtn) closeBtn.focus();
};

const closeSettingsModal = () => {
  const settingsModal = document.getElementById('settingsModal');
  const toggleBtn = document.getElementById('settingsToggle');
  if (!settingsModal) return;
  settingsModal.style.display = 'none';
  settingsModal.setAttribute('aria-hidden', 'true');
  if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
};

const getSelectedDnsKey = () => cfgState.selectedDns || '';

const buildWarpQueryString = (mode) => {
  const params = new URLSearchParams();
  params.set('mode', mode);
  if (mode === 'legacy') params.set('template', 'warp_amnezia');
  if (mode === 'awg2') params.set('template', 'warp_amnezia_awg2');
  const routeIds = getSelectedRouteIds();
  if (routeIds.length) params.set('presets', routeIds.join(','));
  const dns = getSelectedDnsKey();
  if (dns) params.set('dns', dns);
  if (cfgState.includeIpv6) params.set('ipv6', '1');
  if (cfgState.routerMode) params.set('router', '1');
  params.set('cps', cfgState.cpsProtocol);
  return params.toString();
};

/** Update the CIDR counter element (#cidrCounter) and mini counter (#cidrCounterMini). */
const updateCidrCounter = (count4) => {
  const el = document.getElementById('cidrCounter');
  const mini = document.getElementById('cidrCounterMini');
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

    const isAntifilter = data.cidrSource === 'antifilter';
    const overLimit = !cfgState.ignoreLimit && count4 >= MAX_CIDR_LIMIT;
    if (overLimit) {
      el.classList.add('preset-stats--warn');
      el.textContent = `${t('cidr_routes_prefix', 'IPv4 маршруты:')} ${count4}/${MAX_CIDR_LIMIT} IPv4 CIDR. ${t('preset_over_limit_msg', 'Некоторые устройства могут работать нестабильно. Рекомендуется отключить часть категорий.')}`;
    } else if (isAntifilter) {
      el.classList.add('preset-stats--warn');
      el.textContent = `⚠ iplist.opencck.org недоступен — использован резервный источник antifilter.download (${count4} общих подсетей РФ). Маршруты могут быть неточными.`;
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
      warn.title = 'Нет данных в iplist.opencck.org — маршруты не будут добавлены';
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
    });

    const span = document.createElement('span');
    span.textContent = d.label;

    label.appendChild(input);
    label.appendChild(span);
    host.appendChild(label);
  }
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
    });

    const span = document.createElement('span');
    span.textContent = p.label;

    label.appendChild(input);
    label.appendChild(span);
    host.appendChild(label);
  }
};

const initSettingsPanel = async () => {
  const dnsHost = document.getElementById('dnsTiles');
  const toggleBtn = document.getElementById('settingsToggle');
  const settingsModal = document.getElementById('settingsModal');
  const settingsModalClose = document.getElementById('settingsModalClose');

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const isOpen = settingsModal && settingsModal.style.display === 'flex';
      if (isOpen) closeSettingsModal();
      else openSettingsModal();
    });
  }

  if (settingsModalClose) {
    settingsModalClose.addEventListener('click', () => closeSettingsModal());
  }

  if (settingsModal) {
    settingsModal.addEventListener('click', (ev) => {
      if (ev.target === settingsModal) closeSettingsModal();
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
      });
    }

    const routerModeToggle = document.getElementById('routerModeToggle');
    if (routerModeToggle) {
      routerModeToggle.checked = cfgState.routerMode;
      routerModeToggle.addEventListener('change', () => {
        cfgState.routerMode = routerModeToggle.checked;
      });
    }

    document.querySelectorAll('[name="cpsProtocol"]').forEach((radio) => {
      radio.addEventListener('change', (e) => {
        cfgState.cpsProtocol = e.target.value;
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
        if (ipv6Toggle) ipv6Toggle.checked = false;
        if (ignoreLimitToggle) ignoreLimitToggle.checked = false;
        if (routerModeToggle) routerModeToggle.checked = false;
        const autoRadio = document.querySelector('[name="cpsProtocol"][value="auto"]');
        if (autoRadio) autoRadio.checked = true;
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

const saveToHistory = (mode, decodedConfig, filename) => {
  const entry = {
    ts: Date.now(),
    mode,
    presets: getSelectedRouteIds(),
    dns: getSelectedDnsKey(),
    b64: btoa(decodedConfig),
    filename,
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
  return d.toLocaleString(_i18n.locale === 'en' ? 'en-GB' : 'ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};

const renderHistoryPanel = () => {
  const btn = document.getElementById('historyModalBtn');
  const list = document.getElementById('historyList');
  const countEl = document.getElementById('historyCount');
  const emptyMsg = document.getElementById('historyEmptyMsg');
  const arr = loadHistory();

  // Show/hide the history button
  if (btn) btn.hidden = arr.length === 0;
  if (countEl) countEl.textContent = arr.length > 0 ? String(arr.length) : '';

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

    // Mode badge
    const badge = document.createElement('span');
    badge.className = 'history-item__badge ' +
      (entry.mode === 'awg2' ? 'history-item__badge--awg2' : 'history-item__badge--legacy');
    badge.textContent = entry.mode === 'awg2' ? 'AWG 2.0' : 'AWG 1.5';

    // Info block
    const info = document.createElement('div');
    info.className = 'history-item__info';

    const timeEl = document.createElement('div');
    timeEl.className = 'history-item__time';
    timeEl.textContent = formatHistoryTime(entry.ts);

    const presetsEl = document.createElement('div');
    presetsEl.className = 'history-item__presets';
    const presetSummary = entry.presets && entry.presets.length
      ? entry.presets.slice(0, 4).join(', ') + (entry.presets.length > 4 ? '…' : '')
      : t('history_no_presets', 'без пресетов');
    presetsEl.textContent = presetSummary;
    presetsEl.title = entry.presets ? entry.presets.join(', ') : '';

    info.appendChild(timeEl);
    info.appendChild(presetsEl);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'history-item__actions';

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'button button--sm history-item__dl';
    dlBtn.textContent = t('history_download', '↓');
    dlBtn.title = entry.filename;
    dlBtn.addEventListener('click', () => downloadFile(atob(entry.b64), entry.filename));

    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'button button--sm history-item__preview';
    previewBtn.innerHTML = '<i class="fas fa-eye"></i>';
    previewBtn.title = t('preview_btn_title', 'Просмотреть конфигурацию');
    previewBtn.addEventListener('click', () => openPreviewModal(atob(entry.b64)));

    actions.appendChild(dlBtn);
    actions.appendChild(previewBtn);

    item.appendChild(badge);
    item.appendChild(info);
    item.appendChild(actions);
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

const GENERATE_BUTTON_IDS = ['generateButton', 'generateButtonAwg2'];

const setAllGenerateButtonsDisabled = (disabled) => {
  GENERATE_BUTTON_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
};

/**
 * @param {{ buttonId: string, mode: string, filename: string, boundGenerateClick: () => void }} options
 */
const generateConfig = async (options) => {
  const { buttonId, mode, filename, boundGenerateClick } = options;
  const button = document.getElementById(buttonId);
  if (!button) return;
  const status = document.getElementById('status');

  const loadingLabel = mode === 'awg2'
    ? t('loading_awg2', 'Генерация конфигурации (AmneziaWG 2.0)...')
    : t('loading_legacy', 'Генерация конфигурации (Legacy)...');
  const readyDownloadText = mode === 'awg2'
    ? t('ready_download_awg2', 'Скачать AmneziaWarp-AWG2.conf')
    : t('ready_download_legacy', 'Скачать AmneziaWarp.conf');

  setAllGenerateButtonsDisabled(true);
  button.classList.add('button--loading');
  status.textContent = loadingLabel;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_WARP_TIMEOUT_MS);
    let response;
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
      throw new Error(data.message || `Ошибка HTTP: ${response.status}`);
    }

    if (data.success) {
      if (!data.content) throw new Error(t('err_no_content', 'Отсутствует содержимое конфигурации.'));

      const decodedConfig = atob(data.content);

      if (boundGenerateClick) button.removeEventListener('click', boundGenerateClick);

      // F-02 + F-05: заменяем кнопку на тройку (Скачать | QR | Просмотр)
      showPostGenRow({ buttonId, readyDownloadText, filename, decodedConfig });

      // Автоматически скачиваем файл сразу
      downloadFile(decodedConfig, filename);

      // Сохраняем в историю
      saveToHistory(mode, decodedConfig, filename);

      status.textContent = mode === 'awg2'
        ? t('success_awg2', 'Конфигурация AmneziaWG 2.0 успешно сгенерирована! Нужен клиент AmneziaVPN 4.8.12.9+ или совместимый AWG 2.0.')
        : t('success_legacy', 'Конфигурация Legacy успешно сгенерирована!');
    } else {
      throw new Error(data.message || t('err_unknown_gen', 'Неизвестная ошибка при генерации конфигурации.'));
    }
  } catch (error) {
    console.error('Ошибка при генерации конфигурации:', error);
    const message = error && error.name === 'AbortError'
      ? t('err_timeout', 'Превышено время ожидания ответа. Попробуйте ещё раз.')
      : error.message;
    status.textContent = `Ошибка: ${message}`;
  } finally {
    setAllGenerateButtonsDisabled(false);
    button.classList.remove('button--loading');
  }
};

/**
 * @param {string} staticPath path relative to site root, e.g. static/SchedulerAmnezia-15.bat
 * @param {string} downloadName filename for Save dialog
 * @param {string} doneMessage status text on success
 */
const downloadSchedulerBat = async (staticPath, downloadName, doneMessageKey, doneMessageFb) => {
  const status = document.getElementById('status');
  status.textContent = t('scheduler_downloading', 'Скачивание bat планировщика...');
  const url = new URL(staticPath, window.location.href);
  try {
    const response = await fetch(url.href);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    downloadFile(text, downloadName);
    status.textContent = t(doneMessageKey, doneMessageFb);
  } catch (error) {
    console.error('Ошибка при скачивании bat:', error);
    status.textContent = t('scheduler_fail', 'Не удалось скачать bat. Нужен запуск сайта через хостинг (не file://) или скопируйте файлы из папки public/static репозитория.');
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const generateButton = document.getElementById('generateButton');
  const generateButtonAwg2 = document.getElementById('generateButtonAwg2');
  const schedulerButton15 = document.getElementById('schedulerButton15');
  const schedulerButton20 = document.getElementById('schedulerButton20');

  const legacyOptions = {
    buttonId: 'generateButton',
    mode: 'legacy',
    filename: 'AmneziaWarp.conf',
    boundGenerateClick: () => {},
  };
  legacyOptions.boundGenerateClick = () => generateConfig(legacyOptions);

  const awg2Options = {
    buttonId: 'generateButtonAwg2',
    mode: 'awg2',
    filename: 'AmneziaWarp-AWG2.conf',
    boundGenerateClick: () => {},
  };
  awg2Options.boundGenerateClick = () => generateConfig(awg2Options);

  if (generateButton) {
    generateButton.addEventListener('click', legacyOptions.boundGenerateClick);
  } else {
    console.error('Кнопка "generateButton" не найдена.');
  }

  if (generateButtonAwg2) {
    generateButtonAwg2.addEventListener('click', awg2Options.boundGenerateClick);
  } else {
    console.error('Кнопка "generateButtonAwg2" не найдена.');
  }

  if (schedulerButton15) {
    schedulerButton15.addEventListener('click', () =>
      downloadSchedulerBat(
        'static/SchedulerAmnezia-15.bat',
        'SchedulerAmnezia-15.bat',
        'scheduler_done_15',
        'Скачан планировщик для 1.5 (AmneziaWarp.conf).',
      ),
    );
  } else {
    console.error('Кнопка "schedulerButton15" не найдена.');
  }

  if (schedulerButton20) {
    schedulerButton20.addEventListener('click', () =>
      downloadSchedulerBat(
        'static/SchedulerAmnezia-20.bat',
        'SchedulerAmnezia-20.bat',
        'scheduler_done_20',
        'Скачан планировщик для 2.0 (AmneziaWarp-AWG2.conf).',
      ),
    );
  } else {
    console.error('Кнопка "schedulerButton20" не найдена.');
  }

  // ── История генераций (модальное окно) ──
  const historyModalBtn   = document.getElementById('historyModalBtn');
  const historyModal      = document.getElementById('historyModal');
  const historyModalClose = document.getElementById('historyModalClose');
  const historyClearBtn   = document.getElementById('historyClearBtn');

  const openHistoryModal = () => {
    renderHistoryPanel();
    if (historyModal) {
      historyModal.style.display = 'flex';
      historyModal.setAttribute('aria-hidden', 'false');
    }
  };

  const closeHistoryModal = () => {
    if (historyModal) {
      historyModal.style.display = 'none';
      historyModal.setAttribute('aria-hidden', 'true');
    }
  };

  if (historyModalBtn) historyModalBtn.addEventListener('click', openHistoryModal);
  if (historyModalClose) historyModalClose.addEventListener('click', closeHistoryModal);
  if (historyModal) {
    historyModal.addEventListener('click', (e) => {
      if (e.target === historyModal) closeHistoryModal();
    });
  }
  if (historyClearBtn) {
    historyClearBtn.addEventListener('click', () => {
      try { localStorage.removeItem(HISTORY_KEY); } catch { /* */ }
      renderHistoryPanel();
      closeHistoryModal();
    });
  }
  renderHistoryPanel();

  initSettingsPanel();

  // ── F-03: Локализация ──
  initI18n();
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchLang(btn.dataset.lang));
  });

  // ── F-05: Копировать конфиг (в модале предпросмотра) ──
  const copyConfigBtnModal = document.getElementById('copyConfigBtnModal');
  if (copyConfigBtnModal) {
    copyConfigBtnModal.addEventListener('click', async () => {
      const textarea = document.getElementById('configPreviewTextModal');
      if (!textarea || !textarea.value) return;
      try {
        await navigator.clipboard.writeText(textarea.value);
      } catch {
        textarea.select();
        document.execCommand('copy');
      }
      const origText = copyConfigBtnModal.textContent;
      copyConfigBtnModal.textContent = t('btn_copied', 'Скопировано!');
      setTimeout(() => { copyConfigBtnModal.textContent = origText; }, 2000);
    });
  }

  // ── F-07: Статус сервисов ──
  const statusModalBtn = document.getElementById('statusModalBtn');
  if (statusModalBtn) {
    statusModalBtn.addEventListener('click', openStatusModal);
  }

  // ── Закрытие модалов по клику на затемнённый оверлей ──
  ['configPreviewModal', 'statusModal'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', (ev) => { if (ev.target === el) closeModal(id); });
  });

  // ── Стандартные кнопки окна ──
  const closeButton = document.querySelector('.close-button');
  const minimizeButton = document.querySelector('.minimize-button');
  if (closeButton) closeButton.addEventListener('click', () => window.close());
  if (minimizeButton) {
    minimizeButton.addEventListener('click', () => {
      const windowContent = document.querySelector('.window-content');
      if (!windowContent) return;
      windowContent.style.display = windowContent.style.display === 'none' ? 'flex' : 'none';
    });
  }

  // ── Информационный модал ──
  const infoLink = document.getElementById('infoLink');
  const modal    = document.getElementById('modal');

  if (infoLink && modal) {
    const closeInfoModal = () => { modal.style.display = 'none'; modal.setAttribute('aria-hidden', 'true'); };
    const openInfoModal  = () => { modal.style.display = 'flex'; modal.setAttribute('aria-hidden', 'false'); };

    infoLink.addEventListener('click', openInfoModal);
    modal.addEventListener('click', (ev) => { if (ev.target === modal) closeInfoModal(); });

    // ESC закрывает любой открытый модал
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      const settingsEl = document.getElementById('settingsModal');
      if (settingsEl && settingsEl.style.display === 'flex') { closeSettingsModal(); return; }
      if (historyModal && historyModal.style.display === 'flex') { closeHistoryModal(); return; }
      for (const id of ['configPreviewModal', 'statusModal']) {
        const el = document.getElementById(id);
        if (el && el.style.display === 'flex') { closeModal(id); return; }
      }
      if (modal.style.display === 'flex') closeInfoModal();
    });
  } else {
    console.error('Элементы "infoLink" или "modal" не найдены.');
  }
});
