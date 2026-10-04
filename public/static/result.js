// public/static/result.js
//
// Панель результата генерации: загрузка → успех / ошибка без прыжков высоты, варианты, вкладки
// .conf / vpn://, быстрая сводка, действия (скачать, копировать, превью), подписи профилей AWG,
// подробное объяснение результата (resultInfoModal) и карточка совместимости клиентов.
//
// Классический скрипт (defer), не модуль: верхнеуровневые const/let/функции всех скриптов генератора
// живут в одной глобальной лексической области. Порядок загрузки — в public/index.html:
// i18n.js → common.js → status.js → result.js → settings.js → settings-link.js → history.js →
// script.js. При загрузке файл вызывает только своё и уже загруженное;
// остальное — из обработчиков после DOMContentLoaded. /* global */ — что файл берёт у других,
// /* exported */ — что отдаёт им (проверяют ESLint и __tests__/frontend-scripts.test.js).

/* global t, setI18nText -- i18n.js */
/* global
   makeIcon, renderVpnLinkHtml, renderConfigHtml, uiShell, downloadFile, telemetry, toast, copyText,
   openPreviewModal, openModal -- common.js */
/* global cfgState, ROUTE_MODES -- settings.js */
/* exported
   resultExplanation, lastResultSummary, lastCompatibility, currentResult, showResultLoading, showResultError,
   getDeviceLabel, getDnsLabel, renderResultSuccess, showResult, initResultPanel, getModeLabel, getModeFilename,
   getModeLoadingLabel, getModeSuccessLabel, getModeBadgeClass, renderResultExplanation, renderCompatibilityCard */

const resultExplanation = window.ResultExplanation || null;
let lastResultSummary = null;
let lastCompatibility = null;

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

/** Высота последнего показанного результата при данной ширине окна — резерв для загрузки и ошибки. */
let resultHeightMemo = { width: 0, height: 0 };

/**
 * Переключает состояние панели результата без прыжков страницы: загрузка и ошибка держат высоту
 * предыдущего состояния (или последнего результата), поэтому ответ API, пришедший позже клика,
 * не сдвигает блоки ниже панели. Первую загрузку резервирует CSS (--result-reserve).
 */
const showResultView = (view) => {
  const panel = document.getElementById('resultPanel');
  if (!panel) return;
  const prevHeight = panel.hidden ? 0 : panel.offsetHeight;
  panel.hidden = false;
  panel.dataset.view = view;
  document.getElementById('resultLoading').hidden = view !== 'loading';
  document.getElementById('resultError').hidden = view !== 'error';
  document.getElementById('resultSuccess').hidden = view !== 'success';
  if (view === 'success') {
    panel.style.minHeight = '';
    resultHeightMemo = { width: window.innerWidth, height: panel.offsetHeight };
    return;
  }
  const memo = resultHeightMemo.width === window.innerWidth ? resultHeightMemo.height : 0;
  // Ошибка держит высоту только прошлого успешного результата: резерв первой загрузки под полный
  // результат на телефоне — почти экран, и короткое сообщение об ошибке висело бы в пустой карточке.
  const reserve = view === 'error' ? memo : Math.max(prevHeight, memo);
  panel.style.minHeight = reserve ? `${reserve}px` : '';
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
  const showLink = currentResult.tab === 'link' && !!variant.vpnLink;
  if (showLink) {
    code.classList.add('code-block--wrap');
    code.innerHTML = renderVpnLinkHtml(variant.vpnLink);
  } else {
    code.classList.remove('code-block--wrap');
    code.innerHTML = renderConfigHtml(variant.decodedConfig);
  }
  // Обе подписи (result_code_note и result_link_note) всегда в разметке, видна одна: высота панели не меняется
  if (note) note.dataset.active = showLink ? 'link' : 'conf';
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
  const linkReason = hasLink
    ? t('copy_vpn_link_title', 'Скопировать vpn://-ссылку для AmneziaVPN')
    : t('vpn_link_unavailable', 'Для этого профиля ссылка vpn:// недоступна — импортируйте файл .conf.');
  if (copyLinkBtn) {
    copyLinkBtn.setAttribute('aria-disabled', String(!hasLink));
    copyLinkBtn.title = linkReason;
  }
  if (linkTab) {
    linkTab.disabled = !hasLink;
    linkTab.title = hasLink ? '' : linkReason;
  }
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
    if (!variant) return;
    if (!variant.vpnLink) {
      toast(t('vpn_link_unavailable', 'Для этого профиля ссылка vpn:// недоступна — импортируйте файл .conf.'), 'info');
      return;
    }
    if (await copyText(variant.vpnLink)) {
      telemetry.trackEvent('vpn_link_copied', currentResult.telemetryContext);
      toast(t('vpn_link_copied', 'Ссылка скопирована, откройте AmneziaVPN на телефоне.'));
    } else {
      toast(t('vpn_link_copy_failed', 'Не удалось скопировать ссылку.'), 'info');
    }
  });

  document.getElementById('resultCopyCode')?.addEventListener('click', async () => {
    const variant = activeVariant();
    if (!variant) return;
    const text = currentResult.tab === 'link' && variant.vpnLink ? variant.vpnLink : variant.decodedConfig;
    const copied = await copyText(text);
    toast(copied ? t('btn_copied', 'Скопировано!') : t('copy_failed', 'Не удалось скопировать.'), copied ? 'success' : 'info');
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
