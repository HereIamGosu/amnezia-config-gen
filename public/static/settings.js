// public/static/settings.js
//
// Настройки генератора: состояние cfgState, каталог пресетов (/api/iplist с запасным
// presets-fallback.json), плитки маршрутов и DNS, режим маршрутизации, счётчик и лимит IPv4 CIDR
// (MAX_CIDR_LIMIT), каскад мобильного профиля, чипы шага 2 и модал настроек (initSettingsPanel).
//
// Классический скрипт (defer), не модуль: верхнеуровневые const/let/функции всех скриптов генератора
// живут в одной глобальной лексической области. Порядок загрузки — в public/index.html:
// i18n.js → common.js → status.js → result.js → settings.js → settings-link.js → history.js →
// script.js. При загрузке файл вызывает только своё и уже загруженное;
// остальное — из обработчиков после DOMContentLoaded. /* global */ — что файл берёт у других,
// /* exported */ — что отдаёт им (проверяют ESLint и __tests__/frontend-scripts.test.js).

/* global t -- i18n.js */
/* global parseJsonResponse, uiShell, openModal, debounce -- common.js */
/* global getDnsLabel, getDeviceLabel -- result.js */
/* global copySettingsLink, applySharedSettings -- settings-link.js */
/* exported
   ROUTE_MODES, cfgState, forEachRouteTile, getSelectedRouteIds, updateParamChips, applyMobileModeCascade,
   getSelectedDnsKey, getResultStateSnapshot, updateCidrCounter, updateTileActiveClass, initSettingsPanel */

/**
 * Maximum safe number of IPv4 CIDR routes in AllowedIPs.
 * Above this threshold routers and low-memory devices (GL.iNet, Keenetic, MikroTik)
 * may fail to apply the routing table. 500 is a conservative limit that works reliably
 * on all tested platforms. Users are warned at 80 % and blocked at 100 %.
 */
const MAX_CIDR_LIMIT = 1000;

/** Routing mode enum. Always use these constants — never bare string literals. */
const ROUTE_MODES = Object.freeze({ FULL: 'full', SPLIT: 'split' });

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
  const settingsModal = document.getElementById('settingsModal');

  document.querySelectorAll('[data-settings-tab]').forEach((chip) => {
    chip.addEventListener('click', () => openSettingsModal({
      tab: chip.dataset.settingsTab,
      focusId: chip.dataset.settingsFocus || null,
      opener: chip,
    }));
  });
  if (settingsModal) {
    settingsModal.addEventListener('modal:close', updateParamChips);
    // Любая правка внутри настроек сразу видна на чипах шага 2 (обработчики ниже меняют cfgState
    // синхронно, а этот слушатель на всплытии срабатывает после них).
    settingsModal.addEventListener('change', updateParamChips);
    settingsModal.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) updateParamChips();
    });
  }
  document.getElementById('settingsShareLink')?.addEventListener('click', copySettingsLink);

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

    // Ссылка с настройками: применяется, когда каталог маршрутов и DNS уже известен
    applySharedSettings();

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
    // Без каталога маршруты и DNS из ссылки отбрасываются, остальные настройки применяются
    applySharedSettings();
    updateParamChips();
  }
};
