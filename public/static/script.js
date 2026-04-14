// public/static/script.js

const API_WARP_TIMEOUT_MS = 120000;

/**
 * Maximum safe number of IPv4 CIDR routes in AllowedIPs.
 * Above this threshold routers and low-memory devices (GL.iNet, Keenetic, MikroTik)
 * may fail to apply the routing table. 500 is a conservative limit that works reliably
 * on all tested platforms. Users are warned at 80 % and blocked at 100 %.
 */
const MAX_CIDR_LIMIT = 2000;

/**
 * @param {Response} response
 * @returns {Promise<Record<string, unknown>>}
 */
const parseJsonResponse = async (response) => {
  const raw = await response.text();
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    throw new Error('Пустой ответ сервера.');
  }
  const lower = trimmed.slice(0, 64).toLowerCase();
  if (
    trimmed.startsWith('<')
    || lower.includes('<!doctype')
    || lower.includes('<html')
  ) {
    throw new Error(
      'Сервер вернул HTML вместо JSON (нет API). Запустите vercel dev или откройте задеплоенный сайт.',
    );
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error('Ответ не похож на JSON. Проверьте доступность API.');
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
  return params.toString();
};

/** Update the CIDR counter element (#cidrCounter) with the current count. */
const updateCidrCounter = (count4) => {
  const el = document.getElementById('cidrCounter');
  if (!el) return;
  if (cfgState.ignoreLimit) {
    el.textContent = `IPv4 маршруты: ${count4} (лимит отключён)`;
    el.classList.remove('cidr-counter--warn', 'cidr-counter--over');
  } else {
    el.textContent = `IPv4 маршруты: ${count4} / ${MAX_CIDR_LIMIT}`;
    el.classList.toggle('cidr-counter--warn', count4 >= MAX_CIDR_LIMIT * 0.8 && count4 < MAX_CIDR_LIMIT);
    el.classList.toggle('cidr-counter--over', count4 >= MAX_CIDR_LIMIT);
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
    el.textContent = 'Пресеты не выбраны — весь трафик пойдёт через туннель.';
    el.classList.remove('preset-stats--warn');
    updateCidrCounter(0);
    updateTileDisabledState();
    return;
  }

  if (cfgState.iplistSource !== 'api') {
    el.textContent = 'Пресеты выбраны из локального списка. Оценка CIDR и генерация конфига с AllowedIPs по пресетам нуждаются в API — запустите vercel dev или откройте задеплоенный сайт.';
    el.classList.add('preset-stats--warn');
    return;
  }

  if (presetStatsAbort) presetStatsAbort.abort();
  presetStatsAbort = new AbortController();

  el.textContent = 'Загрузка оценки маршрутов…';
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

    const overLimit = !cfgState.ignoreLimit && count4 >= MAX_CIDR_LIMIT;
    if (overLimit) {
      el.classList.add('preset-stats--warn');
      el.textContent = `Достигнут лимит маршрутов (${count4}/${MAX_CIDR_LIMIT} IPv4 CIDR). Некоторые устройства могут работать нестабильно. Рекомендуется отключить часть категорий.`;
    } else {
      el.classList.remove('preset-stats--warn');
      const ipv6Info = cfgState.includeIpv6 && data.count6 ? `, IPv6: +${data.count6}` : '';
      const limitNote = cfgState.ignoreLimit && count4 >= MAX_CIDR_LIMIT ? ' ⚠ лимит превышен' : '';
      el.textContent = `IPv4 маршруты: ${count4}${ipv6Info}${limitNote} (${data.sitesQueried} доменов в запросе).`;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    el.textContent = `Предпросмотр недоступен: ${err.message || err}`;
    el.classList.add('preset-stats--warn');
  }
}, 480);

const updateTileActiveClass = (label) => {
  const input = label.querySelector('input');
  if (!input) return;
  label.classList.toggle('cfg-tile--active', input.checked);
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
    label.title = `${p.label} (${p.sitesCount ?? '?'} доменов в запросе)`;

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
      statsEl.textContent = `Не удалось загрузить пресеты: ${e.message || e}`;
    }
  }
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
 * @param {{ buttonId: string, mode: string, filename: string, readyDownloadText: string, loadingLabel: string, boundGenerateClick: () => void }} options
 */
const generateConfig = async (options) => {
  const { buttonId, mode, filename, readyDownloadText, loadingLabel, boundGenerateClick } = options;
  const button = document.getElementById(buttonId);
  if (!button) return;
  const buttonText = button.querySelector('.button__text');
  const status = document.getElementById('status');

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
      if (!data.content) throw new Error('Отсутствует содержимое конфигурации.');

      const decodedConfig = atob(data.content);
      buttonText.textContent = readyDownloadText;

      const downloadHandler = () => downloadFile(decodedConfig, filename);

      if (boundGenerateClick) button.removeEventListener('click', boundGenerateClick);
      button.addEventListener('click', downloadHandler);

      downloadHandler();
      status.textContent = mode === 'awg2'
        ? 'Конфигурация AmneziaWG 2.0 успешно сгенерирована! Нужен клиент AmneziaVPN 4.8.12.9+ или совместимый AWG 2.0.'
        : 'Конфигурация Legacy успешно сгенерирована!';
    } else {
      throw new Error(data.message || 'Неизвестная ошибка при генерации конфигурации.');
    }
  } catch (error) {
    console.error('Ошибка при генерации конфигурации:', error);
    const message = error && error.name === 'AbortError'
      ? 'Превышено время ожидания ответа. Попробуйте ещё раз.'
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
const downloadSchedulerBat = async (staticPath, downloadName, doneMessage) => {
  const status = document.getElementById('status');
  status.textContent = 'Скачивание bat планировщика...';
  const url = new URL(staticPath, window.location.href);
  try {
    const response = await fetch(url.href);
    if (!response.ok) throw new Error(`Ошибка HTTP: ${response.status}`);
    const text = await response.text();
    downloadFile(text, downloadName);
    status.textContent = doneMessage;
  } catch (error) {
    console.error('Ошибка при скачивании bat:', error);
    status.textContent = 'Не удалось скачать bat. Нужен запуск сайта через хостинг (не file://) или скопируйте файлы из папки public/static репозитория.';
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
    readyDownloadText: 'Скачать AmneziaWarp.conf',
    loadingLabel: 'Генерация конфигурации (Legacy)...',
    boundGenerateClick: () => {},
  };
  legacyOptions.boundGenerateClick = () => generateConfig(legacyOptions);

  const awg2Options = {
    buttonId: 'generateButtonAwg2',
    mode: 'awg2',
    filename: 'AmneziaWarp-AWG2.conf',
    readyDownloadText: 'Скачать AmneziaWarp-AWG2.conf',
    loadingLabel: 'Генерация конфигурации (AmneziaWG 2.0)...',
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
        'Скачан планировщик для 2.0 (AmneziaWarp-AWG2.conf).',
      ),
    );
  } else {
    console.error('Кнопка "schedulerButton20" не найдена.');
  }

  initSettingsPanel();

  const closeButton = document.querySelector('.close-button');
  const minimizeButton = document.querySelector('.minimize-button');

  if (closeButton) {
    closeButton.addEventListener('click', () => window.close());
  }

  if (minimizeButton) {
    minimizeButton.addEventListener('click', () => {
      const windowContent = document.querySelector('.window-content');
      if (!windowContent) return;
      windowContent.style.display = windowContent.style.display === 'none' ? 'flex' : 'none';
    });
  }

  const infoLink = document.getElementById('infoLink');
  const modal = document.getElementById('modal');

  if (infoLink && modal) {
    const closeInfoModal = () => {
      modal.style.display = 'none';
      modal.setAttribute('aria-hidden', 'true');
    };
    const openInfoModal = () => {
      modal.style.display = 'flex';
      modal.setAttribute('aria-hidden', 'false');
    };

    infoLink.addEventListener('click', openInfoModal);
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeInfoModal();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const settingsEl = document.getElementById('settingsModal');
      if (settingsEl && settingsEl.style.display === 'flex') {
        closeSettingsModal();
        return;
      }
      if (modal.style.display === 'flex') closeInfoModal();
    });
  } else {
    console.error('Элементы "infoLink" или "modal" не найдены.');
  }
});
